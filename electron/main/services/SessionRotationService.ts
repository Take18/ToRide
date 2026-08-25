import { Notification, type BrowserWindow } from 'electron'
import fs from 'fs'
import type { TaskService } from './TaskService'
import type { ClaudeService } from './ClaudeService'
import type { TerminalService } from './TerminalService'
import type { StopHookService } from './StopHookService'
import type { GitService } from './GitService'
import type { StartTaskFn } from '../ipc/claude'
import { expandPath } from '../utils/path'
import type { AppSettings, ClaudeModel, ContextInfo, LaunchMode } from '../../../src/types/ipc'
import type { RotationConfig, RotationHistoryEntry, RotationHoldReason, RuntimeTask } from '../../../src/types/task'

// --- 既定値（設計書 §4 / §5） ---
const DEFAULT_THRESHOLD = 60           // %
const MIN_INTERVAL_MS = 10 * 60 * 1000 // 起動から10分未満はローテーションしない
const RATE_WINDOW_MS = 60 * 60 * 1000  // 直近1時間で
const RATE_LIMIT = 3                   // 3回を超えたら自動ローテーション停止
const HANDOFF_TIMEOUT_MS = 600 * 1000  // 指示送信から600秒
const ECHO_WAIT_MS = 200               // 本文 write から \r までの待ち（既存の注入と同じ）
const ECHO_TAIL_LEN = 24               // エコー照合に使う handoffPath 末尾の文字数
const ECHO_FAIL_STREAK_ALERT = 3       // 連続失敗がこの回数に達したら matcher 不具合として別通知
const HANDOFF_SIZE_WARN = 8 * 1024     // handoff がこのサイズを超えたら警告
const BASELINE_RATIO = 0.8             // baseline > threshold * この比率 で自動停止
const ECHO_BUFFER_LEN = 4000           // 自前バッファの保持長

const DEFAULT_HANDOFF_INSTRUCTION = `コンテキスト使用率が {used}% に達しました。
このセッションはまもなく終了し、新しいセッションが同じタスクを引き継ぎます。
会話履歴は引き継がれません。{handoffPath} に書いたものだけが次のセッションに渡ります。

{handoffPath} を「上書きで」書き切ってください（追記ではない）。書く内容:
- 人に投げてあって返答待ちのもの
- 今日だけ有効な決定
- ToRide から読めない補足だけ（タスク一覧・状態・ブランチは書かない）
- 引き継がないもの（意図的に捨てるもの）を明示する
- 「上記のとおり」「先ほどの方針」のような参照表現を使わない。
  handoff だけを読んで意味が通るように書く（会話履歴は渡らないため）
60 行以内。書き終えたらそのまま待機してください。
書き込み先: {handoffPath}`

const DEFAULT_BOOT_PROMPT = `これは同一タスクの {rotationCount} 回目の引き継ぎセッションです（rotation #{rotationCount}）。
前のセッションはコンテキストが埋まったため終了し、あなたが続きを担当します。
最初に {handoffPath} を読んで、続きから再開してください。
前セッションの会話内容は引き継がれていません。handoff に書かれていないことは
「意図的に捨てられた」と判断してよく、掘り返す必要はありません。`

type Phase = 'idle' | 'awaiting_handoff'

type TaskState = {
  phase: Phase
  /** 指示を送信した時刻（mtime 比較の基準 T） */
  instructionSentAt: number
  unsubStop?: () => void
  timeoutId?: ReturnType<typeof setTimeout>
  /** エコー検証の連続失敗回数。3回連続なら matcher の不具合を疑う */
  echoFailStreak: number
  /** このセッションが起動した時刻（最小間隔ガード用） */
  sessionStartedAt: number
  /** ローテーション直後で baseline 未計測か */
  awaitingBaseline: boolean
  unsubBaseline?: () => void
  /** 自前のエコー検証用バッファ（ClaudeService.cleanBuffers は resetContextTracking で消えるため使わない） */
  echoBuffer: string
  unsubEchoBuffer?: () => void
}

export type RotationStatus = {
  enabled: boolean
  threshold: number
  handoffPath?: string
  usedPercent?: number
  rotationCount: number
  history: RotationHistoryEntry[]
  pending: boolean
  holdReason?: RotationHoldReason
  holdMessage?: string
  baseline?: number
  disabledReason?: string
}

type Deps = {
  taskService: TaskService
  claudeService: ClaudeService
  terminalService: TerminalService
  stopHookService: StopHookService
  gitService: GitService
  getSettings: () => AppSettings
  getWindow: () => BrowserWindow | null
  startTask: StartTaskFn
}

