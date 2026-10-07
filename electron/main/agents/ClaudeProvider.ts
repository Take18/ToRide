import type { ModelListService } from '../services/ModelListService'
import type { LaunchMode } from '../../../src/types/ipc'
import type { AgentCapabilities, AgentCommand, AgentProvider, AgentReadiness, InjectStep, LaunchOptions } from './types'

const CAPABILITIES: AgentCapabilities = {
  driver: 'pty',
  presetSessionId: true,
  initialPrompt: 'inject',
  imageInput: 'prompt',
  contextSource: 'statusline',
  prDetection: true,
  planMode: 'flag',
  rotation: true,
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const
  readonly displayName = 'Claude'
  readonly capabilities = CAPABILITIES
  readonly launchModes: LaunchMode[] = ['normal', 'auto', 'bypass', 'plan']
  readonly parseStdoutContext = true
  // 初めて開くフォルダでは信頼確認ダイアログが出る。既定の選択肢が「No, exit」なので、
  // ここに注入の Enter が届くと claude が終了してタスクが doing のまま止まる。
  // ダイアログを抜けるとウェルカムバナー（Claude Code vX.Y.Z）が描画される
  readonly injectGuard = {
    blockedBy: /trustthisfolder/i,
    unblockedBy: /ClaudeCodev\d/i,
    notice: 'フォルダの信頼確認が出ています。ターミナルで選ぶと、プロンプトを送信します',
  }

  constructor(private modelListService: ModelListService) {}

  async checkReady(): Promise<AgentReadiness> {
    return { ok: true }
  }

  buildCommand(opts: LaunchOptions): AgentCommand {
    let args = this.commonArgs(opts)
    if (opts.sessionId) args += ` --session-id ${opts.sessionId}`
    return { command: `claude${args}`, env: this.env(opts) }
  }

  buildResumeCommand(sessionId: string, opts: LaunchOptions): AgentCommand {
    // claude --resume は cwd でセッションを検索するため、元のペインの workdir で起動すること
    const args = this.commonArgs(opts) + ` --resume ${sessionId}`
    return { command: `claude${args}`, env: this.env(opts) }
  }

  buildInitialInput({ prompt }: LaunchOptions): InjectStep[] {
    if (!prompt) return []
    // テキストと Enter を分けて送ることで TUI がテキストを input field に
    // レンダリングした後に \r (Enter) が届くようにする
    return [{ write: prompt }, { delayMs: 200 }, { write: '\r' }]
  }

  listModels(): Promise<string[]> {
    return this.modelListService.listModels()
  }

  private commonArgs({ launchMode, model }: LaunchOptions): string {
    let args = ''
    if (launchMode === 'bypass') {
      args += ' --dangerously-skip-permissions'
    } else if (launchMode === 'auto') {
      args += ' --permission-mode auto'
    } else if (launchMode === 'plan') {
      args += ' --permission-mode plan'
    }
    if (model && model !== 'default') args += ` --model ${model}`
    return args
  }

  // インストール済みの stop.sh / statusline.sh は CLAUDE_TASK_ID しか読まないため、互換のため残す
  private env({ taskId }: LaunchOptions): Record<string, string> {
    return { CLAUDE_TASK_ID: taskId }
  }
}
