import { ipcMain, Notification, type BrowserWindow } from 'electron'
import type { GitHubService } from '../services/GitHubService'
import type { GitService } from '../services/GitService'
import type { TaskService } from '../services/TaskService'
import type { AppSettings } from '../../../src/types/ipc'
import type { ReviewTask } from '../../../src/types/task'

export function registerGitHubHandlers(
  gitHubService: GitHubService,
  gitService: GitService,
  taskService: TaskService,
  getSettings: () => AppSettings,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('github:sync-prs', async () => {
    const result = await syncReviewPRs(gitHubService, gitService, taskService, getSettings, getWindow)
    return result
  })
}

async function buildRepoFullNameMap(
  gitService: GitService,
  settings: AppSettings
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const repo of settings.repos) {
    const firstPane = repo.panes[0]
    if (!firstPane?.path) continue
    const fullName = await gitService.getRemoteFullName(firstPane.path)
    if (fullName) {
      map.set(fullName.toLowerCase(), repo.id)
    }
  }
  return map
}

export async function syncReviewPRs(
  gitHubService: GitHubService,
  gitService: GitService,
  taskService: TaskService,
  getSettings: () => AppSettings,
  getWindow: () => BrowserWindow | null
): Promise<{ created: number; total: number }> {
  const settings = getSettings()
  const githubPat = settings.githubPat?.trim()
  const githubUsername = settings.githubUsername?.trim()

  if (!githubPat || !githubUsername) {
    return { created: 0, total: 0 }
  }

  const prs = await gitHubService.fetchReviewRequestedPRs(githubUsername, githubPat)

  // リポジトリのgitリモートURLからrepoIdへのマップを構築
  const repoFullNameMap = await buildRepoFullNameMap(gitService, settings)

  // will_do / doing の review タスクの url のみ収集（done・アーカイブは再取得対象）
  const existingTasks = taskService.list()
  const existingUrls = new Set(
    existingTasks
      .filter((t) => t.type === 'review' && (t.status === 'will_do' || t.status === 'doing'))
      .map((t) => (t as { url?: string }).url)
      .filter(Boolean)
  )

  let created = 0
  for (const pr of prs) {
    if (existingUrls.has(pr.html_url)) continue

    const repoId = repoFullNameMap.get(pr.repositoryFullName.toLowerCase())

    taskService.create({
      type: 'review',
      status: 'will_do',
      title: `[${pr.repositoryName}] #${pr.number} ${pr.title}`,
      pane: '',
      repoId,
      url: pr.html_url,
      prStatus: pr.state as ReviewTask['prStatus']
    } as Omit<ReviewTask, 'id' | 'created_at'>)
    created++
  }

  // 既存reviewタスクの prStatus を同期
  const reviewTasksWithUrl = existingTasks.filter(
    (t) => t.type === 'review' && (t as { url?: string }).url
  )
  let statusUpdated = 0
  for (const task of reviewTasksWithUrl) {
    const url = (task as { url?: string }).url!
    try {
      const prStatus = await gitHubService.fetchPRStatus(url, githubPat)
      if (prStatus !== null && prStatus !== (task as { prStatus?: string }).prStatus) {
        taskService.update(task.id, { prStatus } as Parameters<typeof taskService.update>[1])
        statusUpdated++
      }
    } catch {
      // 個別PRのエラーは無視
    }
  }

  const hasChanges = created > 0 || statusUpdated > 0
  if (hasChanges) {
    getWindow()?.webContents.send('tasks:updated')
  }

  if (created > 0) {
    const { notificationsEnabled = true } = settings
    if (notificationsEnabled) {
      new Notification({
        title: 'レビュー依頼のPRを検出',
        body: `${created} 件の新しいレビュー依頼タスクを作成しました`
      }).show()
    }
  }

  return { created, total: prs.length }
}
