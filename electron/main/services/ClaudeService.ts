import type { TerminalService } from './TerminalService'
import type { ContextLineService } from './ContextLineService'
import type { ClaudeModel, ContextInfo, LaunchMode } from '../../../src/types/ipc'
import type { NotifyInput } from './NotificationService'
import type { AgentProvider, InjectStep } from '../agents/types'

// ANSIエスケープシーケンスと CR を除去する
function stripAnsi(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')             // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC (BEL or ST terminator)
    .replace(/\x1b[()][AB012]/g, '')                       // charset sequences
    .replace(/\r/g, '')                                    // CR
}

export type ContextUpdateCallback = (info: ContextInfo) => void

/** コンテキスト使用量の取得元（Status Line Hook・rollout ファイルの tail など） */
export type ContextSource = {
  onContextUpdate(cb: ContextUpdateCallback): unknown
}

export type AgentStartOptions = {
  prompt?: string
  launchMode?: LaunchMode
  model?: ClaudeModel
  cols?: number
  rows?: number
  /** presetSessionId のエージェントで、起動前に採番したID */
  sessionId?: string
  /** 指定時は新規起動ではなく再開 */
  resumeSessionId?: string
  /** imageInput が argument のエージェントに起動引数で渡す添付画像 */
  images?: string[]
}

export class ClaudeService {
  private terminalService: TerminalService
  private contextCallbacks: Set<ContextUpdateCallback> = new Set()
  private notifiedThresholds: Map<string, Set<number>> = new Map()
  // 正規表現パス用: デルタ値 (↓ 8.6k tokens) の累積に使用
  private maxContextUsed: Map<string, number> = new Map()
  private cleanBuffers: Map<string, string> = new Map()
  // 全ソース共通のゲート: ここを通過した最大値より小さい更新は全て捨てる
  private lastEmittedMax: Map<string, number> = new Map()

  // rotation 有効タスクでは 80/90% 通知を抑制する（threshold=60 でローテーションが
  // 始まった直後に「80%注意」が飛ぶ二重通知を避けるため）。
  // 抑制しても保留・停止・中止の通知は SessionRotationService 側から必ず出る
  private isRotationEnabled?: (taskId: string) => boolean
  private notify?: (input: NotifyInput) => void

  constructor(
    terminalService: TerminalService,
    contextLineService?: ContextLineService,
    isRotationEnabled?: (taskId: string) => boolean,
    notify?: (input: NotifyInput) => void
  ) {
    this.terminalService = terminalService
    this.isRotationEnabled = isRotationEnabled
    this.notify = notify
    if (contextLineService) this.attachContextSource(contextLineService)
  }

  // 取得元ごとに別の経路を作らず、すべて fireContextUpdate のゲートと閾値通知を通す
  attachContextSource(source: ContextSource): void {
    source.onContextUpdate((info) => this.fireContextUpdate(info))
  }

