import type { AgentId, ClaudeModel, LaunchMode } from '../../../src/types/ipc'

// エージェントごとの能力差。足りない能力は機能を黙って消さず、画面に理由を出すために使う
export type AgentCapabilities = {
  /** pty: TUI を PTY で動かす / http: HTTP サーバー経由で操作する（opencode を想定） */
  driver: 'pty' | 'http'
  /** セッションIDを起動前に ToRide 側で採番して渡せるか */
  presetSessionId: boolean
  /** inject: TUI 起動検知後に入力欄へ書き込む / argument: 起動引数で渡す */
  initialPrompt: 'inject' | 'argument'
  /** コンテキスト使用量の取得元 */
  contextSource: 'statusline' | 'transcript' | 'none'
  /** セッション中に作成された PR URL を検知できるか */
  prDetection: boolean
  /** plan モードへの入り方 */
  planMode: 'flag' | 'slash' | 'none'
  /** セッションローテーションに対応しているか */
  rotation: boolean
}

export type LaunchOptions = {
  taskId: string
  launchMode?: LaunchMode
  model?: ClaudeModel
  /** presetSessionId のエージェントで、起動前に採番したID */
  sessionId?: string
}

export type AgentCommand = {
  /** ログインシェルに書き込むコマンド行（改行は呼び出し側で付ける） */
  command: string
  /** エージェント固有の追加 env。TORIDE_TASK_ID は呼び出し側で必ず付ける */
  env: Record<string, string>
}

export type AgentReadiness = { ok: true } | { ok: false; reason: string }

export interface AgentProvider {
  id: AgentId
  /** 通知などに出す表示名 */
  displayName: string
  capabilities: AgentCapabilities
  /** 起動前の確認（未ログインで TUI を立ち上げて ready を誤判定するのを防ぐ） */
  checkReady(): Promise<AgentReadiness>
  buildCommand(opts: LaunchOptions): AgentCommand
  buildResumeCommand(sessionId: string, opts: LaunchOptions): AgentCommand
  listModels(): Promise<string[]>
}
