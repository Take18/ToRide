import { ipcMain, Notification, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { expandPath } from '../utils/path'
import type { ClaudeService } from '../services/ClaudeService'
import type { TaskService } from '../services/TaskService'
import type { GitService } from '../services/GitService'
import type { TerminalService } from '../services/TerminalService'
import type { StopHookService } from '../services/StopHookService'
import type { AppSettings, LaunchMode } from '../../../src/types/ipc'
import type { Task } from '../../../src/types/task'

const DEFAULT_ORCHESTRATE_SYSTEM_PROMPT = `あなたはタスクオーケストレーターです。以下のMCPツールを使って、ミッションを達成するためのサブタスクを自律的に管理・実行してください。

## 利用可能なMCPツール
- list_repos: 利用可能なリポジトリとペインの一覧を取得
- list_tasks: 現在のタスク一覧を取得（status: will_do / doing / done）
- create_task: 新しいタスクを作成
- start_task: タスクを起動（doing 状態にして Claude を起動）
- update_task: タスクのステータス・内容を更新
- delete_task: タスクを削除

## 進め方
1. ミッションをサブタスクに分解する
2. create_task で各サブタスクを作成する（repoId は list_repos で確認）
3. start_task でタスクを起動する
4. list_tasks で進捗を確認し、done になったら次のタスクを起動する
5. 全タスクが完了したらミッション達成を報告する`

function resolveLaunchMode(override: LaunchMode | undefined, isResearch: boolean, settings: AppSettings): LaunchMode {
  if (override) return override
  if (isResearch) return 'plan'
  if (settings.useDangerouslySkipPermissions) return 'bypass'
  if (settings.useAutoMode) return 'auto'
  return 'normal'
}

function interpolateTemplate(template: string, task: Task): string {
  const vars: Record<string, string> = { title: task.title }
  if ('branch' in task) vars['branch'] = task.branch
  if ('ticket' in task) vars['ticket'] = task.ticket
  if ('url' in task) vars['pr-url'] = task.url
  if ('prompt' in task && task.prompt) vars['prompt'] = task.prompt
  if ('output' in task) vars['output'] = task.output
  if ('directory' in task && task.directory) vars['directory'] = task.directory
  return template.replace(/\{([^}]+)\}/g, (match, key: string) => vars[key] ?? match)
}

type StartTaskDeps = {
  claudeService: ClaudeService
  taskService: TaskService
  gitService: GitService
  terminalService: TerminalService
  getWindow: () => BrowserWindow | null
  getSettings: () => AppSettings
  stopHookService?: StopHookService
}

