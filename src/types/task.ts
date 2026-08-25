// タスク型定義（テンプレートリテラル型を除去したシンプルな型）

export type TaskStatus = 'will_do' | 'doing' | 'done'
export type TaskType = 'feat' | 'design' | 'review' | 'bugfix' | 'research' | 'chore' | 'orchestrate'

// セッションローテーション設定
// コンテキスト使用率が threshold に達したら、handoff ファイルに引き継ぎを書かせてから
// セッションを作り直す（compact ではなく作り直しにすることで「底が上がる」のを防ぐ）
export type RotationConfig = {
  enabled?: boolean       // 既定 false（短命タスクには不要なので opt-in）
  threshold?: number      // 既定 60（%）handoff を書き切る余裕を残す
  handoffPath?: string    // enabled 時は必須
  bootPrompt?: string     // 新セッションへの追記文面。省略時はデフォルト
  history?: RotationHistoryEntry[]
}

export type RotationHistoryEntry = {
  at: string  // ISO8601
  fromSessionId: string
  toSessionId: string
  reason: 'threshold' | 'manual'
  usedPercentAtTrigger: number
}

// ローテーションが自動で進めず保留になった理由
// echo_unverified だけは matcher の不具合の可能性があるため個別に集計する
export type RotationHoldReason =
  | 'echo_unverified'   // 本文が入力欄にエコーされず \r を送れなかった（対話プロンプト表示中の疑い）
  | 'handoff_timeout'   // 指示は届いたが handoff の書き込みを確認できないまま時間切れ
  | 'dirty_worktree'    // working tree が dirty かつブランチ不一致
  | 'min_interval'      // 前回ローテーションから最小間隔が経過していない
  | 'rate_limited'      // 直近1時間のローテーション回数が上限
  | 'baseline_too_high' // 起動直後のベースラインが高すぎる（handoff 肥大）

// ローテーションのランタイム状態（DB の task_runtime で管理。再起動でクリアされる）
export type RotationRuntime = {
  rotationPending?: boolean            // 保留中（人の操作待ち）
  rotationHoldReason?: RotationHoldReason
  rotationHoldMessage?: string
  rotationBaseline?: number            // 起動直後に計測した使用率(%)
  rotationDisabledReason?: string      // 自動ローテーションを停止した理由（ガード作動）
}

export type BaseTask = {
  id: string
  prompt?: string
  status: TaskStatus
  depends_on?: string
  pane: string
  repoId?: string
  title: string
  created_at?: string
  sessionId?: string  // Claude session ID (for --resume)
  prUrl?: string      // GitHub PR URL (auto-detected from terminal output)
  images?: string[]   // 添付画像の保存先パス（userData/task-images 配下）
  rotation?: RotationConfig  // セッションローテーション設定
  // 直近の起動に使った実効パラメータ。セッションローテーションで同じ条件で起動し直すために保存する。
  // lastLaunchMode は「normal/plan では \r 送信前に idle を待つ」判定にも使う
  lastLaunchMode?: string
  lastModel?: string
}

export type DesignTask = {
  type: 'design'
  output: string
} & BaseTask

export type FeatureTask = {
  type: 'feat'
  branch: string
  baseBranch?: string  // 分岐元ブランチ
  prompt?: string
  ticket: string  // Wrike ticket URL
} & BaseTask

export type ReviewTask = {
  type: 'review'
  url: string  // GitHub PR URL
  prStatus?: 'open' | 'draft' | 'merged' | 'closed'
} & BaseTask

export type BugfixTask = {
  type: 'bugfix'
  branch: string
  baseBranch?: string  // 分岐元ブランチ
  ticket: string  // Wrike ticket URL
} & BaseTask

export type ResearchTask = {
  type: 'research'
  branch: string
  prompt: string
} & BaseTask

export type ChoreTask = {
  type: 'chore'
  directory: string
} & BaseTask

export type OrchestrateTask = {
  type: 'orchestrate'
  directory?: string  // optional workdir (defaults to home dir)
} & BaseTask

export type Task = DesignTask | FeatureTask | ReviewTask | BugfixTask | ResearchTask | ChoreTask | OrchestrateTask

// ユニオン型に対してOmitを分配適用するユーティリティ型
export type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never

// ランタイム状態（DB の task_runtime テーブルで管理）
export type RuntimeTaskState = {
  pid?: number
  workdir?: string
  contextUsed?: number
  contextLimit?: number
  startedAt?: string | null
  completedAt?: string | null
  isArchived?: boolean
} & RotationRuntime

export type RuntimeTask = Task & RuntimeTaskState

// アーカイブエントリ
export type ArchiveEntry = {
  id: string
  task_data: RuntimeTask
  archived_at: string
}
