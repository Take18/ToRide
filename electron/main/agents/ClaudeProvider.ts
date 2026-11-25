import type { ModelListService } from '../services/ModelListService'
import type { LaunchMode } from '../../../src/types/ipc'
import path from 'path'
import { homedir } from 'os'
import fs from 'fs'
import type { AgentCapabilities, AgentCommand, AgentProvider, AgentReadiness, CommandSource, InjectStep, LatestAssistantMessage, LatestAssistantMessageResult, LaunchOptions, TranscriptLocation } from './types'
import { parseJsonLine, scanLinesBackward } from '../utils/transcript'

const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')

type ClaudeTranscriptLine = {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  message?: { id?: string; content?: unknown }
}

/** assistant 行のテキストブロックだけを取り出す（thinking / tool_use は除く） */
const textBlocks = (content: unknown): string[] =>
  Array.isArray(content)
    ? content
        .filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
    : []

/**
 * セッションIDから transcript（~/.claude/projects/<cwd を変換した名前>/<sessionId>.jsonl）を探す。
 * cwd からディレクトリ名への変換規則は公開されていないので、projects 配下を走査する
 */
const findClaudeTranscript = async (sessionId: string): Promise<string | null> => {
  let dirs: string[]
  try {
    dirs = await fs.promises.readdir(PROJECTS_DIR)
  } catch {
    return null
  }
  for (const dir of dirs) {
    const file = path.join(PROJECTS_DIR, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(file)) return file
  }
  return null
}

const CAPABILITIES: AgentCapabilities = {
  driver: 'pty',
  presetSessionId: true,
  initialPrompt: 'inject',
  imageInput: 'prompt',
  contextSource: 'statusline',
  prDetection: true,
  planMode: 'flag',
  rotation: true,
  commandTrigger: '/',
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

  async readLatestAssistantMessage({ sessionId, transcriptPath }: TranscriptLocation): Promise<LatestAssistantMessageResult> {
    if (!sessionId && !transcriptPath) return { ok: false, reason: 'セッションIDがありません（未起動のタスク）' }
    const file = transcriptPath ?? (sessionId ? await findClaudeTranscript(sessionId) : null)
    // 起動直後は最初のプロンプトが届くまで transcript が作られない
    if (!file) return { ok: true, message: null }

    // 1つの応答（message.id）は、ブロックごとに別の行に書かれる。
    // 末尾から最初に見つかったテキストと同じ message.id のテキストを集める
    let messageId: string | undefined
    let timestamp: string | undefined
    const parts: string[] = []
    try {
      await scanLinesBackward(file, (line) => {
        if (messageId === undefined) {
          // 巨大な tool_result の行を JSON.parse しないよう先に絞る
          if (!line.includes('"type":"assistant"') || !line.includes('"type":"text"')) return false
          const parsed = parseJsonLine<ClaudeTranscriptLine>(line)
          if (parsed?.type !== 'assistant' || parsed.isSidechain) return false
          const texts = textBlocks(parsed.message?.content)
          if (!texts.length) return false
          messageId = parsed.message?.id ?? ''
          timestamp = parsed.timestamp
          parts.unshift(...texts)
          // id が無ければ同じ応答の続きを判定できないので、この行だけにする
          return messageId === ''
        }
        const parsed = parseJsonLine<ClaudeTranscriptLine>(line)
        if (!parsed) return false
        if (parsed.type !== 'assistant' || parsed.message?.id !== messageId) return parsed.type === 'user' || parsed.type === 'assistant'
        parts.unshift(...textBlocks(parsed.message?.content))
        return false
      })
    } catch (e) {
      return { ok: false, reason: `transcript を読めませんでした: ${(e as Error).message}` }
    }
    const text = parts.join('\n\n').trim()
    const message: LatestAssistantMessage | null = text ? { text, timestamp } : null
    return { ok: true, message }
  }

  // 同名はプロジェクト > ユーザー > プラグインの優先で残す
  commandSources(workdir?: string): CommandSource[] {
    const userDir = path.join(homedir(), '.claude')
    const sources: CommandSource[] = []
    if (workdir) {
      sources.push(
        { type: 'commands', dir: path.join(workdir, '.claude', 'commands'), source: 'project' },
        { type: 'skills', dir: path.join(workdir, '.claude', 'skills'), source: 'project' }
      )
    }
    sources.push(
      { type: 'commands', dir: path.join(userDir, 'commands'), source: 'user' },
      { type: 'skills', dir: path.join(userDir, 'skills'), source: 'user' },
      { type: 'claude-plugins', userDir }
    )
    return sources
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
