import { randomBytes } from 'crypto'
import type { TaskService } from './TaskService'
import type { TerminalService } from './TerminalService'
import type { StopHookService } from './StopHookService'
import type { NotifyInput } from './NotificationService'
import type { AgentProvider } from '../agents/types'
import type { RuntimeTask } from '../../../src/types/task'

/** 合図を書き込んでから入力欄へのエコーを確かめるまでの待ち（ローテーションと同じ） */
const ECHO_WAIT_MS = 200
const ECHO_BUFFER_LEN = 4000

// Stop hook の reason の頭に付ける。付けないと、別タスクからのお願いとして読むだけで実行しないことがある
const DELIVERY_PREFIX = '以下は ToRide 経由で届いた別タスクからの依頼です。内容に従って対応してください。'

type Message = { text: string; at: number }

export type SendResult =
  /** codex queue に積んだ。今のターンが終わってから処理される */
  | { status: 'queued' }
  /** 入力待ちだったので、受信箱を読ませる合図を送った */
  | { status: 'notified' }
  /** 作業中なので受信箱にためた。ターンが終わったら Stop hook の応答で渡す */
  | { status: 'pending'; note?: string }

type Deps = {
  taskService: TaskService
  terminalService: TerminalService
  stopHookService: StopHookService
  getProvider: (task: RuntimeTask) => AgentProvider
  /** handoff を書かせている最中か（SessionRotationService.isAwaitingHandoff） */
  isAwaitingHandoff: (taskId: string) => boolean
  notify: (input: NotifyInput) => void
}

const normalize = (s: string): string => s.replace(/\s+/g, '')

/** ANSI エスケープを落とす（SessionRotationService と同じ処理） */
const stripAnsi = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\r/g, '')

/**
 * タスク間のメッセージ（MCP の send_to_task）を届ける。
 *
 * どちらの経路も「今のターンが終わってから届く」形にそろえている。
 * ターンの途中に PTY へ書き込むと、承認待ちや AskUserQuestion の画面に Enter が届いて誤って確定させるため。
 * - queueMessage を持つエージェント（Codex）: codex queue に積む
 * - それ以外（Claude）: 受信箱にためて、Stop hook の応答（decision: block）で本文を渡す。
 *   入力待ちで Stop hook がもう来ないときだけ、受信箱を読ませる1行の合図を PTY に送る
 */
export class TaskMessageService {
  private mailboxes = new Map<string, Message[]>()
  /** 受信箱を渡さずに終わった（本当に止まった）Stop hook の時刻 */
  private lastStopAt = new Map<string, number>()
  private nudging = new Set<string>()

  constructor(private deps: Deps) {
    deps.stopHookService.setDeliverer((taskId) => this.onStop(taskId))
  }

  async send(input: { to: string; from?: string; message: string }): Promise<SendResult> {
    const tasks = this.deps.taskService.list()
    const target = tasks.find((t) => t.id === input.to)
    if (!target) throw new Error(`Task not found: ${input.to}. Use list_tasks to get valid task IDs.`)
    if (target.status !== 'doing') {
      // 止めたセッションに積むと、再開したときに急に届いてしまう
      throw new Error(`Task is not running (status: ${target.status}). Messages can only be sent to doing tasks.`)
    }
    if (input.from && input.from === input.to) throw new Error('Cannot send a message to yourself.')
    const sender = input.from ? tasks.find((t) => t.id === input.from) : undefined
    const text = formatMessage(input.message, sender, input.from)

    const provider = this.deps.getProvider(target)
    if (provider.queueMessage) {
      if (!target.sessionId) {
        throw new Error('The target session has not reported its session ID yet. Retry in a few seconds.')
      }
      if (this.deps.isAwaitingHandoff(target.id)) {
        // codex queue は旧セッションに積まれ、新セッションには届かない
        throw new Error('The target task is rotating its session. Retry after the rotation finishes (get_rotation_status).')
      }
      const result = await provider.queueMessage(target.sessionId, text)
      if (!result.ok) throw new Error(result.reason)
      return { status: 'queued' }
    }

    if (!this.deps.stopHookService.supportsMailbox()) {
      throw new Error(
        'The installed Stop Hook (~/.claude/hooks/stop.sh) is outdated and cannot deliver messages. ' +
          'Ask the user to reinstall it from the ToRide settings screen.'
      )
    }
    const box = this.mailboxes.get(target.id) ?? []
    box.push({ text, at: Date.now() })
    this.mailboxes.set(target.id, box)

    if (!this.isIdle(target.id)) return { status: 'pending' }
    return this.nudge(target)
  }