export function createStartTaskFn(deps: StartTaskDeps): (taskId: string) => Promise<void> {
  const { claudeService, taskService, gitService, terminalService, getWindow, getSettings, stopHookService } = deps
  return async (taskId: string) => {
    const tasks = taskService.list()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    const settings = getSettings()
    let resolvedWorkdir = ''
    let assignedPane = task.pane

    if ((task.type === 'chore' && 'directory' in task) || task.type === 'orchestrate') {
      const dir = 'directory' in task ? task.directory : undefined
      resolvedWorkdir = dir ? expandPath(dir) : homedir()
    } else {
      const repoId = 'repoId' in task ? task.repoId : undefined
      const repo = repoId ? settings.repos.find((r) => r.id === repoId) : settings.repos[0]
      if (!repo) throw new Error('NO_REPO_ASSIGNED')
      const occupiedPaneIds = new Set(
        tasks
          .filter((t) => t.id !== taskId && t.status === 'doing' && t.pane &&
            (('repoId' in t ? (t as { repoId?: string }).repoId : undefined) ?? settings.repos[0]?.id) === repo.id)
          .map((t) => t.pane)
      )
      const freePaneConfig = repo.panes.find((p) => !occupiedPaneIds.has(p.id))
      if (!freePaneConfig) throw new Error('NO_FREE_PANE')
      assignedPane = freePaneConfig.id
      resolvedWorkdir = expandPath(freePaneConfig.path)
    }

    if ('branch' in task && task.branch) {
      const baseBranch = 'baseBranch' in task ? task.baseBranch : undefined
      await gitService.checkout(resolvedWorkdir, task.branch, baseBranch)
    }

    taskService.update(taskId, { status: 'doing', pane: assignedPane })

    try {
      getWindow()?.webContents.send('terminal:reset', taskId)

      let rawPrompt: string | undefined
      if (task.type === 'orchestrate') {
        const systemPrompt = settings.orchestrateSystemPrompt ?? DEFAULT_ORCHESTRATE_SYSTEM_PROMPT
        const mission = task.prompt
        rawPrompt = mission ? `${systemPrompt}\n\n---\n\n${mission}` : systemPrompt
      } else {
        rawPrompt = task.prompt || settings.promptTemplates?.[task.type]
      }
      const taskPrompt = rawPrompt ? (task.type === 'orchestrate' ? rawPrompt : interpolateTemplate(rawPrompt, task)) : undefined
      const effectiveLaunchMode = resolveLaunchMode(undefined, task.type === 'research', settings)
      const sessionId = randomUUID()
      claudeService.start(taskId, resolvedWorkdir, taskPrompt, effectiveLaunchMode, undefined, undefined, sessionId)
      taskService.update(taskId, { sessionId })

      if (stopHookService) {
        stopHookService.onTaskComplete(taskId, async () => {
          const currentTask = taskService.list().find((t) => t.id === taskId)
          if (!currentTask || currentTask.status === 'done') return
          const { notificationsEnabled = true } = getSettings()
          if (!notificationsEnabled) return
          const notification = new Notification({
            title: 'Claude が完了しました',
            body: `「${currentTask.title}」`,
            actions: [{ type: 'button', text: '承認して完了' }]
          })
          notification.on('action', (_, index) => {
            if (index !== 0) return
            const t = taskService.list().find((t) => t.id === taskId)
            if (!t || t.status === 'done') return
            taskService.update(taskId, { status: 'done', completedAt: new Date().toISOString() })
            getWindow()?.webContents.send('tasks:updated')
          })
          notification.show()
        })
      }

      const pid = terminalService.getPid(taskId)
      if (pid) taskService.update(taskId, { pid, workdir: resolvedWorkdir })

      terminalService.onData(taskId, (data) => {
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('terminal:data', { taskId, data })
      })

      claudeService.onContextUpdate((info) => {
        if (info.taskId === taskId) {
          taskService.update(taskId, { contextUsed: info.used, contextLimit: info.limit })
          const win = getWindow()
          if (win && !win.isDestroyed()) win.webContents.send('claude:context-update', info)
        }
      })
    } catch (startError) {
      taskService.update(taskId, { status: 'will_do' })
      throw startError
    }
  }
}

