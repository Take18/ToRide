import type { AppSettings, MorningBootRunResult } from '../../../src/types/ipc'
import type { Task } from '../../../src/types/task'
import type { TaskService } from './TaskService'
import type { StartTaskFn } from '../ipc/claude'

const DEFAULT_TITLE = 'オーケストレータ {date}'

export type MorningBootDeps = {
  taskService: TaskService
  getSettings: () => AppSettings
  startTask: StartTaskFn
  notifyTasksUpdated: () => void
}

/**
 * ダッシュボードの「オーケストレータを立てる」ボタンから、orchestrate タスクを1本起票して起動する。
 *
 * 発火するのは人がボタンを押したときだけ（時刻での自動起票は持たない）。
 * そのため冪等性は「同じリポジトリの orchestrate が will_do / doing にあれば立てない」だけでよく、
 * 日付での打ち切りは持たない（done にした後にもう1本立てたいときは、また押せばよい）。
 */
export class MorningBootService {
  constructor(private deps: MorningBootDeps) {}

  async runNow(now: Date = new Date()): Promise<MorningBootRunResult> {
    const config = this.deps.getSettings().morningBoot
    if (!config) {
      return { result: 'error', message: 'オーケストレータの設定がありません' }
    }
    const today = localDate(now)

    // 人が手で立てていたり、前のセッションがまだ走っていたら作らない。
    // スコープは repoId 一致に限定する（全 orchestrate を見ると、別リポジトリの
    // オーケストレータが走っているだけで立てられなくなる）
    const existing = this.deps.taskService
      .list()
      .find(
        (t) =>
          t.type === 'orchestrate' &&
          (t.status === 'will_do' || t.status === 'doing') &&
          (t.repoId ?? undefined) === (config.repoId ?? undefined)
      )
    if (existing) {
      console.log(
        `[morningBoot] skipped: orchestrate task already exists - "${existing.title}" (${existing.status})`
      )
      return {
        result: 'skipped',
        message: `既に orchestrate タスクがあります: 「${existing.title}」`,
      }
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
    this.deps.notifyTasksUpdated()
    console.log(
      `[morningBoot] created: "${title}" (${task.id}) rotation=${!!rotation?.enabled}`
    )

    // 既定は起票して起動まで。autoStart: false を設定した場合だけ起票で止める
    if (config.autoStart === false) {
      return { result: 'created', taskId: task.id, title, started: false }
    }

    try {
      await this.deps.startTask(task.id)
      console.log(`[morningBoot] started: "${title}" (${task.id})`)
      return { result: 'created', taskId: task.id, title, started: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[morningBoot] start-failed: "${title}" (${task.id}):`, err)
      // リトライはしない。結果は押した人の画面に返るので通知は出さない
      return { result: 'start-failed', taskId: task.id, title, message }
    }
  }
}

/** ローカルタイムの YYYY-MM-DD。UTC 基準だと日本時間の朝が前日扱いになる */
function localDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function expandDate(text: string, date: string): string {
  return text.replaceAll('{date}', date)
}
