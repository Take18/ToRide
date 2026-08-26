import type Database from 'better-sqlite3'
import type { Task, RuntimeTask, ArchiveEntry, RuntimeTaskState, RotationRuntime } from '../../../src/types/task'
import crypto from 'crypto'

export class TaskService {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  list(): RuntimeTask[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.type, t.status, t.title, t.pane, t.data, t.created_at,
                r.pid, r.workdir, r.context_used, r.context_limit, r.started_at, r.completed_at,
                r.rotation_state
         FROM tasks t
         LEFT JOIN task_runtime r ON t.id = r.task_id
         ORDER BY t.created_at ASC`
      )
      .all() as Array<Record<string, unknown>>

    return rows.map((row) => this.rowToRuntimeTask(row))
  }

  create(data: Omit<Task, 'id' | 'created_at'>): RuntimeTask {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()

    const { type, status, title, pane, ...rest } = data
    const taskData = JSON.stringify(rest)

    this.db
      .prepare(
        `INSERT INTO tasks (id, type, status, title, pane, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, type, status || 'will_do', title, pane, taskData, createdAt)

    this.db
      .prepare(`INSERT INTO task_runtime (task_id) VALUES (?)`)
      .run(id)

    return this.getById(id)!
  }

  update(id: string, data: Partial<Task & RuntimeTaskState>): RuntimeTask {
    const existing = this.getById(id)
    if (!existing) {
      throw new Error(`Task not found: ${id}`)
    }

    const {
      pid, workdir, contextUsed, contextLimit, startedAt, completedAt,
      rotationPending, rotationHoldReason, rotationHoldMessage,
      rotationBaseline, rotationDisabledReason,
      ...taskFields
    } = data
    // undefined を渡すこと自体が「クリア」の意味を持つため、値ではなくキーの有無で判定する
    const rotationRuntimePatch: RotationRuntime = {}
    let hasRotationPatch = false
    for (const key of [
      'rotationPending', 'rotationHoldReason', 'rotationHoldMessage',
      'rotationBaseline', 'rotationDisabledReason'
    ] as const) {
      if (key in data) {
        ;(rotationRuntimePatch as Record<string, unknown>)[key] = data[key]
        hasRotationPatch = true
      }
    }
    void rotationPending; void rotationHoldReason; void rotationHoldMessage
    void rotationBaseline; void rotationDisabledReason

    // Update task fields
    if (Object.keys(taskFields).length > 0) {
      const { type, status, title, pane, ...rest } = taskFields as Partial<Task>

      if (type !== undefined) {
        this.db.prepare(`UPDATE tasks SET type = ? WHERE id = ?`).run(type, id)
      }
      if (status !== undefined) {
        this.db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(status, id)
      }
      if (title !== undefined) {
        this.db.prepare(`UPDATE tasks SET title = ? WHERE id = ?`).run(title, id)
      }
      if (pane !== undefined) {
        this.db.prepare(`UPDATE tasks SET pane = ? WHERE id = ?`).run(pane, id)
      }

      // Update JSON data fields
      if (Object.keys(rest).length > 0) {
        const currentData = JSON.parse(
          (this.db.prepare(`SELECT data FROM tasks WHERE id = ?`).get(id) as { data: string }).data
        )
        const merged = { ...currentData, ...rest }
        this.db.prepare(`UPDATE tasks SET data = ? WHERE id = ?`).run(JSON.stringify(merged), id)
      }
    }

    // Auto-set startedAt/completedAt based on status changes
    const status = (data as Partial<Task>).status
    if (status === 'doing' && !existing.startedAt) {
      this.db
        .prepare(`UPDATE task_runtime SET started_at = ? WHERE task_id = ?`)
        .run(new Date().toISOString(), id)
    }
    if (status === 'done' && !existing.completedAt) {
      this.db
        .prepare(`UPDATE task_runtime SET completed_at = ? WHERE task_id = ?`)
        .run(new Date().toISOString(), id)
    }

    // 起動時に task_runtime を全削除するため、既存タスクでは行が存在しないことがある。
    // 行が無いと以降の UPDATE が全て空振りして pid / contextUsed 等が永続化されない
    this.db.prepare(`INSERT OR IGNORE INTO task_runtime (task_id) VALUES (?)`).run(id)

    // Update runtime fields
    if (pid !== undefined) {
      this.db.prepare(`UPDATE task_runtime SET pid = ? WHERE task_id = ?`).run(pid, id)
    }
    if (workdir !== undefined) {
      this.db.prepare(`UPDATE task_runtime SET workdir = ? WHERE task_id = ?`).run(workdir, id)
    }
    if (contextUsed !== undefined) {
      this.db
        .prepare(`UPDATE task_runtime SET context_used = ? WHERE task_id = ?`)
        .run(contextUsed, id)
    }
    if (contextLimit !== undefined) {
      this.db
        .prepare(`UPDATE task_runtime SET context_limit = ? WHERE task_id = ?`)
        .run(contextLimit, id)
    }
    if (startedAt !== undefined) {
      this.db
        .prepare(`UPDATE task_runtime SET started_at = ? WHERE task_id = ?`)
        .run(startedAt, id)
    }
    if (completedAt !== undefined) {
      this.db
        .prepare(`UPDATE task_runtime SET completed_at = ? WHERE task_id = ?`)
        .run(completedAt, id)
    }

    // rotation_state は部分更新（既存 JSON にマージ）。undefined を渡したキーは削除される
    if (hasRotationPatch) {
      const row = this.db
        .prepare(`SELECT rotation_state FROM task_runtime WHERE task_id = ?`)
        .get(id) as { rotation_state: string | null } | undefined
      let current: RotationRuntime = {}
      try {
        current = row?.rotation_state ? (JSON.parse(row.rotation_state) as RotationRuntime) : {}
      } catch {
        current = {}
      }
      const merged: Record<string, unknown> = { ...current, ...rotationRuntimePatch }
      for (const k of Object.keys(merged)) {
        if (merged[k] === undefined) delete merged[k]
      }
      this.db
        .prepare(`UPDATE task_runtime SET rotation_state = ? WHERE task_id = ?`)
        .run(JSON.stringify(merged), id)
    }

    return this.getById(id)!
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id)
  }

  archive(id: string): void {
    const task = this.getById(id)
    if (!task) {
      throw new Error(`Task not found: ${id}`)
    }
    if (task.status !== 'done') {
      throw new Error(`Only completed tasks can be archived`)
    }

    const archivedTask: RuntimeTask = { ...task, isArchived: true }
    this.db
      .prepare(`INSERT INTO task_archive (id, task_data, archived_at) VALUES (?, ?, ?)`)
      .run(id, JSON.stringify(archivedTask), new Date().toISOString())

    this.delete(id)
  }

  listArchived(): ArchiveEntry[] {
    const rows = this.db
      .prepare(`SELECT id, task_data, archived_at FROM task_archive ORDER BY archived_at DESC`)
      .all() as Array<{ id: string; task_data: string; archived_at: string }>

    return rows.map((row) => ({
      id: row.id,
      task_data: JSON.parse(row.task_data) as RuntimeTask,
      archived_at: row.archived_at
    }))
  }

  deleteArchived(id: string): void {
    this.db.prepare(`DELETE FROM task_archive WHERE id = ?`).run(id)
  }

  restoreFromArchive(id: string): RuntimeTask {
    const row = this.db
      .prepare(`SELECT task_data FROM task_archive WHERE id = ?`)
      .get(id) as { task_data: string } | undefined
    if (!row) throw new Error(`Archive not found: ${id}`)

    const task: RuntimeTask = JSON.parse(row.task_data)
    const { id: taskId, type, status: _status, title, pane, created_at,
            pid: _pid, workdir: _workdir, contextUsed: _cu, contextLimit: _cl,
            startedAt, completedAt, isArchived: _ia,
            // ランタイム状態は復元しない（rotation 設定本体は data 側の rotation に残る）
            rotationPending: _rp, rotationHoldReason: _rhr, rotationHoldMessage: _rhm,
            rotationBaseline: _rb, rotationDisabledReason: _rdr,
            ...rest } = task

    const restore = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tasks (id, type, status, title, pane, data, created_at)
           VALUES (?, ?, 'done', ?, ?, ?, ?)`
        )
        .run(taskId, type, title, pane ?? null, JSON.stringify(rest), created_at)
      this.db
        .prepare(
          `INSERT INTO task_runtime (task_id, started_at, completed_at) VALUES (?, ?, ?)`
        )
        .run(taskId, startedAt ?? null, completedAt ?? null)
      this.db.prepare(`DELETE FROM task_archive WHERE id = ?`).run(id)
    })

    restore()
    return this.getById(taskId)!
  }

  archiveAllDone(): number {
    const doneTasks = this.list().filter((t) => t.status === 'done')
    for (const task of doneTasks) {
      this.archive(task.id)
    }
    return doneTasks.length
  }

  deleteAllArchived(): number {
    const result = this.db.prepare(`DELETE FROM task_archive`).run()
    return result.changes
  }

  private getById(id: string): RuntimeTask | null {
    const row = this.db
      .prepare(
        `SELECT t.id, t.type, t.status, t.title, t.pane, t.data, t.created_at,
                r.pid, r.workdir, r.context_used, r.context_limit, r.started_at, r.completed_at,
                r.rotation_state
         FROM tasks t
         LEFT JOIN task_runtime r ON t.id = r.task_id
         WHERE t.id = ?`
      )
      .get(id) as Record<string, unknown> | undefined

    if (!row) return null
    return this.rowToRuntimeTask(row)
  }

  private parseRotationState(raw: string | null | undefined): RotationRuntime {
    if (!raw) return {}
    try {
      return JSON.parse(raw) as RotationRuntime
    } catch {
      return {}
    }
  }

  private rowToRuntimeTask(row: Record<string, unknown>): RuntimeTask {
    const data = JSON.parse(row.data as string)
    return {
      id: row.id as string,
      type: row.type as Task['type'],
      status: row.status as Task['status'],
      title: row.title as string,
      pane: row.pane as string,
      created_at: row.created_at as string,
      ...data,
      pid: row.pid as number | undefined,
      workdir: row.workdir as string | undefined,
      contextUsed: row.context_used as number | undefined,
      contextLimit: row.context_limit as number | undefined,
      startedAt: row.started_at as string | undefined,
      completedAt: row.completed_at as string | undefined,
      ...this.parseRotationState(row.rotation_state as string | null | undefined)
    } as RuntimeTask
  }
}
