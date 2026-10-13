import fs from 'fs'
import { StringDecoder } from 'string_decoder'
import type { ContextInfo } from '../../../src/types/ipc'

// fs.watch の取りこぼしと、SessionStart 時点でまだファイルが無い場合に備えた確認の間隔
const POLL_INTERVAL_MS = 2000
// 1回に読む上限。初回は再開したセッションの rollout を頭から読むことになるため、分けて読む
const READ_CHUNK_BYTES = 1024 * 1024

type Watch = {
  path: string
  offset: number
  /** チャンクの境目でマルチバイト文字が切れても化けないよう、未完成のバイトを持ち越す */
  decoder: StringDecoder
  /** 行の途中で切れたチャンクの残り。次に読んだ分の先頭につなげる */
  partial: string
  /** token_count に model_context_window が無いときに使う（task_started の値） */
  limit?: number
  watcher?: fs.FSWatcher
  timer: ReturnType<typeof setInterval>
  reading: boolean
  /** 読んでいる間に変更が来たら、読み終えたあともう一度読む */
  dirty: boolean
}

type TokenUsage = { total_tokens?: number }

type RolloutLine = {
  type?: string
  payload?: {
    type?: string
    model_context_window?: number
    info?: { last_token_usage?: TokenUsage; model_context_window?: number } | null
  }
}

// Codex が会話を書き出す rollout ファイル（JSONL）を tail してコンテキスト使用量を取り出す。
// Codex には Claude Code の statusline に当たるコマンド型のフックが無いため、これが主系になる
export class TranscriptContextService {
  private watches = new Map<string, Watch>()
  private callbacks = new Set<(info: ContextInfo) => void>()

  /** 同じタスクの tail があれば止めてから、ファイルの先頭から読み直す */
  watch(taskId: string, filePath: string): void {
    this.stop(taskId)
    const w: Watch = {
      path: filePath,
      offset: 0,
      decoder: new StringDecoder('utf8'),
      partial: '',
      timer: setInterval(() => this.read(taskId, w), POLL_INTERVAL_MS),
      reading: false,
      dirty: false,
    }
    this.watches.set(taskId, w)
    this.read(taskId, w)
  }

  stop(taskId: string): void {
    const w = this.watches.get(taskId)
    if (!w) return
    clearInterval(w.timer)
    w.watcher?.close()
    this.watches.delete(taskId)
  }

  stopAll(): void {
    for (const taskId of [...this.watches.keys()]) this.stop(taskId)
  }

  onContextUpdate(cb: (info: ContextInfo) => void): () => void {
    this.callbacks.add(cb)
    return () => this.callbacks.delete(cb)
  }

  private ensureWatcher(taskId: string, w: Watch): void {
    if (w.watcher) return
    try {
      w.watcher = fs.watch(w.path, () => this.read(taskId, w))
      w.watcher.on('error', () => {
        // ファイルが置き換えられた場合など。次の確認で張り直す
        w.watcher?.close()
        w.watcher = undefined
      })
    } catch {
      // まだファイルが無い。次の確認で張る
    }
  }

  private read(taskId: string, w: Watch): void {
    if (this.watches.get(taskId) !== w) return
    if (w.reading) {
      w.dirty = true
      return
    }
    let size: number
    try {
      size = fs.statSync(w.path).size
    } catch {
      return
    }
    this.ensureWatcher(taskId, w)
    if (size < w.offset) {
      // 切り詰められた（置き換えられた）ので頭から読み直す
      w.offset = 0
      w.decoder = new StringDecoder('utf8')
      w.partial = ''
    }
    if (size === w.offset) return

    w.reading = true
    const length = Math.min(size - w.offset, READ_CHUNK_BYTES)
    const buf = Buffer.alloc(length)
    fs.open(w.path, 'r', (openErr, fd) => {
      if (openErr) {
        w.reading = false
        return
      }
      fs.read(fd, buf, 0, length, w.offset, (readErr, bytesRead) => {
        fs.close(fd, () => {})
        w.reading = false
        if (this.watches.get(taskId) !== w) return
        if (!readErr && bytesRead > 0) {
          w.offset += bytesRead
          this.consume(taskId, w, w.decoder.write(buf.subarray(0, bytesRead)))
        }
        // 読み残しがあるか、読んでいる間に変更が来たら続けて読む
        if (w.dirty || w.offset < size) {
          w.dirty = false
          this.read(taskId, w)
        }
      })
    })
  }

  private consume(taskId: string, w: Watch, chunk: string): void {
    const text = w.partial + chunk
    const lastNewline = text.lastIndexOf('\n')
    // 行の途中で切れた分は次回に回す
    w.partial = lastNewline === -1 ? text : text.slice(lastNewline + 1)
    if (lastNewline === -1) return

    // まとめて読んだときは最後の値だけを流す（再開時に頭から読むと過去のターンの分だけ発火してしまう）
    let latest: ContextInfo | null = null
    for (const line of text.slice(0, lastNewline).split('\n')) {
      const info = this.parseLine(taskId, w, line)
      if (info) latest = info
    }
    if (!latest) return
    for (const cb of [...this.callbacks]) {
      try {
        cb(latest)
      } catch (e) {
        console.error('[TranscriptContextService] callback failed:', e)
      }
    }
  }

  private parseLine(taskId: string, w: Watch, line: string): ContextInfo | null {
    // token_count / task_started 以外は JSON.parse しない（巨大な response_item 行が多いため）
    if (!line.includes('"token_count"') && !line.includes('"task_started"')) return null
    let parsed: RolloutLine
    try {
      parsed = JSON.parse(line) as RolloutLine
    } catch {
      return null
    }
    if (parsed.type !== 'event_msg' || !parsed.payload) return null
    const { payload } = parsed
    if (payload.type === 'task_started') {
      if (payload.model_context_window) w.limit = payload.model_context_window
      return null
    }
    if (payload.type !== 'token_count' || !payload.info) return null
    // total_token_usage はセッション全体の累計なので使わない。
    // 直近ターンの last_token_usage.total_tokens（input + output。cached は input に含まれる）が
    // 次のターンでコンテキストに載る量になる
    const used = payload.info.last_token_usage?.total_tokens
    const limit = payload.info.model_context_window ?? w.limit
    if (payload.info.model_context_window) w.limit = payload.info.model_context_window
    if (!used || !limit) return null
    return { taskId, used, limit }
  }
}
