import { ipcMain, Notification, type BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { expandPath } from '../utils/path'
import type { ClaudeService } from '../services/ClaudeService'
import type { TaskService } from '../services/TaskService'
import type { GitService } from '../services/GitService'
import type { TerminalService } from '../services/TerminalService'
import type { StopHookService } from '../services/StopHookService'
import type { AgentRegistry } from '../agents/AgentRegistry'
import type { AgentProvider } from '../agents/types'
import type { AgentId, AppSettings, ClaudeModel, LaunchMode } from '../../../src/types/ipc'
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
- start_task: タスクを起動（タスクに設定されたエージェントが自動実行を開始する）
- update_task: タスクのステータス・内容を更新
- delete_task: タスクを削除
- notify_user: ユーザーのデスクトップに通知を送る（判断を仰ぎたいとき・警告が出たときのみ）

## create_task のフィールド記入ルール
- **ticket**: type が feat/bugfix の場合は必須。ミッションにチケットURLが含まれていれば必ず設定し、不明な場合はユーザーに確認する
- **prompt**: タスク固有の指示がなければ省略する（設定済みテンプレートが自動適用される）。指定する場合、{title} {branch} {ticket} 等のテンプレート変数が起動時に展開されるため、他フィールドの値を直書きせず変数で参照する

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
- 空きペインがない場合は start_task がエラーになる。完了待ちのタスクがあれば、それが done になってから再試行する
- ユーザーの判断が必要になったとき、またはミッションを中断せざるを得ない事象が起きたときは notify_user で通知する（level: question / warning）。ポーリング待ちなどの通常進行では通知しない`

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

// 添付画像があればプロンプト末尾に参照指示を追記する
function appendImageSection(prompt: string | undefined, task: Task): string | undefined {
  const images = task.images
  if (!images || images.length === 0) return prompt
  const section = ['以下の添付画像をReadツールで読み込んで参照してください:', ...images].join('\n')
  return prompt ? `${prompt}\n\n${section}` : section
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
  agentRegistry: AgentRegistry
  getWindow: () => BrowserWindow | null
  getSettings: () => AppSettings
  stopHookService?: StopHookService
}

export type StartTaskOptions = {
  /** セッションローテーション時に true。同一ペイン・同一ブランチの続きなので checkout する理由がない */
  skipCheckout?: boolean
  /** 通常の起動プロンプトの末尾に連結する文面（rotation の bootPrompt）。置換ではなく追加 */
  extraPrompt?: string
  /** タスクの prompt・テンプレートより優先するプロンプト（UI の起動ボタンから渡される） */
  promptOverride?: string
  cols?: number
  rows?: number
}

export type StartTaskFn = (
  taskId: string,
  launchMode?: LaunchMode,
  model?: ClaudeModel,
  options?: StartTaskOptions
) => Promise<void>

async function ensureAgentReady(provider: AgentProvider): Promise<void> {
  const readiness = await provider.checkReady()
  if (!readiness.ok) throw new Error(`AGENT_NOT_READY: ${readiness.reason}`)
}

// 起動・再開に共通する後処理（完了通知・PID 記録・PTY 出力のレンダラー転送）
function attachSession(deps: StartTaskDeps, provider: AgentProvider, taskId: string, workdir: string): void {
  const { taskService, terminalService, getWindow, getSettings, stopHookService } = deps

  if (stopHookService) {
    // Set 化により登録が積み上がるため、起動のたびに前回分を破棄する
    stopHookService.removeTaskCallback(taskId)
    stopHookService.onTaskComplete(taskId, async () => {
      const currentTask = taskService.list().find((t) => t.id === taskId)
      if (!currentTask || currentTask.status === 'done') return
      const { notificationsEnabled = true } = getSettings()
      if (!notificationsEnabled) return
      const notification = new Notification({
        title: `${provider.displayName} が完了しました`,
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
  if (pid) taskService.update(taskId, { pid, workdir })

  terminalService.onData(taskId, (data) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('terminal:data', { taskId, data })
  })
}

export function createStartTaskFn(deps: StartTaskDeps): StartTaskFn {
  // 起動前チェック（codex doctor は初回10秒ほどかかる）の間はまだ will_do のままなので、
  // ボタンの連打や MCP との同時起動で同じタスクに PTY が2本立たないよう、起動中のタスクを覚えておく
  const starting = new Set<string>()
  return async (taskId: string, launchMode?: LaunchMode, model?: ClaudeModel, options?: StartTaskOptions) => {
    if (starting.has(taskId)) throw new Error('ALREADY_STARTING')
    starting.add(taskId)
    try {
      await startTaskOnce(deps, taskId, launchMode, model, options)
    } finally {
      starting.delete(taskId)
    }
  }
}

async function startTaskOnce(
  deps: StartTaskDeps,
  taskId: string,
  launchMode?: LaunchMode,
  model?: ClaudeModel,
  options?: StartTaskOptions
): Promise<void> {
  const { claudeService, taskService, gitService, agentRegistry, getWindow, getSettings } = deps
  const tasks = taskService.list()
  const task = tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)

  const provider = agentRegistry.get(task.agent)
  await ensureAgentReady(provider)

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
    // 同一リポジトリ内のdoingタスクのみで占有判定（別リポジトリの同名paneを除外）
    // repoId未設定のタスクはrepos[0]に属するとみなす（MCP経由作成タスクの互換性）
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

  // rotation 経由の再起動では checkout しない（未コミット変更の破棄は人の判断が必要なため）
  // checkout に失敗してもステータスを doing にしない
  if (!options?.skipCheckout && 'branch' in task && task.branch) {
    const baseBranch = 'baseBranch' in task ? task.baseBranch : undefined
    await gitService.checkout(resolvedWorkdir, task.branch, baseBranch)
  }

  // 事前チェックが全て通ってからステータス・paneをdoingに変更
  taskService.update(taskId, { status: 'doing', pane: assignedPane })

  try {
    // ターミナルリセットを先にレンダラーへ通知（古い表示を消す）
    getWindow()?.webContents.send('terminal:reset', taskId)

    let rawPrompt: string | undefined
    if (task.type === 'orchestrate') {
      // orchestrate: システムプロンプト + メモリディレクトリ + ミッション説明を結合
      const systemPrompt = settings.orchestrateSystemPrompt ?? DEFAULT_ORCHESTRATE_SYSTEM_PROMPT
      rawPrompt = buildOrchestratePrompt(taskId, systemPrompt, task.prompt)
    } else {
      rawPrompt = options?.promptOverride || task.prompt || settings.promptTemplates?.[task.type]
    }
    const expandedPrompt = rawPrompt ? (task.type === 'orchestrate' ? rawPrompt : interpolateTemplate(rawPrompt, task)) : undefined
    // 画像を起動引数で添付できるエージェントには、プロンプトにパスを書かずに引数で渡す
    const imagesAsArgument = provider.capabilities.imageInput === 'argument'
    const basePrompt = imagesAsArgument ? expandedPrompt : appendImageSection(expandedPrompt, task)
    // bootPrompt は置換ではなく追加（置換すると orchestrate のシステムプロンプトとメモリ案内が失われる）
    const taskPrompt = options?.extraPrompt
      ? [basePrompt, options.extraPrompt].filter(Boolean).join('\n\n')
      : basePrompt
    const effectiveLaunchMode = resolveLaunchMode(launchMode, task.type === 'research', settings)
    // 起動前に採番できないエージェント（Codex）は SessionStart hook で受け取るまで空にしておく。
    // 前回のセッションIDが残っていると、再開ボタンが古いセッションを開いてしまう
    const sessionId = provider.capabilities.presetSessionId ? randomUUID() : undefined
    taskService.update(taskId, { sessionId, transcriptPath: undefined, lastLaunchMode: effectiveLaunchMode, lastModel: model })
    claudeService.start(taskId, resolvedWorkdir, provider, {
      prompt: taskPrompt,
      images: imagesAsArgument ? task.images : undefined,
      launchMode: effectiveLaunchMode,
      model,
      cols: options?.cols,
      rows: options?.rows,
      sessionId,
    })

    // ローテーション未対応のエージェントでは、有効にしていても動かないことをカードに出す
    const rotationRequested = task.rotation?.enabled ?? settings.rotationDefaults?.enabled ?? false
    if (rotationRequested && !provider.capabilities.rotation) {
      taskService.update(taskId, {
        rotationDisabledReason: `${provider.displayName} はセッションローテーションに未対応です（#78 で対応予定）`,
      })
    }

    attachSession(deps, provider, taskId, resolvedWorkdir)
  } catch (startError) {
    // 起動に失敗したらステータスを元に戻す
    taskService.update(taskId, { status: 'will_do' })
    throw startError
  }
}