  start(taskId: string, workdir: string, provider: AgentProvider, opts: AgentStartOptions = {}): void {
    const { prompt, images, launchMode, model, cols, rows, sessionId, resumeSessionId } = opts
    const launch = { taskId, launchMode, model, sessionId, prompt, images }
    const { command, env } = resumeSessionId
      ? provider.buildResumeCommand(resumeSessionId, launch)
      : provider.buildCommand(launch)
    this.terminalService.start(taskId, workdir, cols ?? 120, rows ?? 30, { ...env, TORIDE_TASK_ID: taskId })
    this.terminalService.write(taskId, `${command}\n`)

    const steps = resumeSessionId ? [] : provider.buildInitialInput(launch)
    const guard = provider.injectGuard
    // 送るものがなくても、guard の画面（フォルダ信頼確認など）で止まっていることは知らせる
    if (steps.length > 0 || guard) {
      // 送るものがなければ最初から送信済みとして扱い、guard の監視だけ行う
      let injected = steps.length === 0
      // injectGuard の画面が出ている間は true。注入の Enter で誤って選択させない
      let blocked = false
      let screen = ''
      let readyScreen = ''

      const finish = () => {
        unsubReady()
        clearTimeout(fallbackTimer)
      }

      const tryInject = () => {
        if (injected) {
          // 送るものがないまま12秒たった場合も、guard の画面が出ていなければ監視を終える
          if (!blocked) finish()
          return
        }
        if (blocked || !this.terminalService.hasSession(taskId)) return
        injected = true
        finish()
        void this.runInjectSteps(taskId, steps)
      }

      const unsubReady = this.terminalService.onData(taskId, (data: string) => {
        const clean = stripAnsi(data).replace(/\s+/g, '')
        if (guard) {
          screen = (screen + clean).slice(-4000)
          if (!blocked && guard.blockedBy.test(screen)) {
            blocked = true
            // 解除の判定はダイアログより後の出力だけで行う
            screen = ''
            this.notify?.({
              category: 'session',
              level: 'warning',
              title: '入力待ち',
              body: guard.notice,
              navigation: { type: 'task', taskId },
            })
            return
          }
          if (blocked && guard.unblockedBy.test(screen)) {
            blocked = false
            // ダイアログの選択を動かしたときの再描画が残っていると、次のチャンクで再びブロックしてしまう
            screen = ''
            if (injected) {
              finish()
            } else {
              setTimeout(tryInject, 1000)
            }
            return
          }
        }
        if (blocked) return
        readyScreen = (readyScreen + clean).slice(-4000)
        const ready = provider.readyPattern
          ? provider.readyPattern.test(readyScreen)
          // TUI をレンダリングして入力待ちになると bracketed paste mode を有効化する
          // \x1b[?2004h を検知したタイミングが inject の最適タイミング
          : data.includes('\x1b[?2004h')
        if (!ready) return
        if (injected) {
          // 送るものがない場合は、入力待ちまで来たら guard の監視も終える
          finish()
        } else {
          setTimeout(tryInject, 500)
        }
      })

      // フォールバック: 12秒以内に検知できなければ強制 inject（guard の画面が出ている間は見送る）
      const fallbackTimer = setTimeout(tryInject, 12000)
    }

    this.notifiedThresholds.set(taskId, new Set())
    this.maxContextUsed.set(taskId, 0)
    this.lastEmittedMax.set(taskId, 0)
    this.cleanBuffers.set(taskId, '')

    // stdout パースは Claude Code の表示に合わせたフォールバック。他のエージェントでは誤検知しかしない
    if (provider.parseStdoutContext) {
      this.terminalService.onData(taskId, (data) => {
        const info = this.parseContext(taskId, data)
        if (info) {
          this.fireContextUpdate(info)
        }
      })
    }
  }

  // InjectStep を順に実行する。waitFor が時間内に出なければ以降は送らずに知らせる
  private async runInjectSteps(taskId: string, steps: InjectStep[]): Promise<void> {
    for (const step of steps) {
      if (!this.terminalService.hasSession(taskId)) return
      if ('write' in step) {
        this.terminalService.write(taskId, step.write)
      } else if ('delayMs' in step) {
        await new Promise((r) => setTimeout(r, step.delayMs))
      } else {
        const seen = await this.waitForOutput(taskId, step.waitFor, step.timeoutMs)
        if (!seen) {
          this.notify?.({
            category: 'session',
            level: 'warning',
            title: '入力待ち',
            body: step.notice,
            navigation: { type: 'task', taskId },
          })
          return
        }
      }
    }
  }

