import type { AgentCapabilities, AgentId, ClaudeModel, LaunchMode } from '../../../src/types/ipc'

export type { AgentCapabilities }

export type LaunchOptions = {
  taskId: string
  launchMode?: LaunchMode
  model?: ClaudeModel
  /** presetSessionId のエージェントで、起動前に採番したID */
  sessionId?: string
  /** initialPrompt が argument のエージェントは起動引数に載せる（inject のエージェントは無視する） */
  prompt?: string
  /** imageInput が argument のエージェントは起動引数で添付する */
  images?: string[]
}

export type AgentCommand = {
  /** ログインシェルに書き込むコマンド行（改行は呼び出し側で付ける） */
  command: string
  /** エージェント固有の追加 env。TORIDE_TASK_ID は呼び出し側で必ず付ける */
  env: Record<string, string>
}

export type AgentReadiness = { ok: true } | { ok: false; reason: string }

/**
 * 起動後に TUI へ送る入力の手順。上から順に実行する。
 * waitFor が timeoutMs 以内に出なければ、以降の手順は送らずに notice を通知する
 */
export type InjectStep =
  | { write: string }
  | { delayMs: number }
  | { waitFor: RegExp; timeoutMs: number; notice: string }

export interface AgentProvider {
  id: AgentId
  /** 通知などに出す表示名 */
  displayName: string
  capabilities: AgentCapabilities
  /** 起動ボタンで選べるモード */
  launchModes: LaunchMode[]
  /** 起動前の確認（未ログインで TUI を立ち上げて ready を誤判定するのを防ぐ） */
  checkReady(): Promise<AgentReadiness>
  buildCommand(opts: LaunchOptions): AgentCommand
  buildResumeCommand(sessionId: string, opts: LaunchOptions): AgentCommand
  /** 新規起動のあと TUI に送る入力。送るものがなければ空配列 */
  buildInitialInput(opts: LaunchOptions): InjectStep[]
  listModels(): Promise<string[]>
  /**
   * 入力を受け付ける状態になったことの検出パターン（照合対象は ANSI と空白を除いた PTY 出力）。
   * 未指定なら bracketed paste mode の有効化（\x1b[?2004h）で判定する
   */
  readyPattern?: RegExp
  /**
   * 注入してはいけない画面の検出パターン。照合対象は ANSI エスケープと空白を除いた PTY 出力。
   * blockedBy が出たら unblockedBy が出るまで注入しない。注入するものがなくても、出たことは通知する
   */
  injectGuard?: InjectGuard
}

export type InjectGuard = {
  blockedBy: RegExp
  unblockedBy: RegExp
  /** 待っている間に出す通知の本文 */
  notice: string
}
