import { app, BrowserWindow, shell, ipcMain, safeStorage, protocol, dialog, powerMonitor, Notification } from 'electron'
import { join, extname } from 'path'
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { initDatabase, getDatabase } from './db/schema'
import { TaskService } from './services/TaskService'
import { TerminalService } from './services/TerminalService'
import { GitService } from './services/GitService'
import { ClaudeService } from './services/ClaudeService'
import { DevServerService } from './services/DevServerService'
import { GitHubService } from './services/GitHubService'
import { LocalHttpServer } from './services/LocalHttpServer'
import { StopHookService } from './services/StopHookService'
import { ContextLineService } from './services/ContextLineService'
import { McpServerService } from './services/McpServerService'
import { McpHookService } from './services/McpHookService'
import { PluginRegistry } from './plugins/PluginRegistry'
import { PLUGIN_CATALOG } from './plugins/catalog'
import { registerTaskHandlers } from './ipc/tasks'
import { registerTerminalHandlers } from './ipc/terminal'
import { registerGitHandlers } from './ipc/git'
import { registerClaudeHandlers } from './ipc/claude'
import { registerDevServerHandlers } from './ipc/devServer'
import { registerGitHubHandlers, syncReviewPRs } from './ipc/github'
import { registerTicketHandlers } from './ipc/ticket'
import type { AppSettings } from '../../src/types/ipc'