export function registerClaudeHandlers(
  claudeService: ClaudeService,
  taskService: TaskService,
  gitService: GitService,
  terminalService: TerminalService,
  getWindow: () => BrowserWindow | null,
  getSettings: () => AppSettings,
  stopHookService?: StopHookService
): void {
  ipcMain.handle(
    'claude:start',
    async (
      _,
      { taskId, workdir, prompt, cols, rows, launchMode }: { taskId: string; workdir: string; prompt?: string; cols?: number; rows?: number; launchMode?: LaunchMode }
    ) => {
      try {
        const tasks = taskService.list()
        const task = tasks.find((t) => t.id === taskId)
        if (!task) {
          throw new Error(`Task not found: ${taskId}`)
        }

        const settings = getSettings()
        let resolvedWorkdir = workdir
        let assignedPane = task.pane

        if ((task.type === 'chore' && 'directory' in task) || task.type === 'orchestrate') {
          // chore / orchestrate は directory を直接使用（pane不要）
          const dir = 'directory' in task ? task.directory : undefined
          resolvedWorkdir = dir ? expandPath(dir) : homedir()
        } else {
          // non-chore: タスクのリポジトリ内の空きペインを自動割り当て
          const repoId = 'repoId' in task ? task.repoId : undefined
          const repo = repoId
            ? settings.repos.find((r) => r.id === repoId)
            : settings.repos[0]
          if (!repo) {
            throw new Error('NO_REPO_ASSIGNED')
          }
          // 同一リポジトリ内のdoingタスクのみで占有判定（別リポジトリの同名paneを除外）
          // repoId未設定のタスクはrepos[0]に属するとみなす（MCP経由作成タスクの互換性）
          const occupiedPaneIds = new Set(
            tasks
              .filter((t) => t.id !== taskId && t.status === 'doing' && t.pane &&
                (('repoId' in t ? (t as { repoId?: string }).repoId : undefined) ?? settings.repos[0]?.id) === repo.id)
              .map((t) => t.pane)
          )
          const freePaneConfig = repo.panes.find((p) => !occupiedPaneIds.has(p.id))
          if (!freePaneConfig) {
            throw new Error('NO_FREE_PANE')
          }
          assignedPane = freePaneConfig.id
          resolvedWorkdir = expandPath(freePaneConfig.path)
        }

        // Check for branch checkout（失敗してもステータスをdoingにしない）
        if ('branch' in task && task.branch) {
          const baseBranch = 'baseBranch' in task ? task.baseBranch : undefined
          await gitService.checkout(resolvedWorkdir, task.branch, baseBranch)
        }

        // 事前チェックが全て通ってからステータス・paneをdoingに変更
        taskService.update(taskId, { status: 'doing', pane: assignedPane })

        try {
          // ターミナルリセットを先にレンダラーへ通知（古い表示を消す）
          getWindow()?.webContents.send('terminal:reset', taskId)

          // Start Claude
          let rawPrompt: string | undefined
          if (task.type === 'orchestrate') {
            // orchestrate: システムプロンプト + ミッション説明を結合
            const systemPrompt = settings.orchestrateSystemPrompt ?? DEFAULT_ORCHESTRATE_SYSTEM_PROMPT
            const mission = task.prompt
            rawPrompt = mission ? `${systemPrompt}\n\n---\n\n${mission}` : systemPrompt
          } else {
            rawPrompt = prompt || task.prompt || settings.promptTemplates?.[task.type]
          }
          const taskPrompt = rawPrompt ? (task.type === 'orchestrate' ? rawPrompt : interpolateTemplate(rawPrompt, task)) : undefined
          const effectiveLaunchMode = resolveLaunchMode(launchMode, task.type === 'research', settings)
          const sessionId = randomUUID()
          claudeService.start(taskId, resolvedWorkdir, taskPrompt, effectiveLaunchMode, cols, rows, sessionId)
          taskService.update(taskId, { sessionId })

          // Stop Hook: タスク完了通知コールバック登録（自動遷移しない）
          if (stopHookService) {
            stopHookService.onTaskComplete(taskId, async () => {
              const currentTask = taskService.list().find((t) => t.id === taskId)
              if (!currentTask || currentTask.status === 'done') return
              const { notificationsEnabled = true } = getSettings()
              if (!notificationsEnabled) return

              const notification = new Notification({
                title: 'Claude が完了しました',
                body: `「${currentTask.title}」`,
                actions: [{ type: 'button', text: '承認して完了' }]
              })
              notification.on('action', (_, index) => {
                if (index !== 0) return
                const t = taskService.list().find((t) => t.id === taskId)
                if (!t || t.status === 'done') return
                taskService.update(taskId, { status: 'done', completedAt: new Date().toISOString() })
                getWindow()?.webContents.send('tasks:updated')
              })
              notification.show()
            })
          }

          // Record PID
          const pid = terminalService.getPid(taskId)
          if (pid) {
            taskService.update(taskId, { pid, workdir: resolvedWorkdir })
          }

          // PTYデータをレンダラーに転送
          terminalService.onData(taskId, (data) => {
            const win = getWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send('terminal:data', { taskId, data })
            }
          })

          // Set up context update forwarding
          claudeService.onContextUpdate((info) => {
            if (info.taskId === taskId) {
              taskService.update(taskId, {
                contextUsed: info.used,
                contextLimit: info.limit
              })
              const win = getWindow()
              if (win && !win.isDestroyed()) {
                win.webContents.send('claude:context-update', info)
              }
            }
          })
        } catch (startError) {
          // Claudeの起動に失敗したらステータスを元に戻す
          taskService.update(taskId, { status: 'will_do' })
          throw startError
        }
      } catch (error) {
        throw new Error(`Failed to start Claude: ${(error as Error).message}`)
      }
    }
  )

  ipcMain.handle(
    'claude:resume',
    async (
      _,
      { taskId, cols, rows, launchMode }: { taskId: string; cols?: number; rows?: number; launchMode?: LaunchMode }
    ) => {
      try {
        const tasks = taskService.list()
        const task = tasks.find((t) => t.id === taskId)
        if (!task) {
          throw new Error(`Task not found: ${taskId}`)
        }

        const sessionId = 'sessionId' in task ? (task as { sessionId?: string }).sessionId : undefined
        if (!sessionId) {
          throw new Error('NO_SESSION_ID')
        }

        const settings = getSettings()
        let resolvedWorkdir = ''
        let assignedPane = task.pane

        if (task.type === 'chore' && 'directory' in task) {
          resolvedWorkdir = expandPath(task.directory)
        } else {
          const repoId = 'repoId' in task ? task.repoId : undefined
          const repo = repoId
            ? settings.repos.find((r) => r.id === repoId)
            : settings.repos[0]
          if (!repo) {
            throw new Error('NO_REPO_ASSIGNED')
          }
          // 同一リポジトリ内のdoingタスクのみで占有判定（別リポジトリの同名paneを除外）
          // repoId未設定のタスクはrepos[0]に属するとみなす（MCP経由作成タスクの互換性）
          const occupiedPaneIds = new Set(
            tasks
              .filter((t) => t.id !== taskId && t.status === 'doing' && t.pane &&
                (('repoId' in t ? (t as { repoId?: string }).repoId : undefined) ?? settings.repos[0]?.id) === repo.id)
              .map((t) => t.pane)
          )
          // セッション再開時は元のpaneを優先（claude --resume は起動ディレクトリでセッションを検索するため）
          const originalPaneConfig = task.pane
            ? repo.panes.find((p) => p.id === task.pane)
            : null
          if (originalPaneConfig) {
            if (occupiedPaneIds.has(originalPaneConfig.id)) {
              throw new Error('PANE_CONFLICT')
            }
            assignedPane = originalPaneConfig.id
            resolvedWorkdir = expandPath(originalPaneConfig.path)
          } else {
            const freePaneConfig = repo.panes.find((p) => !occupiedPaneIds.has(p.id))
            if (!freePaneConfig) {
              throw new Error('NO_FREE_PANE')
            }
            assignedPane = freePaneConfig.id
            resolvedWorkdir = expandPath(freePaneConfig.path)
          }
        }

        if ('branch' in task && task.branch) {
          const baseBranch = 'baseBranch' in task ? task.baseBranch : undefined
          await gitService.checkout(resolvedWorkdir, task.branch, baseBranch)
        }

        taskService.update(taskId, { status: 'doing', pane: assignedPane })

        try {
          getWindow()?.webContents.send('terminal:reset', taskId)

          const effectiveLaunchMode = resolveLaunchMode(launchMode, task.type === 'research', settings)
          claudeService.start(taskId, resolvedWorkdir, undefined, effectiveLaunchMode, cols, rows, undefined, sessionId)

          if (stopHookService) {
            stopHookService.onTaskComplete(taskId, async () => {
              const currentTask = taskService.list().find((t) => t.id === taskId)
              if (!currentTask || currentTask.status === 'done') return
              const { notificationsEnabled = true } = getSettings()
              if (!notificationsEnabled) return

              const notification = new Notification({
                title: 'Claude が完了しました',
                body: `「${currentTask.title}」`,
                actions: [{ type: 'button', text: '承認して完了' }]
              })
              notification.on('action', (_, index) => {
                if (index !== 0) return
                const t = taskService.list().find((t) => t.id === taskId)
                if (!t || t.status === 'done') return
                taskService.update(taskId, { status: 'done', completedAt: new Date().toISOString() })
                getWindow()?.webContents.send('tasks:updated')
              })
              notification.show()
            })
          }

          const pid = terminalService.getPid(taskId)
          if (pid) {
            taskService.update(taskId, { pid, workdir: resolvedWorkdir })
          }

          terminalService.onData(taskId, (data) => {
            const win = getWindow()
            if (win && !win.isDestroyed()) {
              win.webContents.send('terminal:data', { taskId, data })
            }
          })

          claudeService.onContextUpdate((info) => {
            if (info.taskId === taskId) {
              taskService.update(taskId, {
                contextUsed: info.used,
                contextLimit: info.limit
              })
              const win = getWindow()
              if (win && !win.isDestroyed()) {
                win.webContents.send('claude:context-update', info)
              }
            }
          })
        } catch (startError) {
          taskService.update(taskId, { status: 'done' })
          throw startError
        }
      } catch (error) {
        throw new Error(`Failed to resume Claude: ${(error as Error).message}`)
      }
    }
  )
}