export function registerClaudeHandlers(deps: StartTaskDeps, startTask: StartTaskFn): void {
  const { claudeService, taskService, gitService, agentRegistry, getWindow, getSettings } = deps

  // モデル一覧はエージェントに従属する（未指定は claude）
  ipcMain.handle('claude:list-models', (_, agentId?: AgentId) => agentRegistry.get(agentId).listModels())

  ipcMain.handle(
    'claude:start',
    async (
      _,
      { taskId, prompt, cols, rows, launchMode, model }: { taskId: string; workdir: string; prompt?: string; cols?: number; rows?: number; launchMode?: LaunchMode; model?: ClaudeModel }
    ) => {
      try {
        await startTask(taskId, launchMode, model, { promptOverride: prompt, cols, rows })
      } catch (error) {
        throw new Error(`Failed to start agent: ${(error as Error).message}`)
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

        const provider = agentRegistry.get(task.agent)
        await ensureAgentReady(provider)

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
          taskService.update(taskId, { lastLaunchMode: effectiveLaunchMode, lastModel: model })
          claudeService.start(taskId, resolvedWorkdir, provider, {
            launchMode: effectiveLaunchMode,
            model,
            cols,
            rows,
            resumeSessionId: sessionId,
          })

          attachSession(deps, provider, taskId, resolvedWorkdir)
        } catch (startError) {
          taskService.update(taskId, { status: 'done' })
          throw startError
        }
      } catch (error) {
        throw new Error(`Failed to resume agent: ${(error as Error).message}`)
      }
    }
  )
}