// GUIアプリとして起動した場合のベースラインPATH拡張（シェルプロファイルが読まれないため）
process.env.PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`

// bg:// カスタムプロトコルをセキュアとして登録（app.whenReady より前に必要）
protocol.registerSchemesAsPrivileged([
  { scheme: 'bg', privileges: { secure: true, standard: true, supportFetchAPI: true } }
])

// プラグインレジストリ（getSettings() から参照するためモジュールレベルで初期化）
const registry = new PluginRegistry()

let mainWindow: BrowserWindow | null = null
let devServerServiceInstance: DevServerService | null = null
let terminalServiceInstance: TerminalService | null = null
let localHttpServerInstance: LocalHttpServer | null = null
let prSyncTimerId: ReturnType<typeof setInterval> | null = null

function getWindow(): BrowserWindow | null {
  return mainWindow
}

function getSettings(): AppSettings {
  const db = getDatabase()
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('settings') as
    | { value: string }
    | undefined

  if (!row) {
    return { repos: [] }
  }

  const raw = JSON.parse(row.value) as Record<string, unknown>

  // 旧 panes 形式から repos 形式へのマイグレーション
  if (raw.panes && !raw.repos) {
    raw.repos = [{ id: 'repo1', name: 'default', panes: raw.panes as import('../../src/types/ipc').PaneConfig[] }]
    delete raw.panes
  }

  // 旧 wrikeAccessToken/wrikeItemTypeFeatId/wrikeItemTypeBugfixId → pluginSettings.wrike へのマイグレーション
  if (raw.wrikeAccessToken !== undefined || raw.wrikeItemTypeFeatId !== undefined) {
    if (!raw.pluginSettings) raw.pluginSettings = {}
    ;(raw.pluginSettings as Record<string, Record<string, string>>)['wrike'] = {
      accessToken: (raw.wrikeAccessToken as string) ?? '',
      itemTypeFeatId: (raw.wrikeItemTypeFeatId as string) ?? '',
      itemTypeBugfixId: (raw.wrikeItemTypeBugfixId as string) ?? '',
    }
    delete raw.wrikeAccessToken
    delete raw.wrikeItemTypeFeatId
    delete raw.wrikeItemTypeBugfixId
  }

  // enabledPlugins マイグレーション: 未設定かつ wrike accessToken 設定済みなら ['wrike'] に
  if (!raw.enabledPlugins) {
    const hasWrikeToken = !!(raw.pluginSettings as Record<string, Record<string, string>> | undefined)?.wrike?.accessToken
    raw.enabledPlugins = hasWrikeToken ? ['wrike'] : []
  }

  const settings = raw as AppSettings

  // Decrypt GitHub PAT if exists
  if (settings.githubPat && safeStorage.isEncryptionAvailable()) {
    try {
      const encrypted = Buffer.from(settings.githubPat, 'base64')
      settings.githubPat = safeStorage.decryptString(encrypted)
    } catch {
      // Decryption failed (e.g., app was renamed and safeStorage key changed).
      // Clear to undefined so the user is prompted to re-enter rather than
      // using the garbage encrypted bytes as the actual token.
      settings.githubPat = undefined
      console.warn('[settings] GitHub PAT decryption failed - cleared. User needs to re-enter.')
    }
  }

  // Decrypt encrypted plugin settings
  if (settings.pluginSettings && safeStorage.isEncryptionAvailable()) {
    for (const plugin of registry.listTicketPlugins()) {
      const ps = settings.pluginSettings[plugin.id]
      if (!ps) continue
      for (const field of plugin.settingFields) {
        if (field.encrypted && ps[field.key]) {
          try {
            const encrypted = Buffer.from(ps[field.key], 'base64')
            ps[field.key] = safeStorage.decryptString(encrypted)
          } catch {
            // Decryption failed - clear so the field is treated as unset
            ps[field.key] = ''
            console.warn(`[settings] Plugin ${plugin.id}.${field.key} decryption failed - cleared.`)
          }
        }
      }
    }
  }

  return settings
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url && details.url !== 'about:blank') {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? '')) return
    if (!is.dev && url.startsWith('file://')) return
    event.preventDefault()
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url)
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.toride')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize database
  const db = initDatabase()

  // 起動時にdoingタスクをwill_doに戻す（再起動でPTYセッションが消えるため）
  db.prepare(`UPDATE tasks SET status = 'will_do' WHERE status = 'doing'`).run()
  db.prepare(`DELETE FROM task_runtime`).run()

  // 設定の extraPaths を PATH に追加（git hooks等の子プロセスに引き継ぐため）
  {
    const row = db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get('settings') as { value: string } | undefined
    if (row) {
      const raw = JSON.parse(row.value) as { extraPaths?: string[] }
      const extras = (raw.extraPaths ?? []).filter(Boolean)
      if (extras.length > 0) {
        process.env.PATH = `${extras.join(':')}:${process.env.PATH || ''}`
      }
    }
  }

  // 設定保存ヘルパー（暗号化 + DB保存）
  function saveSettings(merged: AppSettings): void {
    const toSave = { ...merged }
    if (toSave.githubPat && safeStorage.isEncryptionAvailable()) {
      toSave.githubPat = safeStorage.encryptString(toSave.githubPat).toString('base64')
    }
    if (toSave.pluginSettings && safeStorage.isEncryptionAvailable()) {
      for (const plugin of registry.listTicketPlugins()) {
        const ps = toSave.pluginSettings[plugin.id]
        if (!ps) continue
        for (const field of plugin.settingFields) {
          if (field.encrypted && ps[field.key]) {
            toSave.pluginSettings[plugin.id][field.key] = safeStorage
              .encryptString(ps[field.key])
              .toString('base64')
          }
        }
      }
    }
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`).run(
      'settings',
      JSON.stringify(toSave)
    )
  }

  // 起動時: enabledPlugins に基づいてプラグインを条件付き登録
  {
    const initialSettings = getSettings()
    const enabled = initialSettings.enabledPlugins ?? []
    for (const item of PLUGIN_CATALOG) {
      if (enabled.includes(item.id)) {
        registry.registerTicketPlugin(item.factory())
      }
    }
  }

  // Initialize services
  const taskService = new TaskService(db)
  const terminalService = new TerminalService()
  terminalServiceInstance = terminalService
  const gitService = new GitService()
  const devServerService = new DevServerService()
  devServerServiceInstance = devServerService
  devServerService.onAbnormalExit((label) => {
    if (!getSettings().notificationsEnabled) return
    new Notification({
      title: 'Dev Server 異常終了',
      body: `「${label}」が予期せず終了しました`
    }).show()
  })
  const gitHubService = new GitHubService()
  const localHttpServer = new LocalHttpServer()
  localHttpServerInstance = localHttpServer
  const stopHookService = new StopHookService(localHttpServer)
  const contextLineService = new ContextLineService(localHttpServer)
  const mcpHookService = new McpHookService()
  new McpServerService(localHttpServer, taskService, getSettings, () => {
    getWindow()?.webContents.send('tasks:updated')
  })
  const claudeService = new ClaudeService(terminalService, getSettings, contextLineService)
  const initialPort = getSettings().stopHookPort ?? 39457
  localHttpServer.start(initialPort).catch((e) => {
    console.error('[LocalHttpServer] failed to start:', e)
  })

  // Register IPC handlers
  registerTaskHandlers(taskService, getSettings)
  registerTerminalHandlers(terminalService, getWindow)
  registerGitHandlers(gitService)
  registerClaudeHandlers(
    claudeService,
    taskService,
    gitService,
    terminalService,
    getWindow,
    getSettings,
    stopHookService
  )

  // Stop Hook IPC handlers
  ipcMain.handle('hooks:status', () => stopHookService.getHookStatus())
  ipcMain.handle('hooks:install', () => stopHookService.installHook())
  ipcMain.handle('hooks:uninstall', () => stopHookService.uninstallHook())

  // MCP Server IPC handlers
  ipcMain.handle('mcp:status', () => mcpHookService.getStatus())
  ipcMain.handle('mcp:install', () => mcpHookService.install(localHttpServer.getPort()))
  ipcMain.handle('mcp:uninstall', () => mcpHookService.uninstall())

  // Status Line (context) IPC handlers
  ipcMain.handle('hooks:statusline-status', () => contextLineService.getStatusLineStatus())
  ipcMain.handle('hooks:statusline-install', () => contextLineService.installStatusLine())
  ipcMain.handle('hooks:statusline-uninstall', () => contextLineService.uninstallStatusLine())
  registerDevServerHandlers(devServerService, getWindow, getSettings)
  registerGitHubHandlers(gitHubService, taskService, getSettings, getWindow)
  registerTicketHandlers(registry, getSettings)

  // PR自動同期タイマー（1分ごとにチェックし、設定された間隔で同期を実行）
  let lastPrSyncAt = 0
  prSyncTimerId = setInterval(async () => {
    const s = getSettings()
    const intervalMs = (s.githubPrSyncIntervalMin ?? 5) * 60 * 1000
    const now = Date.now()
    if (now - lastPrSyncAt >= intervalMs) {
      lastPrSyncAt = now
      try {
        await syncReviewPRs(gitHubService, taskService, getSettings, getWindow)
      } catch (err) {
        console.error('[github:sync-prs] auto-sync error:', err)
      }
    }
  }, 60_000)

  // Settings handlers
  ipcMain.handle('settings:get', async () => {
    return getSettings()
  })

  ipcMain.handle('settings:set', async (_, settings: Partial<AppSettings>) => {
    try {
      const current = getSettings()
      const merged = { ...current, ...settings }
      saveSettings(merged)
    } catch (error) {
      throw new Error(`Failed to save settings: ${(error as Error).message}`)
    }
  })

  // Shell handler
  ipcMain.handle('shell:open-external', async (_, url: string) => {
    await shell.openExternal(url)
  })

  // 画像ファイル一覧取得
  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'])
  ipcMain.handle('shell:list-images', async (_, dir: string): Promise<string[]> => {
    try {
      return readdirSync(dir)
        .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
        .map((f) => join(dir, f))
    } catch {
      return []
    }
  })

  // ディレクトリ選択ダイアログ
  ipcMain.handle('dialog:open-directory', async (): Promise<string | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  // 設定エクスポート
  ipcMain.handle('settings:export', async (): Promise<boolean> => {
    if (!mainWindow) return false
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'toride-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    const settings = getSettings()
    const { githubPat: _omit, ...exportSettings } = settings
    writeFileSync(result.filePath, JSON.stringify(exportSettings, null, 2), 'utf-8')
    return true
  })

  // 設定インポート
  ipcMain.handle('settings:import', async (): Promise<AppSettings | null> => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const content = readFileSync(result.filePaths[0], 'utf-8')
    const imported = JSON.parse(content) as Partial<AppSettings>
    const current = getSettings()
    const merged = { ...current, ...imported }
    saveSettings(merged)
    return getSettings()
  })

  // Plugin handlers
  ipcMain.handle('plugin:catalog', async () => {
    return PLUGIN_CATALOG.map(({ factory: _factory, ...meta }) => meta)
  })

  ipcMain.handle('plugin:install', async (_, id: string) => {
    const item = PLUGIN_CATALOG.find((c) => c.id === id)
    if (!item) throw new Error(`Unknown plugin: ${id}`)
    if (!registry.listTicketPlugins().find((p) => p.id === id)) {
      registry.registerTicketPlugin(item.factory())
    }
    const current = getSettings()
    const enabled = [...new Set([...(current.enabledPlugins ?? []), id])]
    saveSettings({ ...current, enabledPlugins: enabled })
  })

  ipcMain.handle('plugin:uninstall', async (_, id: string) => {
    registry.unregisterTicketPlugin(id)
    const current = getSettings()
    const enabled = (current.enabledPlugins ?? []).filter((p) => p !== id)
    saveSettings({ ...current, enabledPlugins: enabled })
  })

  // bg:// プロトコル → ローカル画像ファイルを直接読んで返す
  const MIME_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
  }
  protocol.handle('bg', (request) => {
    try {
      const filePath = new URL(request.url).searchParams.get('path') ?? ''
      const data = readFileSync(filePath)
      const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, { headers: { 'Content-Type': contentType } })
    } catch (e) {
      console.error('[bg] error:', e)
      return new Response('Not Found', { status: 404 })
    }
  })

  createWindow()

  powerMonitor.on('resume', () => {
    mainWindow?.webContents.send('system:resume')
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('will-quit', () => {
  if (prSyncTimerId) clearInterval(prSyncTimerId)
  devServerServiceInstance?.stopAll()
  terminalServiceInstance?.killAll()
  localHttpServerInstance?.stop()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
