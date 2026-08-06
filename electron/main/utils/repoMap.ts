import type { GitService } from '../services/GitService'
import type { AppSettings } from '../../../src/types/ipc'
import { expandPath } from './path'

/** 設定済みリポジトリのgitリモートから フルネーム（owner/repo）と repoId の対応を列挙する */
export async function listRepoFullNames(
  gitService: GitService,
  settings: AppSettings
): Promise<Array<{ fullName: string; repoId: string }>> {
  const result: Array<{ fullName: string; repoId: string }> = []
  for (const repo of settings.repos) {
    // 先頭ペインが解決できない場合に備えて全ペインを順に試す
    for (const pane of repo.panes) {
      if (!pane.path) continue
      const fullName = await gitService.getRemoteFullName(expandPath(pane.path))
      if (fullName) {
        result.push({ fullName, repoId: repo.id })
        break
      }
    }
  }
  return result
}

/** gitリモートのフルネーム（owner/repo）→ repoId のマップを構築する */
export async function buildRepoFullNameMap(
  gitService: GitService,
  settings: AppSettings
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const { fullName, repoId } of await listRepoFullNames(gitService, settings)) {
    map.set(fullName.toLowerCase(), repoId)
  }
  return map
}

/** PRのURLから owner/repo を取り出す */
export function extractFullNameFromPrUrl(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/)
  return match ? match[1] : null
}
