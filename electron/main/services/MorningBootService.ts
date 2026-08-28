import type Database from 'better-sqlite3'
import type { AppSettings } from '../../../src/types/ipc'
import type { Task } from '../../../src/types/task'
import type { TaskService } from './TaskService'
import type { StartTaskFn } from '../ipc/claude'

const STATE_KEY = 'morningBootState'
const TICK_INTERVAL_MS = 60_000
const DEFAULT_TIME = '09:00'
const DEFAULT_TITLE = 'オーケストレータ {date}'

// 永続状態。settings（＝人が書く設定）とは別キーに置く。
// task_runtime は起動時に全削除されるため、日付スタンプの置き場としては使えない
type MorningBootState = {
  // 「その日ぶんの判断を済ませた日」。起こした日も、見送った日も、ここに入る
  lastBootedDate?: string
  // 直前のtickで enabled をどう見ていたか。false→true の遷移を検知して初日をスキップする
  enabledSeen?: boolean
}

export type MorningBootDeps = {
  db: Database.Database
  taskService: TaskService
  getSettings: () => AppSettings
  startTask: StartTaskFn
  notifyTasksUpdated: () => void
  // start に失敗したときだけ呼ぶ。ログだけだと「朝が立たなかった」ことに人が気づけない
  notifyStartFailed: (message: string, taskId: string) => void
}

/**
 * 指定時刻に orchestrate タスクを1日1本だけ立てる。
 *
 * 冪等性は2層で担保する:
 *  1. 永続の lastBootedDate（同じ日に二度判断しない。done にされた後の再起動でも立て直さない）
 *  2. 実行時のタスク一覧チェック（人が手で立てていたら作らない）
 *
 * 判定は毎分の tick 1本に集約してあるので、定時発火・スリープ復帰・アプリ起動時の
 * catch-up がすべて同じ式で片づく（「時刻ぴったり」ではなく「1日1本」が要件）。
 */
export class MorningBootService {
  private timerId: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private loggedInvalidTime: string | null = null

  constructor(private deps: MorningBootDeps) {}

  start(): void {
    if (this.timerId) return
    // 起動直後にも1回評価する（マシンがスリープしていて定時を過ぎた場合の catch-up）
    void this.tick()
    this.timerId = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timerId) clearInterval(this.timerId)
    this.timerId = null
  }

  /** 手動実行用（設定画面やデバッグから叩けるように公開しておく） */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.evaluate(now)
    } catch (err) {
      console.error('[morningBoot] tick failed:', err)
    } finally {
      this.ticking = false
    }
  }

  private async evaluate(now: Date): Promise<void> {
    const config = this.deps.getSettings().morningBoot
    const state = this.readState()

    if (!config?.enabled) {
      if (state.enabledSeen) this.writeState({ ...state, enabledSeen: false })
      return
    }

    // 有効化した当日は立てない（設定をいじっただけでセッションが起動するのを避ける）。
    // 判定式を1本に保つため、フラグを増やさず lastBootedDate を今日で埋めて表現する
    if (!state.enabledSeen) {
      const today = localDate(now)
      this.writeState({ lastBootedDate: today, enabledSeen: true })
      console.log(`[morningBoot] enabled - skipping today (${today}); first boot is tomorrow`)
      return
    }

    const today = localDate(now)
    if (state.lastBootedDate === today) return

    const time = config.time?.trim() || DEFAULT_TIME
    const scheduled = parseTime(time)
    if (!scheduled) {
      if (this.loggedInvalidTime !== time) {
        this.loggedInvalidTime = time
        console.error(`[morningBoot] invalid time "${time}" (expected HH:MM) - skipped`)
      }
      return
    }
    this.loggedInvalidTime = null
    if (minutesOfDay(now) < scheduled) return

    // 人が手で立てていたら作らない。スコープは repoId 一致に限定する
    // （全 orchestrate を見ると、別リポジトリのオーケストレータが走っている間ずっと見送られる）
    const existing = this.deps.taskService
      .list()
      .find(
        (t) =>
          t.type === 'orchestrate' &&
          (t.status === 'will_do' || t.status === 'doing') &&
          (t.repoId ?? undefined) === (config.repoId ?? undefined)
      )
    if (existing) {
      this.writeState({ ...state, lastBootedDate: today })
      console.log(
        `[morningBoot] skipped (${today}): orchestrate task already exists - "${existing.title}" (${existing.status})`
      )
      return
    }

    const title = expandDate(config.title?.trim() || DEFAULT_TITLE, today)
    const prompt = config.prompt ? expandDate(config.prompt, today) : undefined
    // bootPrompt は prompt と同じにしたいケースがほとんどなので、省略時は prompt を流用する
    // （rotationDefaults に置くと他のタスクにも効いてしまうため、ここはタスク単位で載せる）
    const rotation = config.rotation
      ? {
          ...config.rotation,
          bootPrompt: config.rotation.bootPrompt
            ? expandDate(config.rotation.bootPrompt, today)
            : prompt,
        }
      : undefined
    const task = this.deps.taskService.create({
      type: 'orchestrate',
      title,
      status: 'will_do',
      pane: '',
      repoId: config.repoId,
      prompt,
      rotation,
    } as Omit<Task, 'id' | 'created_at'>)
    // 作成できた時点でスタンプする。start が失敗しても毎分作り直さないため
    this.writeState({ ...state, lastBootedDate: today })
    this.deps.notifyTasksUpdated()
    console.log(
      `[morningBoot] created (${today}): "${title}" (${task.id}) autoStart=${!!config.autoStart} rotation=${!!rotation?.enabled}`
    )

    if (!config.autoStart) return

    try {
      await this.deps.startTask(task.id)
      console.log(`[morningBoot] started (${today}): "${title}" (${task.id})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[morningBoot] start-failed (${today}): "${title}" (${task.id}):`, err)
      // リトライはしない（同じ理由で失敗し続けるため）。人に気づかせるのが目的
      this.deps.notifyStartFailed(message, task.id)
    }
  }

  private readState(): MorningBootState {
    const row = this.deps.db
      .prepare(`SELECT value FROM app_settings WHERE key = ?`)
      .get(STATE_KEY) as { value: string } | undefined
    if (!row) return {}
    try {
      return JSON.parse(row.value) as MorningBootState
    } catch {
      console.warn('[morningBoot] state is corrupted - reset')
      return {}
    }
  }

  private writeState(state: MorningBootState): void {
    this.deps.db
      .prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`)
      .run(STATE_KEY, JSON.stringify(state))
  }
}

/** ローカルタイムの YYYY-MM-DD。UTC 基準だと日本時間の朝が前日扱いになる */
function localDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/** "HH:MM" を0時からの分数に変換。不正なら null */
function parseTime(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

function expandDate(text: string, date: string): string {
  return text.replaceAll('{date}', date)
}
