import fs from 'fs'
import path from 'path'
import type { AppSettings, ResidentOrchestratorRunResult } from '../../../src/types/ipc'
import type { RotationConfig, Task } from '../../../src/types/task'
import type { TaskService } from './TaskService'
import type { StartTaskFn } from '../ipc/claude'
import { expandPath } from '../utils/path'

const DEFAULT_TITLE = '常駐オーケストレータ {date}'
/**
 * どの設定も空だったときの最後の砦。
 * handoffPath が解決できないと SessionRotationService.onContextUpdate は無音で return するので、
 * 「常駐オーケストレータなら必ずローテーションする」を設定漏れで崩されないようにアプリ所有のパスを持つ
 */
const DEFAULT_HANDOFF_PATH = '~/.toride/handoff/orchestrator.md'

export type ResidentOrchestratorDeps = {
  taskService: TaskService
  getSettings: () => AppSettings
  startTask: StartTaskFn
  notifyTasksUpdated: () => void
}

/**
 * ダッシュボードの「常駐オーケストレータを立てる」ボタンから、orchestrate タスクを1本起票して起動する。
 *
 * 発火するのは人がボタンを押したときだけ（時刻での自動起票は持たない）。
 * そのため冪等性は「同じリポジトリの orchestrate が will_do / doing にあれば立てない」だけでよく、
 * 日付での打ち切りは持たない（done にした後にもう1本立てたいときは、また押せばよい）。
 */
export class ResidentOrchestratorService {
  constructor(private deps: ResidentOrchestratorDeps) {}

  async runNow(now: Date = new Date()): Promise<ResidentOrchestratorRunResult> {
    const settings = this.deps.getSettings()
    const config = settings.residentOrchestrator
    if (!config) {
      return { result: 'error', message: '常駐オーケストレータの設定がありません' }
    }
    // repoId 未設定でも起動自体はできてしまう（先頭のリポジトリや homedir に落ちる）が、
    // 意図しないリポジトリに立つと消す手間がかかるうえ、そのまま起動までいくのでエラーにする
    if (!config.repoId) {
      return {
        result: 'error',
        message:
          '起票先のリポジトリが設定されていません。設定画面の「常駐オーケストレータ」で選んでください',
      }
    }
    if (!settings.repos.some((r) => r.id === config.repoId)) {
      return {
        result: 'error',
        message: `起票先のリポジトリ「${config.repoId}」が設定に見つかりません`,
      }
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
        `[residentOrchestrator] skipped: orchestrate task already exists - "${existing.title}" (${existing.status})`
      )
      return {
        result: 'skipped',
        message: `既に orchestrate タスクがあります: 「${existing.title}」`,
      }
    }

    const title = expandDate(config.title?.trim() || DEFAULT_TITLE, today)
    const prompt = config.prompt ? expandDate(config.prompt, today) : undefined
    // 常駐オーケストレータは長時間走り続ける前提なので、ローテーションは常に有効にする。
    // 設定に rotation が無い / enabled: false が書かれていても true で上書きする。
    // ここを設定任せにすると、設定漏れのまま無音でコンテキストが埋まる（rotation 有効時は
    // 80/90% 通知も抑制されるため、気づく手がかりが何も残らない）
    // bootPrompt は prompt と同じにしたいケースがほとんどなので、省略時は prompt を流用する
    // （rotationDefaults に置くと他のタスクにも効いてしまうため、ここはタスク単位で載せる）
    const rotation: Omit<RotationConfig, 'history'> = {
      ...(config.rotation ?? {}),
      enabled: true,
      handoffPath: this.resolveHandoffPath(settings),
      bootPrompt: config.rotation?.bootPrompt
        ? expandDate(config.rotation.bootPrompt, today)
        : prompt,
    }
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
    // rotation は常に true なので、代わりに解決後の handoffPath を出す（無音の切り分けに要る）
    console.log(
      `[residentOrchestrator] created: "${title}" (${task.id}) handoff=${rotation.handoffPath}`
    )

    // 既定は起票して起動まで。autoStart: false を設定した場合だけ起票で止める
    if (config.autoStart === false) {
      return { result: 'created', taskId: task.id, title, started: false }
    }

    try {
      await this.deps.startTask(task.id)
      console.log(`[residentOrchestrator] started: "${title}" (${task.id})`)
      return { result: 'created', taskId: task.id, title, started: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[residentOrchestrator] start-failed: "${title}" (${task.id}):`, err)
      // リトライはしない。結果は押した人の画面に返るので通知は出さない
      return { result: 'start-failed', taskId: task.id, title, message }
    }
  }

  /**
   * handoffPath を決める。
   *
   * SessionRotationService.resolveConfig が task → rotationDefaults の順に引くので、
   * rotationDefaults に値があるならここでは undefined を返して引かせる。
   * 焼き込んでしまうと、あとで設定画面から変えても起票済みのタスクに効かなくなる。
   * どちらも空のときだけアプリ既定パスを埋めて、無音で止まる経路を消す。
   */
  private resolveHandoffPath(settings: AppSettings): string | undefined {
    const fromConfig = settings.residentOrchestrator?.rotation?.handoffPath?.trim()
    if (fromConfig) return fromConfig
    if (settings.rotationDefaults?.handoffPath?.trim()) return undefined

    // Claude 側の書き込みが親ディレクトリ不在で失敗しないよう、先に作っておく
    const expanded = expandPath(DEFAULT_HANDOFF_PATH)
    try {
      fs.mkdirSync(path.dirname(expanded), { recursive: true })
    } catch (err) {
      // 作れなくてもパスは返す（書き込み時に Claude 側で作られる可能性が残る）
      console.error('[residentOrchestrator] handoff ディレクトリの作成に失敗:', err)
    }
    return DEFAULT_HANDOFF_PATH
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