/** 空白・改行をすべて除去して照合用に正規化する（TUI の行折り返しを吸収するため） */
const normalize = (s: string): string => s.replace(/\s+/g, '')

/** ANSI エスケープを落とす（ClaudeService.parseContext と同じ処理） */
const stripAnsi = (s: string): string =>
  s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\r/g, '')

const interpolate = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{([^}]+)\}/g, (m, k: string) => vars[k] ?? m)

export class SessionRotationService {
  private deps: Deps
  private states = new Map<string, TaskState>()

  constructor(deps: Deps) {
    this.deps = deps
  }

  // ---------- 設定解決（task → rotationDefaults → ハードコード既定値のキー単位フォールバック） ----------

  resolveConfig(task: RuntimeTask): Required<Pick<RotationConfig, 'enabled' | 'threshold'>> & {
    handoffPath?: string
    bootPrompt?: string
  } {
    const d = this.deps.getSettings().rotationDefaults ?? {}
    const t = task.rotation ?? {}
    return {
      enabled: t.enabled ?? d.enabled ?? false,
      threshold: t.threshold ?? d.threshold ?? DEFAULT_THRESHOLD,
      handoffPath: t.handoffPath ?? d.handoffPath,
      bootPrompt: t.bootPrompt ?? d.bootPrompt,
    }
  }

  /** ClaudeService の 80/90% 通知抑制判定に使う */
  isRotationEnabled(taskId: string): boolean {
    const task = this.deps.taskService.list().find((t) => t.id === taskId)
    if (!task) return false
    return this.resolveConfig(task).enabled
  }

  getStatus(taskId: string): RotationStatus | null {
    const task = this.deps.taskService.list().find((t) => t.id === taskId)
    if (!task) return null
    const cfg = this.resolveConfig(task)
    const history = task.rotation?.history ?? []
    const usedPercent =
      task.contextUsed && task.contextLimit
        ? Math.round((task.contextUsed / task.contextLimit) * 100)
        : undefined
    return {
      enabled: cfg.enabled,
      threshold: cfg.threshold,
      handoffPath: cfg.handoffPath,
      usedPercent,
      rotationCount: history.length,
      history,
      pending: task.rotationPending ?? false,
      holdReason: task.rotationHoldReason,
      holdMessage: task.rotationHoldMessage,
      baseline: task.rotationBaseline,
      disabledReason: task.rotationDisabledReason,
    }
  }

  // ---------- コンテキスト更新の受け口 ----------

  onContextUpdate(info: ContextInfo): void {
    const task = this.deps.taskService.list().find((t) => t.id === info.taskId)
    if (!task || task.status !== 'doing') return
    const cfg = this.resolveConfig(task)
    if (!cfg.enabled || !cfg.handoffPath) return

    const state = this.getState(task)
    if (state.phase !== 'idle') return
    if (task.rotationPending) return           // 人の操作待ち
    if (task.rotationDisabledReason) return    // ガード作動で自動停止中

    const percent = (info.used / info.limit) * 100
    if (percent < cfg.threshold) return

    // --- ガード（症状側 §5.4） ---
    if (Date.now() - state.sessionStartedAt < MIN_INTERVAL_MS) {
      this.hold(task.id, 'min_interval',
        `起動から10分未満のためローテーションを見送りました（使用率 ${Math.round(percent)}%）。旧セッションは動いています。`)
      return
    }
    const recent = (task.rotation?.history ?? []).filter(
      (h) => Date.now() - new Date(h.at).getTime() < RATE_WINDOW_MS
    )
    if (recent.length >= RATE_LIMIT) {
      this.disableAuto(task.id,
        `直近1時間に ${recent.length} 回ローテーションしたため自動ローテーションを停止しました。handoff の内容を確認してください。`)
      return
    }

    void this.beginRotation(task.id, 'threshold', Math.round(percent))
  }

  // ---------- ローテーション本体 ----------

