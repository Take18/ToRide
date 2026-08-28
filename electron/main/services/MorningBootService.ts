import type Database from 'better-sqlite3'
import type { AppSettings, MorningBootRunResult } from '../../../src/types/ipc'
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
  // 「その日ぶんの起票判断を済ませた日」。起こした日も、既存タスクがあって見送った日も入る。
  // 曜日フィルタで見送った日は入れない（ボタンでの手動起票まで打ち切ってしまうため）
  lastBootedDate?: string
  // 直前のtickで enabled をどう見ていたか。false→true の遷移検知に使う
  enabledSeen?: boolean
  // enabled を有効と観測し始めた日。この日は自動起票しない（手動ボタンは通す）
  enabledSinceDate?: string
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
 * 指定時刻に orchestrate タスクを1日1本だけ立てる。手動ボタン（runNow）からも同じ経路を通る。
 *
 * 冪等性は2層で担保する:
 *  1. 永続の lastBootedDate（同じ日に二度判断しない。done にされた後の再起動でも立て直さない）
 *  2. 実行時のタスク一覧チェック（人が手で立てていたら作らない）
 *
 * 自動起票の判定は毎分の tick 1本に集約してあるので、定時発火・スリープ復帰・アプリ起動時の
 * catch-up がすべて同じ式で片づく（「時刻ぴったり」ではなく「1日1本」が要件）。
 */
export class MorningBootService {
  private timerId: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private loggedInvalidTime: string | null = null
  private loggedWeekdaySkipDate: string | null = null

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

  /** 自動起票の評価（1分ごと） */
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

  /**
   * 「今日ぶんを立てる」ボタンから呼ぶ手動起票。
   * enabled / time / weekdays は見ない（押した人の意思が優先）が、
   * 冪等性（lastBootedDate と既存タスクのチェック）は自動起票とまったく同じものを通す。
   */
  async runNow(now: Date = new Date()): Promise<MorningBootRunResult> {
    const config = this.deps.getSettings().morningBoot
    if (!config) {
      return { result: 'error', message: 'morningBoot が設定されていません' }
    }
    const today = localDate(now)
    const state = this.readState()
    if (state.lastBootedDate === today) {
      console.log(`[morningBoot] skipped (${today}): already booted today (manual)`)
      return {
        result: 'skipped',
        reason: 'already-booted',
        message: `今日（${today}）ぶんは起票済みです`,
      }
    }
    return this.boot(config, today, 'manual')
  }

  private async evaluate(now: Date): Promise<void> {
    const config = this.deps.getSettings().morningBoot
    const state = this.readState()
    const today = localDate(now)

    if (!config?.enabled) {
      if (state.enabledSeen) this.writeState({ ...state, enabledSeen: false })
      return
    }

    // 有効化した当日は自動では立てない（設定をいじっただけでセッションが起動する驚きを避ける）。
    // 手動ボタンは通したいので lastBootedDate ではなく専用のキーに記録する
    if (!state.enabledSeen) {
      this.writeState({ ...state, enabledSeen: true, enabledSinceDate: today })
      console.log(`[morningBoot] enabled - skipping today (${today}); first boot is tomorrow`)
      return
    }
    if (state.enabledSinceDate === today) return

    if (state.lastBootedDate === today) return

    // 曜日フィルタ。ここでの見送りは lastBootedDate を進めない
    // （進めると、曜日外の日に手動ボタンを押しても打ち切られてしまう）
    const weekdays = config.weekdays
    if (weekdays && weekdays.length > 0 && !weekdays.includes(now.getDay())) {
      if (this.loggedWeekdaySkipDate !== today) {
        this.loggedWeekdaySkipDate = today
        console.log(`[morningBoot] skipped (${today}): not a configured weekday`)
      }
      return
    }

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

    await this.boot(config, today, 'auto')
  }

  /** 起票の本体。自動・手動の両方がここを通る */
  private async boot(
    config: NonNullable<AppSettings['morningBoot']>,
    today: string,
    trigger: 'auto' | 'manual'
  ): Promise<MorningBootRunResult> {
    const state = this.readState()

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
      return {
        result: 'skipped',
        reason: 'existing-task',
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
    // 作成できた時点でスタンプする。start が失敗しても毎分作り直さないため
    this.writeState({ ...state, lastBootedDate: today })
    this.deps.notifyTasksUpdated()
    console.log(
      `[morningBoot] created (${today}, ${trigger}): "${title}" (${task.id}) autoStart=${!!config.autoStart} rotation=${!!rotation?.enabled}`
    )

    if (!config.autoStart) {
      return { result: 'created', taskId: task.id, title, started: false }
    }

    try {
      await this.deps.startTask(task.id)
      console.log(`[morningBoot] started (${today}): "${title}" (${task.id})`)
      return { result: 'created', taskId: task.id, title, started: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[morningBoot] start-failed (${today}): "${title}" (${task.id}):`, err)
      // リトライはしない（同じ理由で失敗し続けるため）。人に気づかせるのが目的。
      // 手動起票では結果が画面に出るので通知は出さない
      if (trigger === 'auto') this.deps.notifyStartFailed(message, task.id)
      return { result: 'start-failed', taskId: task.id, title, message }
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