  /** 受信箱を空にして中身を返す（MCP の read_messages） */
  read(taskId: string): string[] {
    const box = this.mailboxes.get(taskId) ?? []
    this.mailboxes.delete(taskId)
    return box.map((m) => m.text)
  }

  /** タスクが終わったら受信箱を捨てる（endTaskSession） */
  clear(taskId: string): void {
    const dropped = this.mailboxes.get(taskId)?.length ?? 0
    if (dropped > 0) console.log(`[TaskMessageService] dropped ${dropped} message(s) for ${taskId}`)
    this.mailboxes.delete(taskId)
    this.lastStopAt.delete(taskId)
    this.nudging.delete(taskId)
  }

  private onStop(taskId: string): string | null {
    const box = this.mailboxes.get(taskId)
    // handoff を書かせている間に渡すと、旧セッションと一緒に捨てられる。受信箱は新セッションの Stop まで持ち越す
    if (!box?.length || this.deps.isAwaitingHandoff(taskId)) {
      this.lastStopAt.set(taskId, Date.now())
      return null
    }
    this.mailboxes.delete(taskId)
    const body = box.map((m) => m.text).join('\n\n---\n\n')
    return JSON.stringify({ decision: 'block', reason: `${DELIVERY_PREFIX}\n\n${body}` })
  }

  /**
   * Stop hook が来たあと、誰も入力していなければ入力待ちとみなす。
   * 承認待ちや AskUserQuestion の表示中は Stop hook が来ないので、ここは false になり受信箱で待つ
   */
  private isIdle(taskId: string): boolean {
    if (!this.deps.terminalService.hasSession(taskId)) return false
    if (this.deps.isAwaitingHandoff(taskId)) return false
    const stoppedAt = this.lastStopAt.get(taskId) ?? 0
    return stoppedAt > 0 && stoppedAt > this.deps.terminalService.getLastWriteAt(taskId)
  }

  /**
   * 入力待ちのセッションに、受信箱を読ませる1行の合図を送る。
   * 本文を直接書かないのは、長い本文は TUI が [Pasted text ...] に畳んでエコーを確かめられないため。
   * 合図のターンで read_messages を呼ばなくても、そのターンの Stop hook で本文が渡る
   */
  private async nudge(task: RuntimeTask): Promise<SendResult> {
    if (this.nudging.has(task.id)) return { status: 'pending' }
    this.nudging.add(task.id)
    const { terminalService } = this.deps
    let buffer = ''
    const unsub = terminalService.onData(task.id, (data) => {
      buffer = (buffer + stripAnsi(data)).slice(-ECHO_BUFFER_LEN)
    })
    try {
      // エコー照合に使う ASCII の目印を最後に置く（日本語は全角幅で折り返し位置がずれるため照合に使わない）
      const marker = `[toride-msg:${randomBytes(4).toString('hex')}]`
      const notice = `[ToRide] 受信箱にメッセージが届いています。ToRide の read_messages を task_id="${task.id}" で呼んで読み、書かれている依頼に従って対応してください ${marker}`
      const payload = this.deps.getProvider(task).pasteInput ? `\x1b[200~${notice}\x1b[201~` : notice
      // ここから write までの間に await を挟まない（前の出力が混ざってエコー照合が偽陽性になる）
      terminalService.write(task.id, payload)
      await new Promise((r) => setTimeout(r, ECHO_WAIT_MS))
      if (!normalize(buffer).includes(normalize(marker))) {
        this.deps.notify({
          category: 'session',
          level: 'warning',
          title: `メッセージの合図を送れませんでした: ${task.title}`,
          body: '入力欄に表示されたか確認できなかったため Enter を送っていません。ターミナルを確認してください。メッセージは受信箱に残っています',
          navigation: { type: 'task', taskId: task.id },
        })
        return { status: 'pending', note: 'Could not confirm the notice reached the input box. The message stays in the mailbox.' }
      }
      terminalService.write(task.id, '\r')
      return { status: 'notified' }
    } finally {
      unsub()
      this.nudging.delete(task.id)
    }
  }
}

function formatMessage(body: string, sender: RuntimeTask | undefined, fromId: string | undefined): string {
  if (!fromId) return `[ToRide] 送信元不明のメッセージ:\n${body}`
  const name = sender ? `タスク「${sender.title}」(id: ${fromId})` : `タスク (id: ${fromId})`
  return `[ToRide] ${name} からのメッセージ:\n${body}\n\n（返信するときは ToRide の send_to_task で to="${fromId}" を指定する）`
}
