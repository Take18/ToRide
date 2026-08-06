import { ipcMain, Notification, type BrowserWindow } from 'electron'
import type { GitHubService } from '../services/GitHubService'
import type { GitService } from '../services/GitService'
import type { TaskService } from '../services/TaskService'
import type { DismissedPrService } from '../services/DismissedPrService'
import type { AppSettings } from '../../../src/types/ipc'
import type { ReviewTask } from '../../../src/types/task'
import { buildRepoFullNameMap, extractFullNameFromPrUrl } from '../utils/repoMap'

export function registerGitHubHandlers(
  gitHubService: GitHubService,
  gitService: GitService,
  taskService: TaskService,
  dismissedPrService: DismissedPrService,
  getSettings: () => AppSettings,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('github:sync-prs', async () => {
    const result = await syncReviewPRs(
      gitHubService,
      gitService,
      taskService,
      dismissedPrService,
      getSettings,
      getWindow
    )
    return result
  })

  ipcMain.handle('github:dismiss-pr', async (_, taskId: string) => {
    const task = taskService.list().find((t) => t.id === taskId)
    if (!task) {
      throw new Error(`Task not found: ${taskId}`)
    }
    const url = (task as { url?: string }).url
    if (task.type !== 'review' || !url) {
      throw new Error('Only review tasks with a PR URL can be dismissed')
    }
    dismissedPrService.add(url)
    taskService.delete(taskId)
  })
}

export async function syncReviewPRs(
  gitHubService: GitHubService,
  gitService: GitService,
  taskService: TaskService,
  dismissedPrService: DismissedPrService,
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

  const dismissedUrls = new Set(dismissedPrService.listUrls())

  let created = 0
  const createdTaskIds: string[] = []
  for (const pr of prs) {
    if (existingUrls.has(pr.html_url)) continue
    if (dismissedUrls.has(pr.html_url)) continue

    const repoId = repoFullNameMap.get(pr.repositoryFullName.toLowerCase())

    const newTask = taskService.create({
      type: 'review',
      status: 'will_do',
      title: `[${pr.repositoryName}] #${pr.number} ${pr.title}`,
      pane: '',
      repoId,
      url: pr.html_url,
      prStatus: pr.state as ReviewTask['prStatus']
    } as Omit<ReviewTask, 'id' | 'created_at'>)
    createdTaskIds.push(newTask.id)
    created++
  }

  // 既存reviewタスクの prStatus を同期
  const reviewTasksWithUrl = existingTasks.filter(
    (t) => t.type === 'review' && (t as { url?: string }).url
  )
  let statusUpdated = 0
  for (const task of reviewTasksWithUrl) {
    const url = (task as { url?: string }).url!
    const updates: Record<string, unknown> = {}

    // repoId未設定の既存タスクはPRのURLから補完
    if (!(task as { repoId?: string }).repoId) {
      const fullName = extractFullNameFromPrUrl(url)
      const repoId = fullName ? repoFullNameMap.get(fullName.toLowerCase()) : undefined
      if (repoId) {
        updates.repoId = repoId
      }
    }

    try {
      const prStatus = await gitHubService.fetchPRStatus(url, githubPat)
      if (prStatus !== null && prStatus !== (task as { prStatus?: string }).prStatus) {
        updates.prStatus = prStatus
      }
    } catch {
      // 個別PRのエラーは無視
    }

    if (Object.keys(updates).length > 0) {
      taskService.update(task.id, updates as Parameters<typeof taskService.update>[1])
      statusUpdated++
    }
  }

  // dismiss済みPRのうちclose/merge済みのレコードを削除（テーブル肥大防止）
  // 今回の取得結果に含まれるPRはopen確定なのでAPI確認をスキップ
  const openPrUrls = new Set(prs.map((pr) => pr.html_url))
  for (const url of dismissedUrls) {
    if (openPrUrls.has(url)) continue
    try {
      const prStatus = await gitHubService.fetchPRStatus(url, githubPat)
      if (prStatus === 'closed' || prStatus === 'merged') {
        dismissedPrService.remove(url)
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
      const notification = new Notification({
        title: 'レビュー依頼のPRを検出',
        body: `${created} 件の新しいレビュー依頼タスクを作成しました`
      })
      if (createdTaskIds.length > 0) {
        notification.on('click', () => {
          const win = getWindow()
          win?.show()
          win?.focus()
          win?.webContents.send('navigation:goto', { type: 'pr-detected', taskId: createdTaskIds[0] })
        })
      }
      notification.show()
    }
  }

  return { created, total: prs.length }
}
