import type { GitService } from '../services/GitService'
import type { AppSettings } from '../../../src/types/ipc'
import { expandPath } from './path'

/** gitリモートのフルネーム（owner/repo）→ repoId のマップを構築する */
export async function buildRepoFullNameMap(
  gitService: GitService,
  settings: AppSettings
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const repo of settings.repos) {
    // 先頭ペインが解決できない場合に備えて全ペインを順に試す
    for (const pane of repo.panes) {
      if (!pane.path) continue
      const fullName = await gitService.getRemoteFullName(expandPath(pane.path))
      if (fullName) {
        map.set(fullName.toLowerCase(), repo.id)
        break
      }
    }
  }
  return map
}

/** PRのURLから owner/repo を取り出す */
export function extractFullNameFromPrUrl(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)
  return match ? match[1] : null
}
