import type { Task, RuntimeTask, ArchiveEntry, RuntimeTaskState, DistributiveOmit } from './task'
import type { TicketProviderMeta, TicketFetchResult, PluginCatalogEntry } from './plugin'

// pane設定
export type DevServerConfig = {
  label: string
  command: string
  args: string[]
  // ポート番号（例: "3000"）またはローカル環境のURL（例: "https://localhost.example.test:3000"）
  url?: string
}

export type PaneConfig = {
  id: string
  path: string
  devServers: DevServerConfig[]
}

export type RepoConfig = {
  id: string
  name: string
  panes: PaneConfig[]
}

// Claude起動モード
export type LaunchMode = 'normal' | 'auto' | 'bypass' | 'plan'

// Claude起動モデル。'default' は --model 指定なし、それ以外はエイリアスまたはフルモデルID
// （一覧は /v1/models から動的取得。取得失敗時は opus/sonnet/haiku にフォールバック）
export type ClaudeModel = 'default' | (string & {})

// アプリ設定
export type AppSettings = {
  repos: RepoConfig[]
  githubPat?: string  // safeStorageで暗号化して保存
  githubUsername?: string  // GitHub ユーザー名（PR自動同期用）
  githubPrSyncIntervalMin?: number  // PR同期間隔（分、デフォルト5）
  useDangerouslySkipPermissions?: boolean  // claude --dangerously-skip-permissions で起動するか
  useAutoMode?: boolean  // claude --permission-mode auto で起動するか
  promptTemplates?: Record<string, string>  // タスクタイプ別プロンプトテンプレート
  backgroundImageDir?: string  // 背景画像ディレクトリ
  backgroundIntervalSec?: number  // スライドショー間隔（秒）
  notificationsEnabled?: boolean  // デスクトップ通知を有効にするか（デフォルト: true）
  stopHookPort?: number  // Stop Hook HTTPサーバーのポート（デフォルト: 39457）
  pluginSettings?: Record<string, Record<string, string>>  // チケットプラグイン設定（暗号化フィールドはsafeStorage管理）
  enabledPlugins?: string[]  // 有効なプラグインIDの一覧
  extraPaths?: string[]  // git hooks等の子プロセスに追加するPATHエントリ
  orchestrateSystemPrompt?: string  // orchestrateタスク起動時に先頭に付与するシステムプロンプト
}

// Git status
export type GitStatusResult = {
  branch: string
  ahead: number
  behind: number
  modified: number
  error?: string
}

// Dev server status
export type DevServerStatus = {
  repoId: string
  paneId: string
  label: string
  running: boolean
  pid?: number
  url?: string  // resolveDevServerUrl で解決済みのURL
}

// Terminal data event
export type TerminalDataEvent = {
  taskId: string
  data: string
}

// Context parsed from Claude output
export type ContextInfo = {
  taskId: string
  used: number
  limit: number
}

// IPC チャンネル定義（型安全のため）
export type IpcChannels = {
  // Tasks
  'tasks:list': [void, RuntimeTask[]]
  'tasks:create': [DistributiveOmit<Task, 'id' | 'created_at'>, RuntimeTask]
  'tasks:update': [{ id: string; data: Partial<Task & RuntimeTaskState> }, RuntimeTask]
  'tasks:delete': [string, void]
  'tasks:archive': [string, void]
  'tasks:list-archived': [void, ArchiveEntry[]]
  'tasks:delete-archived': [string, void]
  'tasks:archive-all-done': [void, number]
  'tasks:delete-all-archived': [void, number]
  'tasks:restore-archived': [string, RuntimeTask]

  // Terminal
  'terminal:start': [{ taskId: string; workdir: string }, void]
  'terminal:write': [{ taskId: string; data: string }, void]
  'terminal:kill': [string, void]
  'terminal:resize': [{ taskId: string; cols: number; rows: number }, void]

  // Git
  'git:status': [string, GitStatusResult]
  'git:branches': [string, string[]]

  // Claude
  'claude:start': [{ taskId: string; workdir: string; prompt?: string; cols?: number; rows?: number; launchMode?: LaunchMode; model?: ClaudeModel }, void]
  'claude:resume': [{ taskId: string; cols?: number; rows?: number; launchMode?: LaunchMode; model?: ClaudeModel }, void]
  'claude:list-models': [void, string[]]

  // Dev Server
  'devserver:start': [{ repoId: string; paneId: string; label: string }, void]
  'devserver:stop': [{ repoId: string; paneId: string; label: string }, void]
  'devserver:status': [void, DevServerStatus[]]
  'devserver:log': [{ repoId: string; paneId: string; label: string }, string]

  // Settings
  'settings:get': [void, AppSettings]
  'settings:set': [Partial<AppSettings>, void]
  'settings:export': [void, boolean]
  'settings:import': [void, AppSettings | null]

  // Shell
  'shell:open-external': [string, void]
  'shell:list-images': [string, string[]]

  // Dialog
  'dialog:open-directory': [void, string | null]
  'dialog:open-images': [void, string[] | null]

  // Images
  'images:import': [string[], string[]]
  'images:delete': [string[], void]

  // GitHub
  'github:sync-prs': [void, { created: number; total: number }]
  'github:dismiss-pr': [string, void]

  // Ticket
  'ticket:fetch': [string, TicketFetchResult]
  'ticket:providers': [void, TicketProviderMeta[]]

  // Plugin
  'plugin:catalog': [void, PluginCatalogEntry[]]
  'plugin:install': [string, void]
  'plugin:uninstall': [string, void]

  // Hooks
  'hooks:status': [void, { installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean }]
  'hooks:install': [void, { success: boolean; error?: string }]
  'hooks:uninstall': [void, { success: boolean; error?: string }]

  // Status Line
  'hooks:statusline-status': [void, { installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean }]
  'hooks:statusline-install': [void, { success: boolean; error?: string }]
  'hooks:statusline-uninstall': [void, { success: boolean; error?: string }]

  // MCP Server
  'mcp:status': [void, { installed: boolean; url: string }]
  'mcp:install': [void, { success: boolean; error?: string }]
  'mcp:uninstall': [void, { success: boolean; error?: string }]
}