  /** 手動実行（保留中のタスクを人が進めるとき）。ガードは人の判断を優先して無視する */
  async rotateNow(taskId: string): Promise<void> {
    const task = this.deps.taskService.list().find((t) => t.id === taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)
    if (task.status !== 'doing') throw new Error('ROTATION_TASK_NOT_RUNNING')
    const state = this.getState(task)
    if (state.phase !== 'idle') throw new Error('ROTATION_ALREADY_IN_PROGRESS')
    const percent =
      task.contextUsed && task.contextLimit
        ? Math.round((task.contextUsed / task.contextLimit) * 100)
        : 0
    // 手動実行はガード解除の意思表示でもあるので、停止フラグも落とす
    this.deps.taskService.update(taskId, {
      rotationPending: false,
      rotationHoldReason: undefined,
      rotationHoldMessage: undefined,
      rotationDisabledReason: undefined,
    })
    await this.beginRotation(taskId, 'manual', percent)
  }

  private async beginRotation(taskId: string, reason: 'threshold' | 'manual', percent: number): Promise<void> {
    const task = this.deps.taskService.list().find((t) => t.id === taskId)
    if (!task) return
    const cfg = this.resolveConfig(task)
    const handoffPath = expandPath(cfg.handoffPath ?? '')
    if (!handoffPath) return

    // --- §5.3 working tree の状態チェック ---
    if ('branch' in task && task.branch && task.workdir) {
      const status = await this.deps.gitService.status(task.workdir)
      if (!status.error && status.modified > 0 && status.branch !== task.branch) {
        this.hold(taskId, 'dirty_worktree',
          `未コミット変更があり、現在のブランチ（${status.branch}）がタスクのブランチ（${task.branch}）と異なるためローテーションを中止しました。旧セッションは停止していません。`)
        return
      }
    }

    if (!this.deps.terminalService.hasSession(taskId)) return

    const state = this.getState(task)
    const instruction = interpolate(
      this.deps.getSettings().rotationHandoffInstruction ?? DEFAULT_HANDOFF_INSTRUCTION,
      { used: String(percent), handoffPath }
    )

    // --- normal / plan は人が張り付く前提のモード。idle を待ってから write（二重の防御） ---
    const launchMode = task.lastLaunchMode as LaunchMode | undefined
    const needsIdleWait = launchMode === 'normal' || launchMode === 'plan'
    if (needsIdleWait) {
      await this.waitForIdle(taskId)
      if (!this.deps.terminalService.hasSession(taskId)) return
    }

    // --- 本文 write → エコー検証 → \r ---
    // ここから write までの間に await を挟まないこと。
    // startEchoBuffer がバッファを空にするので、照合対象は「この write 以降に受信したデータ」だけになる。
    // await を挟むと前ターンの残骸が混入し、入力欄に入っていないのに照合が通る偽陽性が起きる
    // （＝対話プロンプト表示中に \r を送ってしまう）
    this.startEchoBuffer(taskId, state)
    state.instructionSentAt = Date.now()
    this.deps.terminalService.write(taskId, instruction)
    await new Promise((r) => setTimeout(r, ECHO_WAIT_MS))

    const echoed = this.verifyEcho(state, handoffPath, instruction)
    this.stopEchoBuffer(state)
    if (!echoed) {
      state.echoFailStreak += 1
      if (state.echoFailStreak >= ECHO_FAIL_STREAK_ALERT) {
        this.notify(taskId, 'ローテーション: 照合ロジックの不具合の可能性',
          `エコー検証が ${state.echoFailStreak} 回連続で失敗しました。TUI の状態ではなく照合ロジックが壊れている可能性があります。旧セッションは停止していません。`)
      }
      this.hold(taskId, 'echo_unverified',
        '指示文が入力欄に表示されなかったため Enter を送りませんでした（対話プロンプト表示中の可能性）。旧セッションは停止していません。')
      return
    }
    state.echoFailStreak = 0
    this.deps.terminalService.write(taskId, '\r')

    // --- 完了検知: Stop Hook 発火 ∧ ファイル存在 ∧ mtime > T ---
    state.phase = 'awaiting_handoff'
    state.unsubStop = this.deps.stopHookService.onTaskComplete(taskId, () => {
      if (state.phase !== 'awaiting_handoff') return
      if (!this.isHandoffWritten(handoffPath, state.instructionSentAt)) return
      void this.finishRotation(taskId, reason, percent, handoffPath)
    })
    state.timeoutId = setTimeout(() => {
      if (state.phase !== 'awaiting_handoff') return
      this.clearWaiting(state)
      state.phase = 'idle'
      this.hold(taskId, 'handoff_timeout',
        `${Math.round(HANDOFF_TIMEOUT_MS / 1000)}秒以内に handoff の書き込みを確認できませんでした。旧セッションは停止しておらず、生きたまま保留しています。タスクカードから手動でローテーションを実行できます。`)
    }, HANDOFF_TIMEOUT_MS)
  }

