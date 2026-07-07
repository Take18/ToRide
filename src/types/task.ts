// タスク型定義（テンプレートリテラル型を除去したシンプルな型）

export type TaskStatus = 'will_do' | 'doing' | 'done'
export type TaskType = 'feat' | 'design' | 'review' | 'bugfix' | 'research' | 'chore' | 'orchestrate'

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
}

export type RuntimeTask = Task & RuntimeTaskState

// アーカイブエントリ
export type ArchiveEntry = {
  id: string
  task_data: RuntimeTask
  archived_at: string
}
