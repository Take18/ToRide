import { ipcMain } from 'electron'
import type { PluginRegistry } from '../plugins/PluginRegistry'
import type { AppSettings } from '../../../src/types/ipc'
import type { TicketProviderMeta, TicketFetchResult } from '../../../src/types/plugin'
import { resolveGitHubTokenForUrl } from '../utils/githubToken'

export function registerTicketHandlers(
  registry: PluginRegistry,
  getSettings: () => AppSettings
): void {
  ipcMain.handle('ticket:fetch', async (_, url: string): Promise<TicketFetchResult> => {
    const plugin = registry.findTicketPlugin(url)
    if (!plugin) throw new Error('このURLに対応するプロバイダーがありません')

    const settings = getSettings()
    const pluginSettings: Record<string, string> = { ...settings.pluginSettings?.[plugin.id] ?? {} }
    // GitHub系プラグイン向けに、URLの owner/repo に対応するトークンだけを渡す
    // （GitHub以外のURLではトークンを渡さない）
    const githubToken = resolveGitHubTokenForUrl(settings, url)
    if (githubToken) pluginSettings.githubPat = githubToken
    const info = await plugin.fetchTicket(url, pluginSettings)

    return {
      providerId: plugin.id,
      id: info.id,
      title: info.title,
      taskType: info.taskType,
      url: info.url,
      meta: info.meta,
    }
  })

  ipcMain.handle('ticket:providers', async (): Promise<TicketProviderMeta[]> => {
    const settings = getSettings()
    return registry.listTicketPlugins().map((plugin) => {
      const ps = settings.pluginSettings?.[plugin.id] ?? {}
      const configured = plugin.settingFields
        .filter((f) => f.encrypted)
        .every((f) => !!ps[f.key])
      return {
        id: plugin.id,
        displayName: plugin.displayName,
        urlPattern: plugin.urlPattern.source,
        settingFields: plugin.settingFields,
        configured,
      }
    })
  })
}