  private async finishRotation(
    taskId: string,
    reason: 'threshold' | 'manual',
    percent: number,
    handoffPath: string
  ): Promise<void> {
    const state = this.states.get(taskId)
    if (!state || state.phase !== 'awaiting_handoff') return
    this.clearWaiting(state)
    state.phase = 'idle'

    const task = this.deps.taskService.list().find((t) => t.id === taskId)
    if (!task) return
    const cfg = this.resolveConfig(task)

    // handoff の肥大は原因側のサイン（§5.5）
    try {
      const size = fs.statSync(handoffPath).size
      if (size > HANDOFF_SIZE_WARN) {
        this.notify(taskId, 'ローテーション: handoff が肥大しています',
          `${handoffPath} が ${Math.round(size / 1024)}KB あります。60行以内に収まるよう書き方を見直してください。`)
      }
    } catch {
      // サイズが取れなくてもローテーション自体は続行する
    }

    const fromSessionId = task.sessionId ?? ''
    const history = task.rotation?.history ?? []
    const rotationCount = history.length + 1

    // 旧セッションを停止
    this.deps.stopHookService.removeTaskCallback(taskId)
    this.deps.terminalService.kill(taskId)
    // これを呼ばないと新セッションの使用量が全て更新ゲートで捨てられる（§3.1）
    this.deps.claudeService.resetContextTracking(taskId)
    this.deps.taskService.update(taskId, { contextUsed: 0, contextLimit: 0 })

    const bootPrompt = interpolate(cfg.bootPrompt ?? DEFAULT_BOOT_PROMPT, {
      handoffPath,
      rotationCount: String(rotationCount),
    })

    try {
      await this.deps.startTask(
        taskId,
        task.lastLaunchMode as LaunchMode | undefined,
        task.lastModel as ClaudeModel | undefined,
        { skipCheckout: true, extraPrompt: bootPrompt }
      )
    } catch (e) {
      this.notify(taskId, 'ローテーション: 新セッションの起動に失敗',
        `旧セッションは既に停止しています。手動で起動し直してください: ${(e as Error).message}`)
      return
    }

    const next = this.deps.taskService.list().find((t) => t.id === taskId)
    const entry: RotationHistoryEntry = {
      at: new Date().toISOString(),
      fromSessionId,
      toSessionId: next?.sessionId ?? '',
      reason,
      usedPercentAtTrigger: percent,
    }
    this.deps.taskService.update(taskId, {
      rotation: { ...(task.rotation ?? {}), history: [...history, entry] },
      rotationPending: false,
      rotationHoldReason: undefined,
      rotationHoldMessage: undefined,
      rotationBaseline: undefined,
    })

    // 新セッションの起動時刻を記録し、最初のターン終了で baseline を計測する（§5.5）
    const fresh = this.getState(next ?? task)
    fresh.sessionStartedAt = Date.now()
    fresh.phase = 'idle'
    this.scheduleBaselineMeasurement(taskId, cfg.threshold)

    this.notifyTasksUpdated()
  }

  // ---------- baseline 計測（原因側ガード §5.5） ----------

  private scheduleBaselineMeasurement(taskId: string, threshold: number): void {
    const state = this.states.get(taskId)
    if (!state) return
    state.awaitingBaseline = true
    state.unsubBaseline?.()
    // 最初のターンが終わった時点＝ handoff を読み込み終えた時点の使用率を baseline とする
    state.unsubBaseline = this.deps.stopHookService.onTaskComplete(taskId, () => {
      if (!state.awaitingBaseline) return
      state.awaitingBaseline = false
      state.unsubBaseline?.()
      state.unsubBaseline = undefined

      const task = this.deps.taskService.list().find((t) => t.id === taskId)
      if (!task?.contextUsed || !task.contextLimit) return
      const baseline = Math.round((task.contextUsed / task.contextLimit) * 100)
      this.deps.taskService.update(taskId, { rotationBaseline: baseline })
      if (baseline > threshold * BASELINE_RATIO) {
        this.disableAuto(taskId,
          `新セッション開始時点の使用率が ${baseline}%（閾値 ${threshold}% の ${Math.round(BASELINE_RATIO * 100)}% 超）でした。handoff が肥大しているため自動ローテーションを停止しました。`)
      }
      this.notifyTasksUpdated()
    })
  }

  // ---------- 補助 ----------

