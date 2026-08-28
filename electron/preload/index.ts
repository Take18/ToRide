import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Task, RuntimeTaskState, ArchiveEntry, RuntimeTask, DistributiveOmit } from '../../src/types/task'
import type {
  AppSettings,
  GitStatusResult,
  DevServerStatus,
  TerminalDataEvent,
  ContextInfo,
  LaunchMode,
  ClaudeModel,
  RotationStatus,
  SlashCommandInfo,
  NavigationPayload,
  GitHubTokenVerifyResult
} from '../../src/types/ipc'

const api = {
  tasks: {
    list: (): Promise<RuntimeTask[]> => ipcRenderer.invoke('tasks:list'),
    create: (task: DistributiveOmit<Task, 'id' | 'created_at'>): Promise<RuntimeTask> =>
      ipcRenderer.invoke('tasks:create', task),
    update: (id: string, data: Partial<Task & RuntimeTaskState>): Promise<RuntimeTask> =>
      ipcRenderer.invoke('tasks:update', { id, data }),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('tasks:delete', id),
    archive: (id: string): Promise<void> => ipcRenderer.invoke('tasks:archive', id),
    listArchived: (): Promise<ArchiveEntry[]> => ipcRenderer.invoke('tasks:list-archived'),
    deleteArchived: (id: string): Promise<void> =>
      ipcRenderer.invoke('tasks:delete-archived', id),
    archiveAllDone: (): Promise<number> =>
      ipcRenderer.invoke('tasks:archive-all-done'),
    deleteAllArchived: (): Promise<number> =>
      ipcRenderer.invoke('tasks:delete-all-archived'),
    restoreArchived: (id: string): Promise<RuntimeTask> =>
      ipcRenderer.invoke('tasks:restore-archived', id),
    onUpdated: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('tasks:updated', listener)
      return () => ipcRenderer.removeListener('tasks:updated', listener)
    }
  },

  terminal: {
    start: (taskId: string, workdir: string): Promise<void> =>
      ipcRenderer.invoke('terminal:start', { taskId, workdir }),
    write: (taskId: string, data: string): Promise<void> =>
      ipcRenderer.invoke('terminal:write', { taskId, data }),
    kill: (taskId: string): Promise<void> => ipcRenderer.invoke('terminal:kill', taskId),
    resize: (taskId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('terminal:resize', { taskId, cols, rows }),
    onData: (callback: (event: TerminalDataEvent) => void): (() => void) => {
      const listener = (_: IpcRendererEvent, event: TerminalDataEvent): void => callback(event)
      ipcRenderer.on('terminal:data', listener)
      return () => ipcRenderer.removeListener('terminal:data', listener)
    },
    offData: (_taskId: string): void => {
      // Individual task cleanup is handled by the unsubscribe returned from onData
    },
    onReset: (callback: (taskId: string) => void): (() => void) => {
      const listener = (_: IpcRendererEvent, taskId: string): void => callback(taskId)
      ipcRenderer.on('terminal:reset', listener)
      return () => ipcRenderer.removeListener('terminal:reset', listener)
    }
  },

  git: {
    status: (workdir: string): Promise<GitStatusResult> =>
      ipcRenderer.invoke('git:status', workdir),
    branches: (workdir: string): Promise<string[]> =>
      ipcRenderer.invoke('git:branches', workdir)
  },

  claude: {
    start: (taskId: string, workdir: string, prompt?: string, cols?: number, rows?: number, launchMode?: LaunchMode, model?: ClaudeModel): Promise<void> =>
      ipcRenderer.invoke('claude:start', { taskId, workdir, prompt, cols, rows, launchMode, model }),
    resume: (taskId: string, cols?: number, rows?: number, launchMode?: LaunchMode, model?: ClaudeModel): Promise<void> =>
      ipcRenderer.invoke('claude:resume', { taskId, cols, rows, launchMode, model }),
    listModels: (): Promise<string[]> => ipcRenderer.invoke('claude:list-models'),
    listCommands: (workdir?: string): Promise<SlashCommandInfo[]> =>
      ipcRenderer.invoke('claude:list-commands', workdir),
    onContextUpdate: (callback: (info: ContextInfo) => void): (() => void) => {
      const listener = (_: IpcRendererEvent, info: ContextInfo): void => callback(info)
      ipcRenderer.on('claude:context-update', listener)
      return () => ipcRenderer.removeListener('claude:context-update', listener)
    },
  },

  devserver: {
    start: (repoId: string, paneId: string, label: string): Promise<void> =>
      ipcRenderer.invoke('devserver:start', { repoId, paneId, label }),
    stop: (repoId: string, paneId: string, label: string): Promise<void> =>
      ipcRenderer.invoke('devserver:stop', { repoId, paneId, label }),
    status: (): Promise<DevServerStatus[]> => ipcRenderer.invoke('devserver:status'),
    onStatusChange: (callback: (statuses: DevServerStatus[]) => void): (() => void) => {
      const listener = (_: IpcRendererEvent, statuses: DevServerStatus[]): void =>
        callback(statuses)
      ipcRenderer.on('devserver:status-change', listener)
      return () => ipcRenderer.removeListener('devserver:status-change', listener)
    },
    getLog: (repoId: string, paneId: string, label: string): Promise<string> =>
      ipcRenderer.invoke('devserver:log', { repoId, paneId, label })
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
    set: (settings: Partial<AppSettings>): Promise<void> =>
      ipcRenderer.invoke('settings:set', settings),
    export: (): Promise<boolean> => ipcRenderer.invoke('settings:export'),
    import: (): Promise<AppSettings | null> => ipcRenderer.invoke('settings:import')
  },

  shell: {
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('shell:open-external', url),
    listImages: (dir: string): Promise<string[]> =>
      ipcRenderer.invoke('shell:list-images', dir)
  },

  dialog: {
    openDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke('dialog:open-directory'),
    openImages: (): Promise<string[] | null> =>
      ipcRenderer.invoke('dialog:open-images')
  },

  images: {
    import: (sourcePaths: string[]): Promise<string[]> =>
      ipcRenderer.invoke('images:import', sourcePaths),
    delete: (paths: string[]): Promise<void> =>
      ipcRenderer.invoke('images:delete', paths)
  },

  github: {
    syncPRs: (): Promise<{ created: number; total: number; authErrors: string[] }> =>
      ipcRenderer.invoke('github:sync-prs'),
    dismissPr: (taskId: string): Promise<void> =>
      ipcRenderer.invoke('github:dismiss-pr', taskId),
    verifyToken: (scope: string, token: string): Promise<GitHubTokenVerifyResult> =>
      ipcRenderer.invoke('github:verify-token', { scope, token }),
    repoOwners: (): Promise<string[]> => ipcRenderer.invoke('github:repo-owners')
  },

  ticket: {
    fetch: (url: string) => ipcRenderer.invoke('ticket:fetch', url),
    providers: () => ipcRenderer.invoke('ticket:providers'),
    catalog: () => ipcRenderer.invoke('plugin:catalog'),
    install: (id: string) => ipcRenderer.invoke('plugin:install', id),
    uninstall: (id: string) => ipcRenderer.invoke('plugin:uninstall', id)
  },

  hooks: {
    status: (): Promise<{ installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean }> =>
      ipcRenderer.invoke('hooks:status'),
    install: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('hooks:install'),
    uninstall: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('hooks:uninstall'),
    statuslineStatus: (): Promise<{ installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean }> =>
      ipcRenderer.invoke('hooks:statusline-status'),
    statuslineInstall: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('hooks:statusline-install'),
    statuslineUninstall: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('hooks:statusline-uninstall')
  },

  rotation: {
    status: (taskId: string): Promise<RotationStatus | null> =>
      ipcRenderer.invoke('rotation:status', taskId),
    rotateNow: (taskId: string): Promise<void> =>
      ipcRenderer.invoke('rotation:rotate-now', taskId),
  },
  mcp: {
    status: (): Promise<{ installed: boolean; url: string }> =>
      ipcRenderer.invoke('mcp:status'),
    install: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:install'),
    uninstall: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:uninstall'),
  },

  system: {
    onResume: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('system:resume', listener)
      return () => ipcRenderer.removeListener('system:resume', listener)
    }
  },

  navigation: {
    onNavigateTo: (callback: (payload: NavigationPayload) => void): (() => void) => {
      const listener = (_: IpcRendererEvent, payload: NavigationPayload): void => callback(payload)
      ipcRenderer.on('navigation:goto', listener)
      return () => ipcRenderer.removeListener('navigation:goto', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
