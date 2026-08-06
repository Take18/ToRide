import { ipcMain } from 'electron'
import type { PluginRegistry } from '../plugins/PluginRegistry'
import type { GitHubService } from '../services/GitHubService'
import type { GitService } from '../services/GitService'
import type { AppSettings } from '../../../src/types/ipc'
import type { TicketProviderMeta, TicketFetchResult } from '../../../src/types/plugin'
import { buildRepoFullNameMap } from '../utils/repoMap'

/** GitHub PR URL からのタスク作成は常に有効（プラグイン設定不要） */
const PR_URL_PATTERN = /github\.com\/[^/]+\/[^/]+\/pull\/\d+/
const PR_PROVIDER_ID = 'github-pr'

export function registerTicketHandlers(
  registry: PluginRegistry,
  getSettings: () => AppSettings,
  gitHubService: GitHubService,
  gitService: GitService
): void {
  ipcMain.handle('ticket:fetch', async (_, url: string): Promise<TicketFetchResult> => {
    const settings = getSettings()

    // PR URL は review タスクとして扱う（プラグイン判定より優先）
    if (PR_URL_PATTERN.test(url)) {
      const pr = await gitHubService.fetchPullRequest(url, settings.githubPat?.trim() || undefined)
      const repoMap = await buildRepoFullNameMap(gitService, settings)
      return {
        providerId: PR_PROVIDER_ID,
        id: String(pr.number),
        title: `[${pr.repositoryName}] #${pr.number} ${pr.title}`,
        taskType: 'review',
        url: pr.html_url,
        repoId: repoMap.get(pr.repositoryFullName.toLowerCase()),
        meta: {
          repositoryFullName: pr.repositoryFullName,
          prStatus: pr.state === 'open' && pr.draft ? 'draft' : pr.state,
        },
      }
    }

    const plugin = registry.findTicketPlugin(url)
    if (!plugin) throw new Error('このURLに対応するプロバイダーがありません')

    const pluginSettings: Record<string, string> = { ...settings.pluginSettings?.[plugin.id] ?? {} }
    if (settings.githubPat) pluginSettings.githubPat = settings.githubPat
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
    const plugins = registry.listTicketPlugins().map((plugin) => {
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

    // PR URL 対応はプラグインではないが、対応プロバイダーとして常に返す
    return [
      {
        id: PR_PROVIDER_ID,
        displayName: 'GitHub PR',
        urlPattern: PR_URL_PATTERN.source,
        settingFields: [],
        configured: true,
      },
      ...plugins,
    ]
  })
}
