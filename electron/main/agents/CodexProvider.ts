import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import type { LaunchMode } from '../../../src/types/ipc'
import type { AgentCapabilities, AgentCommand, AgentProvider, AgentReadiness, InjectStep, LaunchOptions } from './types'
import { parseJsonOutput, runCodex } from './codexCli'

const CAPABILITIES: AgentCapabilities = {
  driver: 'pty',
  presetSessionId: false,
  initialPrompt: 'argument',
  imageInput: 'argument',
  contextSource: 'transcript',
  prDetection: false,
  planMode: 'slash',
  rotation: false,
}

const TORIDE_DIR = path.join(homedir(), '.toride')
const HOOK_FILE = path.join(TORIDE_DIR, 'hooks', 'codex-hook.sh')
const PROMPT_DIR = path.join(TORIDE_DIR, 'prompts')

// Codex は http 型の hook を持たないため、command 型の hook からこのスクリプトを呼んで ToRide に POST する。
// TORIDE_TASK_ID / TORIDE_PORT は起動時の env が hook に継承される。
// ポートを env で渡すのは、別プロファイルで並走しているインスタンスの ~/.toride/port を読まないようにするため
const HOOK_CONTENT = `#!/bin/sh
# ToRide - Codex hook
# このファイルは ToRide アプリが Codex のタスクを起動するたびに書き直します。
EVENT="$1"
INPUT=$(cat)
TASK_ID="$TORIDE_TASK_ID"
[ -n "$TASK_ID" ] || exit 0
PORT="$TORIDE_PORT"
if [ -z "$PORT" ] && [ -f "$HOME/.toride/port" ]; then
  PORT=$(cat "$HOME/.toride/port")
fi
[ -n "$PORT" ] || exit 0
# stdout は Codex に読まれるので、curl の出力は捨てる
case "$EVENT" in
  session-start)
    [ -n "$INPUT" ] || exit 0
    curl -s --max-time 2 -X POST "http://127.0.0.1:$PORT/agent-session" \\
      -H "Content-Type: application/json" \\
      -d "{\\"taskId\\":\\"$TASK_ID\\",\\"data\\":$INPUT}" > /dev/null 2>&1
    ;;
  stop)
    curl -s --max-time 2 -X POST "http://127.0.0.1:$PORT/task-done" \\
      -H "Content-Type: application/json" \\
      -d "{\\"taskId\\":\\"$TASK_ID\\"}" > /dev/null 2>&1
    ;;
esac
exit 0
`

// codex doctor は10秒ほどかかるため、通った結果はしばらく使い回す
const READY_CACHE_MS = 10 * 60 * 1000
const MODELS_CACHE_MS = 10 * 60 * 1000

export type CodexAuthStatus = { installed: boolean; loggedIn: boolean; reason?: string }

type DoctorReport = {
  checks?: Record<string, { status?: string; summary?: string }>
}