// 通知クリック時のナビゲーション先
export type NavigationPayload =
  | { type: 'task'; taskId: string }
  | { type: 'pr-detected'; taskId: string }
  | { type: 'devserver'; repoId: string; paneId: string; label: string }

// window.api の型定義（preload で expose するもの）
export type WindowApi = {
  tasks: {
    list: () => Promise<RuntimeTask[]>
    create: (task: DistributiveOmit<Task, 'id' | 'created_at'>) => Promise<RuntimeTask>
    update: (id: string, data: Partial<Task & RuntimeTaskState>) => Promise<RuntimeTask>
    delete: (id: string) => Promise<void>
    archive: (id: string) => Promise<void>
    listArchived: () => Promise<ArchiveEntry[]>
    deleteArchived: (id: string) => Promise<void>
    archiveAllDone: () => Promise<number>
    deleteAllArchived: () => Promise<number>
    restoreArchived: (id: string) => Promise<RuntimeTask>
    onUpdated: (callback: () => void) => () => void
  }
  terminal: {
    start: (taskId: string, workdir: string) => Promise<void>
    write: (taskId: string, data: string) => Promise<void>
    kill: (taskId: string) => Promise<void>
    resize: (taskId: string, cols: number, rows: number) => Promise<void>
    onData: (callback: (event: TerminalDataEvent) => void) => () => void
    offData: (taskId: string) => void
    onReset: (callback: (taskId: string) => void) => () => void
  }
  git: {
    status: (workdir: string) => Promise<GitStatusResult>
    branches: (workdir: string) => Promise<string[]>
  }
  claude: {
    start: (taskId: string, workdir: string, prompt?: string, cols?: number, rows?: number, launchMode?: LaunchMode, model?: ClaudeModel) => Promise<void>
    resume: (taskId: string, cols?: number, rows?: number, launchMode?: LaunchMode, model?: ClaudeModel) => Promise<void>
    listModels: () => Promise<string[]>
    onContextUpdate: (callback: (info: ContextInfo) => void) => () => void
  }
  devserver: {
    start: (repoId: string, paneId: string, label: string) => Promise<void>
    stop: (repoId: string, paneId: string, label: string) => Promise<void>
    status: () => Promise<DevServerStatus[]>
    onStatusChange: (callback: (statuses: DevServerStatus[]) => void) => () => void
    getLog: (repoId: string, paneId: string, label: string) => Promise<string>
  }
  settings: {
    get: () => Promise<AppSettings>
    set: (settings: Partial<AppSettings>) => Promise<void>
    export: () => Promise<boolean>
    import: () => Promise<AppSettings | null>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
    listImages: (dir: string) => Promise<string[]>
  }
  dialog: {
    openDirectory: () => Promise<string | null>
    openImages: () => Promise<string[] | null>
  }
  images: {
    import: (sourcePaths: string[]) => Promise<string[]>
    delete: (paths: string[]) => Promise<void>
  }
  github: {
    syncPRs: () => Promise<{ created: number; total: number }>
    dismissPr: (taskId: string) => Promise<void>
  }
  ticket: {
    fetch: (url: string) => Promise<TicketFetchResult>
    providers: () => Promise<TicketProviderMeta[]>
    catalog: () => Promise<PluginCatalogEntry[]>
    install: (id: string) => Promise<void>
    uninstall: (id: string) => Promise<void>
  }
  hooks: {
    status: () => Promise<{ installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean }>
    install: () => Promise<{ success: boolean; error?: string }>
    uninstall: () => Promise<{ success: boolean; error?: string }>
    statuslineStatus: () => Promise<{ installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean }>
    statuslineInstall: () => Promise<{ success: boolean; error?: string }>
    statuslineUninstall: () => Promise<{ success: boolean; error?: string }>
  }
  mcp: {
    status: () => Promise<{ installed: boolean; url: string }>
    install: () => Promise<{ success: boolean; error?: string }>
    uninstall: () => Promise<{ success: boolean; error?: string }>
  }
  system: {
    onResume: (callback: () => void) => () => void
  }
  navigation: {
    onNavigateTo: (callback: (payload: NavigationPayload) => void) => () => void
  }
}
