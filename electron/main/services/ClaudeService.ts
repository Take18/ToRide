import type { TerminalService } from './TerminalService'
import type { ContextLineService } from './ContextLineService'
import type { ClaudeModel, ContextInfo, LaunchMode } from '../../../src/types/ipc'
import type { NotifyInput } from './NotificationService'

export type ContextUpdateCallback = (info: ContextInfo) => void

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
    contextLineService?.onContextUpdate((info) => {
      this.fireContextUpdate(info)
    })
  }

  start(taskId: string, workdir: string, prompt?: string, launchMode?: LaunchMode, cols?: number, rows?: number, sessionId?: string, resumeSessionId?: string, model?: ClaudeModel): void {
    this.terminalService.start(taskId, workdir, cols ?? 120, rows ?? 30, { CLAUDE_TASK_ID: taskId })
    let claudeArgs = ''
    if (launchMode === 'bypass') {
      claudeArgs += ' --dangerously-skip-permissions'
    } else if (launchMode === 'auto') {
      claudeArgs += ' --permission-mode auto'
    } else if (launchMode === 'plan') {
      claudeArgs += ' --permission-mode plan'
    }
    if (model && model !== 'default') claudeArgs += ` --model ${model}`
    if (resumeSessionId) claudeArgs += ` --resume ${resumeSessionId}`
    else if (sessionId) claudeArgs += ` --session-id ${sessionId}`
    const claudeCmd = `claude${claudeArgs}\n`
    this.terminalService.write(taskId, claudeCmd)

    if (!resumeSessionId && prompt) {
      let injected = false

      const tryInject = () => {
        if (injected || !this.terminalService.hasSession(taskId)) return
        injected = true
        unsubReady()
        // テキストと Enter を分けて送ることで TUI がテキストを input field に
        // レンダリングした後に \r (Enter) が届くようにする
        this.terminalService.write(taskId, prompt)
        setTimeout(() => {
          if (this.terminalService.hasSession(taskId)) {
            this.terminalService.write(taskId, '\r')
          }
        }, 200)
      }

      // Claude Code が TUI をレンダリングして入力待ちになると bracketed paste mode を有効化する
      // \x1b[?2004h を検知したタイミングが inject の最適タイミング
      const unsubReady = this.terminalService.onData(taskId, (data: string) => {
        if (injected) return
        if (data.includes('\x1b[?2004h')) {
          setTimeout(tryInject, 500)
        }
      })

      // フォールバック: 12秒以内に検知できなければ強制 inject
      setTimeout(tryInject, 12000)
    }

    this.notifiedThresholds.set(taskId, new Set())
    this.maxContextUsed.set(taskId, 0)
    this.lastEmittedMax.set(taskId, 0)
    this.cleanBuffers.set(taskId, '')

    this.terminalService.onData(taskId, (data) => {
      const info = this.parseContext(taskId, data)
      if (info) {
        this.fireContextUpdate(info)
      }
    })
  }

  // statusline・regex 両ソース共通の更新ゲート
  // 前回通知値より大きい場合のみ下流へ流す（サブエージェントや小さいデルタを除去）
  private fireContextUpdate(info: ContextInfo): void {
    const prevMax = this.lastEmittedMax.get(info.taskId) ?? 0
    if (info.used <= prevMax) return
    this.lastEmittedMax.set(info.taskId, info.used)
    for (const cb of this.contextCallbacks) cb(info)
    this.checkThresholds(info)
  }

  parseContext(taskId: string, data: string): ContextInfo | null {
    // ANSIエスケープシーケンスを除去
    const clean = data
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')               // CSI sequences
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC (BEL or ST terminator)
      .replace(/\x1b[()][AB012]/g, '')                       // charset sequences
      .replace(/\r/g, '')                                    // CR

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