  // 呼び出した時点より後の出力（ANSI と空白を除く）に pattern が出るまで待つ
  private waitForOutput(taskId: string, pattern: RegExp, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let buf = ''
      const done = (seen: boolean) => {
        clearTimeout(timer)
        unsub()
        resolve(seen)
      }
      const unsub = this.terminalService.onData(taskId, (data) => {
        buf = (buf + stripAnsi(data).replace(/\s+/g, '')).slice(-4000)
        if (pattern.test(buf)) done(true)
      })
      const timer = setTimeout(() => done(false), timeoutMs)
    })
  }

  // statusline・rollout・regex すべてのソース共通の更新ゲート
  // 前回通知値より大きい場合のみ下流へ流す（サブエージェントや小さいデルタを除去）
  private fireContextUpdate(info: ContextInfo): void {
    const prevMax = this.lastEmittedMax.get(info.taskId) ?? 0
    if (info.used <= prevMax) return
    this.lastEmittedMax.set(info.taskId, info.used)
    for (const cb of this.contextCallbacks) cb(info)
    this.checkThresholds(info)
  }

  parseContext(taskId: string, data: string): ContextInfo | null {
    const clean = stripAnsi(data)

    // チャンク境界でパターンが分断されるのを防ぐため直近500文字をバッファリング
    const prev = this.cleanBuffers.get(taskId) ?? ''
    const buffered = (prev + clean).slice(-500)
    this.cleanBuffers.set(taskId, buffered)
    const searchIn = buffered

    const patterns = [
      // "Context window usage: 75,234 / 100,000 tokens"
      /[Cc]ontext\s+window\s+usage:\s*([\d,]+)\s*\/\s*([\d,]+)\s*tokens/,
      // "Context: 75,234 / 100,000 tokens"
      /[Cc]ontext:\s*([\d,]+)\s*\/\s*([\d,]+)\s*tokens/,
      // "75% (75,234/100,000 tokens)"
      /\d+%\s*\(\s*([\d,]+)\s*\/\s*([\d,]+)\s*tokens?\)/i,
      // "tokens: 75234/100000"
      /tokens?:?\s*([\d,]+)\s*\/\s*([\d,]+)/i,
    ]

    for (const pattern of patterns) {
      const match = searchIn.match(pattern)
      if (match) {
        const used = parseInt(match[1].replace(/,/g, ''), 10)
        const limit = parseInt(match[2].replace(/,/g, ''), 10)
        if (used > 0 && limit > 0 && used <= limit) {
          return { taskId, used, limit }
        }
      }
    }

    // Claude Code status bar format: "↓ 8.6k tokens" or "↓ 239 tokens"
    const deltaMatch = searchIn.match(/↓\s*([\d.]+)(k?)\s*tokens/i)
    if (deltaMatch) {
      const raw = parseFloat(deltaMatch[1])
      const parsed = deltaMatch[2].toLowerCase() === 'k' ? Math.round(raw * 1000) : Math.round(raw)
      const maxPrev = this.maxContextUsed.get(taskId) ?? 0
      const used = Math.max(maxPrev, parsed)
      this.maxContextUsed.set(taskId, used)
      if (used > 0) {
        return { taskId, used, limit: 200000 }
      }
    }

    if (/tokens?/i.test(searchIn)) {
      console.log('[ClaudeService] context parse miss:', JSON.stringify(searchIn.slice(-200)))
    }

    return null
  }

  // セッションローテーション後に呼ぶ。
  // これを呼ばないと lastEmittedMax が旧セッションの高い値のまま張り付き、
  // 新セッションの使用量が全て fireContextUpdate のゲートで捨てられて
  // 閾値判定が二度と発火しなくなる（設計書 §3.1）
  resetContextTracking(taskId: string): void {
    this.lastEmittedMax.set(taskId, 0)
    this.maxContextUsed.set(taskId, 0)
    this.notifiedThresholds.set(taskId, new Set())
    this.cleanBuffers.set(taskId, '')
  }

  onContextUpdate(callback: ContextUpdateCallback): () => void {
    this.contextCallbacks.add(callback)
    return () => {
      this.contextCallbacks.delete(callback)
    }
  }


  private checkThresholds(info: ContextInfo): void {
    const ratio = info.used / info.limit
    const thresholds = this.notifiedThresholds.get(info.taskId)
    if (!thresholds) return

    // rotation 有効タスクは SessionRotationService が通知を持つので二重に出さない
    if (this.isRotationEnabled?.(info.taskId)) return

    const usage = `${info.used.toLocaleString()} / ${info.limit.toLocaleString()}`
    if (ratio >= 0.9 && !thresholds.has(90)) {
      thresholds.add(90)
      this.notify?.({
        category: 'context',
        level: 'warning',
        title: 'コンテキスト警告',
        body: `タスクのコンテキスト使用量が90%を超えました (${usage})`,
        navigation: { type: 'task', taskId: info.taskId },
      })
    } else if (ratio >= 0.8 && !thresholds.has(80)) {
      thresholds.add(80)
      this.notify?.({
        category: 'context',
        level: 'info',
        title: 'コンテキスト注意',
        body: `タスクのコンテキスト使用量が80%を超えました (${usage})`,
        navigation: { type: 'task', taskId: info.taskId },
      })
    }
  }
}