/** シェルのシングルクォートで囲む（中の ' は '\'' に置き換える） */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** TOML の基本文字列。JSON の文字列リテラルと互換なのでそのまま使う */
function tomlString(s: string): string {
  return JSON.stringify(s)
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const
  readonly displayName = 'Codex'
  readonly capabilities = CAPABILITIES
  readonly launchModes: LaunchMode[] = ['normal', 'auto', 'bypass', 'plan']
  // ウェルカムバナー（>_ OpenAI Codex (vX.Y.Z)）が出たら入力を受け付ける。
  // Codex は起動直後、画面を描く前に \x1b[?2004h を出すので、bracketed paste では判定できない
  readonly readyPattern = /OpenAICodex\(v\d/
  // 初めて開くディレクトリでは信頼確認が出る。-c では消せず、~/.codex/config.toml の trust_level だけが効く。
  // 選ぶとウェルカムバナーが描画される
  readonly injectGuard = {
    blockedBy: /Doyoutrustthecontentsofthisdirectory/i,
    unblockedBy: /OpenAICodex\(v\d/,
    notice:
      'Codex のフォルダ信頼確認が出ています。ターミナルで選ぶと開始します（設定画面の「ペインを信頼済みにする」で次回から出なくなります）',
  }

  private authCache: { at: number; status: CodexAuthStatus } | null = null
  private modelsCache: { at: number; models: string[] } | null = null

  constructor(private getPort: () => number) {}

  async getAuthStatus(refresh = false): Promise<CodexAuthStatus> {
    if (!refresh && this.authCache && Date.now() - this.authCache.at < READY_CACHE_MS) {
      return this.authCache.status
    }
    const status = await this.runDoctor()
    // 通らなかった結果は覚えない（codex login した直後に起動し直せるように）
    this.authCache = status.loggedIn ? { at: Date.now(), status } : null
    return status
  }

  private async runDoctor(): Promise<CodexAuthStatus> {
    const result = await runCodex(['doctor', '--json'], 30_000)
    if (!result.ok && result.notFound) {
      return {
        installed: false,
        loggedIn: false,
        reason: 'codex コマンドが見つかりません。Codex CLI をインストールして、ログインシェルの PATH に通してください',
      }
    }
    // 警告があると終了コードが 0 以外になることがあるため、stdout があれば読む
    const report = parseJsonOutput<DoctorReport>(result.stdout)
    if (!report) {
      const detail = result.ok ? '' : `: ${result.message}`
      return { installed: true, loggedIn: false, reason: `codex doctor の結果を読めませんでした${detail}` }
    }
    // codex login status は env の API キーを見ないので、doctor の判定を使う
    const auth = report.checks?.['auth.credentials']
    if (auth?.status !== 'ok') {
      return {
        installed: true,
        loggedIn: false,
        reason: `Codex にログインしていません。ターミナルで codex login を実行してください（${auth?.summary ?? 'auth.credentials がありません'}）`,
      }
    }
    return { installed: true, loggedIn: true }
  }

  async checkReady(): Promise<AgentReadiness> {
    const status = await this.getAuthStatus()
    return status.loggedIn ? { ok: true } : { ok: false, reason: status.reason ?? 'Codex を起動できません' }
  }

  buildCommand(opts: LaunchOptions): AgentCommand {
    let args = this.commonArgs(opts)
    for (const image of opts.images ?? []) args += ` -i ${shellQuote(image)}`
    // plan はフラグが無いので、引数なしで起動してから /plan を送る（buildInitialInput）
    if (opts.prompt && opts.launchMode !== 'plan') {
      // 改行や引用符がシェルで崩れないよう、プロンプトはファイル経由で渡す。読んだら消す。
      // -i は値を複数取るため、-- で区切ってからプロンプトを置く（- で始まるプロンプトをフラグと誤認させない意味もある）
      const file = this.writePromptFile(opts.taskId, opts.prompt)
      args += ` -- "$(cat ${shellQuote(file)}; rm -f ${shellQuote(file)})"`
    }
    return { command: `codex${args}`, env: this.env() }
  }

  buildResumeCommand(sessionId: string, opts: LaunchOptions): AgentCommand {
    // 別の cwd から再開すると作業ディレクトリを選ぶモーダルが出るので、記録された cwd で再開させる
    const args = ` resume ${shellQuote(sessionId)} -c ${shellQuote('tui.resume_cwd="session"')}` + this.commonArgs(opts)
    return { command: `codex${args}`, env: this.env() }
  }

  buildInitialInput({ prompt, launchMode }: LaunchOptions): InjectStep[] {
    if (launchMode !== 'plan') return []
    // 「/plan <本文>」を一度に送ると、起動直後は「'/plan' is disabled while a task is in progress」で弾かれる。
    // /plan だけで plan モードに切り替えてから、本文を bracketed paste で送る（改行で送信されないように）
    const steps: InjectStep[] = [
      { write: '/plan' },
      { delayMs: 300 },
      { write: '\r' },
      {
        // スラッシュコマンドの候補（/plan switch to Plan mode）には反応しないよう除外する
        waitFor: /(?<!switchto)Planmode/i,
        timeoutMs: 5000,
        notice: 'Codex を plan モードに切り替えられなかったため、プロンプトを送信していません。ターミナルで確認してください',
      },
    ]
    if (prompt) {
      steps.push({ delayMs: 500 }, { write: `\x1b[200~${prompt}\x1b[201~` }, { delayMs: 500 }, { write: '\r' })
    }
    return steps
  }

  async listModels(): Promise<string[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < MODELS_CACHE_MS) return this.modelsCache.models
    const result = await runCodex(['debug', 'models'], 15_000)
    const parsed = parseJsonOutput<{ models?: Array<{ slug?: string; visibility?: string }> }>(result.stdout)
    if (!parsed?.models) {
      // 取れなければ候補を出さず、既定モデル（-m なし）で起動させる
      console.warn('[CodexProvider] codex debug models failed:', result.ok ? 'unexpected output' : result.message)
      return []
    }
    const models = parsed.models
      .filter((m) => m.visibility === 'list' && m.slug)
      .map((m) => m.slug as string)
    this.modelsCache = { at: Date.now(), models }
    return models
  }

  private commonArgs({ launchMode, model }: LaunchOptions): string {
    let args = ''
    if (launchMode === 'bypass') {
      args += ' --dangerously-bypass-approvals-and-sandbox'
    } else if (launchMode === 'auto') {
      args += ' --approve-for-me'
    } else {
      // normal と plan。--full-auto は廃止済みで、-a に渡せるのは on-request と never だけ
      args += ' -s workspace-write -a on-request'
    }
    if (model && model !== 'default') args += ` -m ${shellQuote(model)}`

    // 起動時のアップデート確認は選ぶまで先に進まないため、自動起動では出さない
    args += ` -c ${shellQuote('check_for_update_on_startup=false')}`

    // hook は起動ごとに -c で渡す（~/.codex/hooks.json は触らない）。
    // 信頼されていない hook があると TUI が「Hooks need review」で止まるため、確認を飛ばす
    this.ensureHookScript()
    const hook = (event: string) =>
      `[{hooks=[{type="command",command=${tomlString(`sh ${shellQuote(HOOK_FILE)} ${event}`)}}]}]`
    args += ` -c ${shellQuote(`hooks.SessionStart=${hook('session-start')}`)}`
    args += ` -c ${shellQuote(`hooks.Stop=${hook('stop')}`)}`
    args += ' --dangerously-bypass-hook-trust'

    // Codex は streamable HTTP の MCP にしか対応していないので、SSE ではなく /mcp につなぐ
    const port = this.getPort()
    if (port) args += ` -c ${shellQuote(`mcp_servers.toride.url=${tomlString(`http://127.0.0.1:${port}/mcp`)}`)}`
    return args
  }

  private env(): Record<string, string> {
    const port = this.getPort()
    return port ? { TORIDE_PORT: String(port) } : {}
  }

  private ensureHookScript(): void {
    fs.mkdirSync(path.dirname(HOOK_FILE), { recursive: true })
    fs.writeFileSync(HOOK_FILE, HOOK_CONTENT, { encoding: 'utf-8', mode: 0o755 })
  }

  private writePromptFile(taskId: string, prompt: string): string {
    fs.mkdirSync(PROMPT_DIR, { recursive: true })
    const file = path.join(PROMPT_DIR, `${taskId}.md`)
    fs.writeFileSync(file, prompt, { encoding: 'utf-8', mode: 0o600 })
    return file
  }
}
