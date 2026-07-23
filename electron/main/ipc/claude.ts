import { ipcMain, Notification, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { expandPath } from '../utils/path'
import type { ClaudeService } from '../services/ClaudeService'
import type { TaskService } from '../services/TaskService'
import type { GitService } from '../services/GitService'
import type { TerminalService } from '../services/TerminalService'
import type { StopHookService } from '../services/StopHookService'
import type { ModelListService } from '../services/ModelListService'
import type { AppSettings, ClaudeModel, LaunchMode } from '../../../src/types/ipc'
import type { Task } from '../../../src/types/task'

const DEFAULT_ORCHESTRATE_SYSTEM_PROMPT = `あなたはタスクオーケストレーターです。ToRide MCPツールを使ってミッションを自律的に実行してください。

## 基本方針
- サブタスクは**事前に全部作るのではなく、状況に応じて動的に作成・起動**する
- 1つのタスクが完了したら次を作成・起動する（逐次進行）
- 並列実行が必要なら複数タスクを同時起動してもよい

## 利用可能なMCPツール
- list_repos: リポジトリ一覧を取得（create_task の repoId に使う）
- list_tasks: タスク一覧を取得してステータスを確認
- create_task: タスクを新規作成（type: feat/bugfix/review/research/design/chore）
- start_task: タスクを起動（Claude が自動実行を開始する）
- update_task: タスクのステータス・内容を更新
- delete_task: タスクを削除

## 進め方
1. list_repos でリポジトリIDを確認する
2. ミッションの最初のステップを create_task で作成する
3. start_task で起動する
4. **list_tasks を定期的に呼び出し、対象タスクの status が "done" になるまで待つ**（ポーリング間隔の目安: 30〜60秒）
5. status が "done" を確認したら、メモリファイルを読んで内容を把握し、次のタスクを作成・起動する
6. 全ステップが完了したらミッション達成を報告する

## ⚠️ 重要なルール
- **メモリファイルの存在だけでタスク完了と判断してはいけない**。必ず list_tasks で status が "done" であることを確認すること
- start_task は非同期。起動直後はまだ "doing" なので、すぐ次に進まず必ずポーリングで完了を確認する
- 空きペインがない場合は start_task がエラーになる。完了待ちのタスクがあれば、それが done になってから再試行する`

function buildOrchestratePrompt(taskId: string, systemPrompt: string, mission?: string): string {
  const memoryDir = `${homedir()}/.toride/memory/${taskId}`
  const memorySection = [
    '',
    '',
    '## 作業メモリディレクトリ',
    `サブタスク間で情報を引き継ぐために以下のディレクトリを使ってください（\`mkdir -p\` で自動作成）:`,
    `\`${memoryDir}/\``,
    `- **計画・進捗**: \`${memoryDir}/plan.md\` に作成したタスクIDや進捗状況を記録する`,
    `- **タスク完了後**: 各サブタスクの prompt に「完了後に \`${memoryDir}/[タスクID]_result.md\` へ実施内容・成果物・次タスクへの引き継ぎ事項を保存すること」を含める`,
    `- **次タスク起動前**: 前タスクの result ファイルを読んで内容を確認し、引き継ぎ情報を次のプロンプトに含める`,
  ].join('\n')
  const fullPrompt = systemPrompt + memorySection
  return mission ? `${fullPrompt}\n\n---\n\nミッション:\n${mission}` : fullPrompt
}

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

export function createStartTaskFn(deps: StartTaskDeps): (taskId: string, launchMode?: LaunchMode, model?: ClaudeModel) => Promise<void> {
  const { claudeService, taskService, gitService, terminalService, getWindow, getSettings, stopHookService } = deps
  return async (taskId: string, launchMode?: LaunchMode, model?: ClaudeModel) => {
    const tasks = taskService.list()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) throw new Error(`Task not found: ${taskId}`)

    const settings = getSettings()
    let resolvedWorkdir = ''
    let assignedPane = task.pane

    if (task.type === 'chore' && 'directory' in task) {
      resolvedWorkdir = expandPath(task.directory)
    } else if (task.type === 'orchestrate') {
      // orchestrate はコーディネーター役なのでペインを占有しない（workdir だけ先頭ペインから借りる）
      const repoId = 'repoId' in task ? (task as { repoId?: string }).repoId : undefined
      const repo = repoId ? settings.repos.find((r) => r.id === repoId) : settings.repos[0]
      resolvedWorkdir = expandPath(repo?.panes[0]?.path ?? homedir())
      assignedPane = ''
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
        rawPrompt = buildOrchestratePrompt(taskId, systemPrompt, task.prompt)
      } else {
        rawPrompt = task.prompt || settings.promptTemplates?.[task.type]
      }
      const taskPrompt = rawPrompt ? (task.type === 'orchestrate' ? rawPrompt : interpolateTemplate(rawPrompt, task)) : undefined
      const effectiveLaunchMode = resolveLaunchMode(launchMode, task.type === 'research', settings)
      const sessionId = randomUUID()
      claudeService.start(taskId, resolvedWorkdir, taskPrompt, effectiveLaunchMode, undefined, undefined, sessionId, undefined, model)
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
          notification.on('click', () => {
            const win = getWindow()
            win?.show()
            win?.focus()
            win?.webContents.send('navigation:goto', { type: 'task', taskId })
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
  stopHookService?: StopHookService,
  modelListService?: ModelListService
): void {
  if (modelListService) {
    ipcMain.handle('claude:list-models', () => modelListService.listModels())
  }

  ipcMain.handle(
    'claude:start',
    async (
      _,
      { taskId, workdir, prompt, cols, rows, launchMode, model }: { taskId: string; workdir: string; prompt?: string; cols?: number; rows?: number; launchMode?: LaunchMode; model?: ClaudeModel }
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

        if (task.type === 'chore' && 'directory' in task) {
          resolvedWorkdir = expandPath(task.directory)
        } else if (task.type === 'orchestrate') {
          // orchestrate はコーディネーター役なのでペインを占有しない（workdir だけ先頭ペインから借りる）
          const repoId = 'repoId' in task ? (task as { repoId?: string }).repoId : undefined
          const repo = repoId ? settings.repos.find((r) => r.id === repoId) : settings.repos[0]
          resolvedWorkdir = expandPath(repo?.panes[0]?.path ?? homedir())
          assignedPane = ''
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
            // orchestrate: システムプロンプト + メモリディレクトリ + ミッション説明を結合
            const systemPrompt = settings.orchestrateSystemPrompt ?? DEFAULT_ORCHESTRATE_SYSTEM_PROMPT
            rawPrompt = buildOrchestratePrompt(taskId, systemPrompt, task.prompt)
          } else {
            rawPrompt = prompt || task.prompt || settings.promptTemplates?.[task.type]
          }
          const taskPrompt = rawPrompt ? (task.type === 'orchestrate' ? rawPrompt : interpolateTemplate(rawPrompt, task)) : undefined
          const effectiveLaunchMode = resolveLaunchMode(launchMode, task.type === 'research', settings)
          const sessionId = randomUUID()
          claudeService.start(taskId, resolvedWorkdir, taskPrompt, effectiveLaunchMode, cols, rows, sessionId, undefined, model)
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
              notification.on('click', () => {
                const win = getWindow()
                win?.show()
                win?.focus()
                win?.webContents.send('navigation:goto', { type: 'task', taskId })
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
      { taskId, cols, rows, launchMode, model }: { taskId: string; cols?: number; rows?: number; launchMode?: LaunchMode; model?: ClaudeModel }
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
        } else if (task.type === 'orchestrate') {
          // orchestrate はペインを占有しない。起動時と同じ先頭ペインのパスで再開する
          // （claude --resume は起動ディレクトリでセッションを検索するため）
          const repoId = 'repoId' in task ? (task as { repoId?: string }).repoId : undefined
          const repo = repoId ? settings.repos.find((r) => r.id === repoId) : settings.repos[0]
          resolvedWorkdir = expandPath(repo?.panes[0]?.path ?? homedir())
          assignedPane = ''
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
          claudeService.start(taskId, resolvedWorkdir, undefined, effectiveLaunchMode, cols, rows, undefined, sessionId, model)

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
              notification.on('click', () => {
                const win = getWindow()
                win?.show()
                win?.focus()
                win?.webContents.send('navigation:goto', { type: 'task', taskId })
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