  private getState(task: RuntimeTask): TaskState {
    let state = this.states.get(task.id)
    if (!state) {
      state = {
        phase: 'idle',
        instructionSentAt: 0,
        echoFailStreak: 0,
        sessionStartedAt: task.startedAt ? new Date(task.startedAt).getTime() : Date.now(),
        awaitingBaseline: false,
        echoBuffer: '',
      }
      this.states.set(task.id, state)
    }
    return state
  }

  private waitForIdle(taskId: string): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        unsub()
        clearTimeout(timer)
        resolve()
      }
      const unsub = this.deps.stopHookService.onTaskComplete(taskId, finish)
      // idle が来なくても保留通知に合流できるよう、待ち続けはしない
      const timer = setTimeout(finish, HANDOFF_TIMEOUT_MS)
    })
  }

  private startEchoBuffer(taskId: string, state: TaskState): void {
    state.echoBuffer = ''
    state.unsubEchoBuffer?.()
    state.unsubEchoBuffer = this.deps.terminalService.onData(taskId, (data) => {
      state.echoBuffer = (state.echoBuffer + stripAnsi(data)).slice(-ECHO_BUFFER_LEN)
    })
  }

  private stopEchoBuffer(state: TaskState): void {
    state.unsubEchoBuffer?.()
    state.unsubEchoBuffer = undefined
  }

  /**
   * 本文が入力欄にエコーされたかを検証する。
   * 照合対象は日本語本文ではなく handoffPath（ASCII）の末尾。
   * CJK は TUI 上で全角幅として描画され、折り返し位置の計算が半角と異なるため照合対象から外す。
   * 折り返しを吸収するため、両側から空白・改行をすべて除去してから照合する。
   */
  private verifyEcho(state: TaskState, handoffPath: string, instruction: string): boolean {
    const needle = normalize(handoffPath).slice(-ECHO_TAIL_LEN)
    if (!needle) return false
    const haystack = normalize(state.echoBuffer)
    const matched = haystack.includes(needle)

    // 閾値(ECHO_TAIL_LEN)は実測で決める必要があるため、判定に使った材料をそのまま残す。
    // occurrences: 指示文にはパスが2回現れるので、1回だけなら別の出力に由来する疑いがある
    console.log('[SessionRotation] echo check:', JSON.stringify({
      matched,
      needle,
      occurrences: haystack.split(needle).length - 1,
      bufferLen: haystack.length,
      instructionLen: normalize(instruction).length,
      bufferTail: haystack.slice(-200),
    }))

    return matched
  }

  private isHandoffWritten(handoffPath: string, sentAt: number): boolean {
    try {
      const stat = fs.statSync(handoffPath)
      return stat.mtimeMs > sentAt
    } catch {
      return false
    }
  }

  private clearWaiting(state: TaskState): void {
    state.unsubStop?.()
    state.unsubStop = undefined
    if (state.timeoutId) clearTimeout(state.timeoutId)
    state.timeoutId = undefined
    this.stopEchoBuffer(state)
  }

  /** 自動で進めず人に委ねる。旧セッションは絶対に kill しない */
  private hold(taskId: string, reason: RotationHoldReason, message: string): void {
    this.deps.taskService.update(taskId, {
      rotationPending: true,
      rotationHoldReason: reason,
      rotationHoldMessage: message,
    })
    this.notify(taskId, 'ローテーション保留', message)
    this.notifyTasksUpdated()
  }

  /** ガード作動による自動ローテーションの停止 */
  private disableAuto(taskId: string, message: string): void {
    this.deps.taskService.update(taskId, { rotationDisabledReason: message })
    this.notify(taskId, 'ローテーション停止', message)
    this.notifyTasksUpdated()
  }

  /**
   * 保留・停止・中止の通知は必ず出す。
   * 80/90% の通知を抑制している以上、無音が「正常」を意味してしまうのが最も危険なため。
   */
  private notify(taskId: string, title: string, body: string): void {
    if (!(this.deps.getSettings().notificationsEnabled ?? true)) return
    const n = new Notification({ title, body, urgency: 'critical' })
    n.on('click', () => {
      const win = this.deps.getWindow()
      win?.show()
      win?.focus()
      win?.webContents.send('navigation:goto', { type: 'task', taskId })
    })
    n.show()
  }

  private notifyTasksUpdated(): void {
    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('tasks:updated')
  }

  /** タスク停止時のクリーンアップ */
  clear(taskId: string): void {
    const state = this.states.get(taskId)
    if (!state) return
    this.clearWaiting(state)
    state.unsubBaseline?.()
    this.states.delete(taskId)
  }
}