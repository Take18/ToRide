import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { LocalHttpServer } from './LocalHttpServer.js'
import type { TaskService } from './TaskService.js'
import type { DevServerService } from './DevServerService.js'
import type { Task } from '../../../src/types/task.js'
import type { AppSettings, ClaudeModel, LaunchMode } from '../../../src/types/ipc.js'
import { resolveDevServerUrl } from '../../../src/utils/devServerUrl.js'

export type NotifyLevel = 'info' | 'question' | 'warning'

export type McpUserNotification = {
  level: NotifyLevel
  message: string
  /** 通知タイトルに使う見出し（タスクタイトル等）。特定できなければ undefined */
  title?: string
  /** クリック時にジャンプするタスク。特定できなければ undefined */
  taskId?: string
}

const NOTIFY_LEVELS: NotifyLevel[] = ['info', 'question', 'warning']

/** タイトル文字列から対象タスクを引く。doing のタスクを優先し、完全一致 → 部分一致で探す */
const findTaskByTitle = (tasks: Task[], title: string): Task | undefined => {
  const norm = (s: string) => s.trim().toLowerCase()
  const target = norm(title)
  if (!target) return undefined
  const ordered = [...tasks].sort(
    (a, b) => Number(b.status === 'doing') - Number(a.status === 'doing')
  )
  return (
    ordered.find((t) => norm(t.title) === target) ??
    ordered.find((t) => norm(t.title).includes(target) || target.includes(norm(t.title)))
  )
}

export class McpServerService {
  constructor(
    localServer: LocalHttpServer,
    taskService: TaskService,
    devServerService: DevServerService,
    getSettings: () => AppSettings,
    notifyTasksUpdated: () => void = () => {},
    startTask?: (taskId: string, launchMode?: LaunchMode, model?: ClaudeModel) => Promise<void>,
    notifyUser?: (notification: McpUserNotification) => void
  ) {
    const createServer = (): Server => {
      const server = new Server(
        { name: 'toride', version: '1.0.0' },
        { capabilities: { tools: {} } }
      )

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'create_task',
            description: 'ToRide にタスクを登録する',
            inputSchema: {
              type: 'object' as const,
              properties: {
                type: {
                  type: 'string',
                  enum: ['feat', 'bugfix', 'review', 'research', 'design', 'chore', 'orchestrate'],
                  description: 'タスクのタイプ',
                },
                title: { type: 'string', description: 'タスクのタイトル' },
                branch: { type: 'string', description: 'ブランチ名（type が feat/bugfix/research の場合は必須）' },
                baseBranch: { type: 'string', description: '分岐元ブランチ名' },
                ticket: {
                  type: 'string',
                  description:
                    'WrikeチケットURL（type が feat/bugfix の場合は必須）。会話やミッションにチケットURLが含まれていれば必ず設定し、不明な場合は空のまま作成せずユーザーに確認すること',
                },
                prompt: {
                  type: 'string',
                  description:
                    'Claude に渡すプロンプト。省略すると設定済みのタスクタイプ別テンプレートが自動適用されるため、タスク固有の指示がなければ省略を推奨。' +
                    '指定した場合はテンプレートの代わりにこのプロンプトが使われる。プロンプト内では {title} {branch} {ticket} {pr-url} {output} {directory} のテンプレート変数が起動時に展開されるため、' +
                    'title・branch・ticket 等の他フィールドの値を直書きせず変数で参照すること',
                },
                repoId: { type: 'string', description: 'リポジトリID（chore以外のタイプでは必須。list_repos で確認可能）' },
                url: { type: 'string', description: 'GitHub PR URL（type が review の場合は必須）' },
                output: { type: 'string', description: '出力先パス（type が design の場合は必須）' },
                directory: { type: 'string', description: '作業ディレクトリ（type が chore の場合は必須）' },
                depends_on: { type: 'string', description: '依存するタスクの ID。指定したタスクが完了するまでこのタスクを開始できない' },
              },
              required: ['type', 'title'],
            },
          },
          {
            name: 'list_tasks',
            description: '現在登録されているタスクの一覧を取得する',
            inputSchema: {
              type: 'object' as const,
              properties: {
                status: {
                  type: 'string',
                  enum: ['will_do', 'doing', 'done'],
                  description: 'フィルタするステータス（省略時は全件）',
                },
              },
            },
          },
          {
            name: 'list_repos',
            description: '設定済みのリポジトリ一覧を取得する。create_task の repoId に使う値がわかる',
            inputSchema: { type: 'object' as const, properties: {} },
          },
          {
            name: 'update_task',
            description: 'タスクのステータスやプロンプトを更新する',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', description: 'タスクID' },
                status: {
                  type: 'string',
                  enum: ['will_do', 'doing', 'done'],
                  description: '新しいステータス',
                },
                prompt: { type: 'string', description: '新しいプロンプト' },
                depends_on: { type: 'string', description: '依存するタスクの ID（空文字で依存関係を解除）' },
              },
              required: ['id'],
            },
          },
          {
            name: 'delete_task',
            description: 'タスクを削除する',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', description: 'タスクID' },
              },
              required: ['id'],
            },
          },
          {
            name: 'start_task',
            description: 'タスクを起動する（doing 状態にして Claude を起動）。空きペインがない場合はエラーになる',
            inputSchema: {
              type: 'object' as const,
              properties: {
                id: { type: 'string', description: 'タスクID' },
                launchMode: {
                  type: 'string',
                  enum: ['normal', 'auto', 'bypass', 'plan'],
                  description: 'Claude の起動モード。省略時は設定値に従う。bypass=--dangerously-skip-permissions, auto=--permission-mode auto, plan=--permission-mode plan, normal=デフォルト',
                },
                model: {
                  type: 'string',
                  description:
                    'Claude のモデル。default（または省略）は --model 指定なし。エイリアス（opus / sonnet / haiku / fable 等）またはフルモデルID（claude-fable-5 等）を指定すると --model <値> で起動する',
                },
              },
              required: ['id'],
            },
          },
          {
            name: 'list_dev_servers',
            description:
              '設定済みの開発サーバーの一覧と起動状態を取得する。各エントリに repoId / paneId / label / workdir（作業ディレクトリ）/ runningTaskId（そのペインで実行中のタスクID）/ runningTaskTitle が含まれる。' +
              'start_dev_server を呼ぶ前に必ずこのツールを呼び出し、現在の自分のタスクIDと runningTaskId が一致するペインを選ぶこと。一致するペインが存在しない場合は workdir でカレントディレクトリと照合して選ぶこと。',
            inputSchema: { type: 'object' as const, properties: {} },
          },
          {
            name: 'start_dev_server',
            description:
              '開発サーバーを起動する。すでに起動中の場合は再起動される。起動は非同期のため、結果は list_dev_servers で確認できる。' +
              '呼び出す前に list_dev_servers で現在のタスクが動いているペイン（runningTaskId が自分のタスクIDと一致するもの）を特定し、そのペインの repoId / paneId を使うこと。',
            inputSchema: {
              type: 'object' as const,
              properties: {
                repoId: { type: 'string', description: 'リポジトリID（list_dev_servers で確認可能）' },
                paneId: { type: 'string', description: 'ペインID' },
                label: { type: 'string', description: '開発サーバーのラベル' },
              },
              required: ['repoId', 'paneId', 'label'],
            },
          },
          {
            name: 'notify_user',
            description:
              'ユーザーのデスクトップに通知を送る。ユーザーの判断・入力を仰ぎたいとき（質問する直前など）や、ユーザーが知るべき警告・重要な結果が出たときに呼ぶ。' +
              '進捗の逐次報告や、そのまま作業を続行できる内容では呼ばないこと（通知が埋もれて役に立たなくなる）。',
            inputSchema: {
              type: 'object' as const,
              properties: {
                message: {
                  type: 'string',
                  description: '通知の本文。通知欄で読み切れる1〜2文で要点を書く',
                },
                level: {
                  type: 'string',
                  enum: ['info', 'question', 'warning'],
                  description:
                    '通知の種別。question=ユーザーの入力・判断を待っている、warning=注意が必要な事象、info=単なるお知らせ（省略時は info）',
                },
                title: {
                  type: 'string',
                  description: '通知タイトルに使う短い見出し。省略時は taskTitle / taskId から解決したタスク名が使われる',
                },
                taskTitle: {
                  type: 'string',
                  description:
                    '自分が担当しているタスクのタイトル。通知クリックで該当タスクへジャンプさせるために使う。分かる範囲で指定する',
                },
                taskId: {
                  type: 'string',
                  description: 'タスクID（分かる場合のみ。taskTitle より優先される。list_tasks で確認可能）',
                },
              },
              required: ['message'],
            },
          },
          {
            name: 'stop_dev_server',
            description: '起動中の開発サーバーを停止する',
            inputSchema: {
              type: 'object' as const,
              properties: {
                repoId: { type: 'string', description: 'リポジトリID（list_dev_servers で確認可能）' },
                paneId: { type: 'string', description: 'ペインID' },
                label: { type: 'string', description: '開発サーバーのラベル' },
              },
              required: ['repoId', 'paneId', 'label'],
            },
          },
        ],
      }))

      server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const args = (req.params.arguments ?? {}) as Record<string, unknown>
        try {
          switch (req.params.name) {
            case 'list_repos': {
              const repos = getSettings().repos.map((r) => ({ id: r.id, name: r.name }))
              return { content: [{ type: 'text' as const, text: JSON.stringify(repos, null, 2) }] }
            }
            case 'create_task': {
              const { type, title, status, pane, ...rest } = args as {
                type: Task['type']
                title: string
                status?: Task['status']
                pane?: string
                [key: string]: unknown
              }
              if (type !== 'chore' && type !== 'orchestrate' && !rest.repoId) {
                throw new Error('repoId is required for non-chore tasks. Use list_repos to get valid repo IDs.')
              }
              if ((type === 'feat' || type === 'bugfix') && !rest.ticket) {
                throw new Error(
                  'ticket is required for feat/bugfix tasks. Provide the Wrike ticket URL, or ask the user for it if unknown.'
                )
              }
              const task = taskService.create({
                type,
                title,
                status: status ?? 'will_do',
                pane: pane ?? '',
                ...rest,
              } as Omit<Task, 'id' | 'created_at'>)
              notifyTasksUpdated()
              return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] }
            }
            case 'list_tasks': {
              const tasks = taskService.list()
              const filtered = args.status
                ? tasks.filter((t) => t.status === args.status)
                : tasks
              return { content: [{ type: 'text' as const, text: JSON.stringify(filtered, null, 2) }] }
            }
            case 'update_task': {
              const { id, ...data } = args as { id: string } & Record<string, unknown>
              const task = taskService.update(id, data as Partial<Task>)
              notifyTasksUpdated()
              return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] }
            }
            case 'delete_task': {
              const { id } = args as { id: string }
              taskService.delete(id)
              notifyTasksUpdated()
              return { content: [{ type: 'text' as const, text: `deleted: ${id}` }] }
            }
            case 'start_task': {
              const { id, launchMode, model } = args as { id: string; launchMode?: LaunchMode; model?: ClaudeModel }
              if (!startTask) {
                throw new Error('start_task is not available')
              }
              await startTask(id, launchMode, model)
              notifyTasksUpdated()
              const task = taskService.list().find((t) => t.id === id)
              return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] }
            }
            case 'list_dev_servers': {
              const statuses = devServerService.status()
              const doingTasks = taskService.list().filter((t) => t.status === 'doing')
              const servers = getSettings().repos.flatMap((repo) =>
                repo.panes.flatMap((pane) => {
                  const runningTask = doingTasks.find(
                    (t) => t.repoId === repo.id && t.pane === pane.id
                  )
                  return pane.devServers.map((server) => {
                    const status = statuses.find(
                      (s) => s.repoId === repo.id && s.paneId === pane.id && s.label === server.label
                    )
                    return {
                      repoId: repo.id,
                      repoName: repo.name,
                      paneId: pane.id,
                      workdir: pane.path,
                      runningTaskId: runningTask?.id ?? null,
                      runningTaskTitle: runningTask?.title ?? null,
                      label: server.label,
                      url: resolveDevServerUrl(server.url) ?? null,
                      running: status?.running ?? false,
                      pid: status?.pid,
                    }
                  })
                })
              )
              return { content: [{ type: 'text' as const, text: JSON.stringify(servers, null, 2) }] }
            }
            case 'start_dev_server': {
              const { repoId, paneId, label } = args as { repoId: string; paneId: string; label: string }
              const repo = getSettings().repos.find((r) => r.id === repoId)
              if (!repo) {
                throw new Error(`Repo not found: ${repoId}. Use list_dev_servers to get valid IDs.`)
              }
              const paneConfig = repo.panes.find((p) => p.id === paneId)
              if (!paneConfig) {
                throw new Error(`Pane not found: ${paneId} in repo ${repoId}`)
              }
              const serverConfig = paneConfig.devServers.find((s) => s.label === label)
              if (!serverConfig) {
                throw new Error(`Dev server not found: ${label} in pane ${paneId}`)
              }
              devServerService.start(repoId, paneConfig, serverConfig)
              return { content: [{ type: 'text' as const, text: `started: ${repoId}:${paneId}:${label}` }] }
            }
            case 'notify_user': {
              const { message, level, title, taskTitle, taskId } = args as {
                message?: string
                level?: NotifyLevel
                title?: string
                taskTitle?: string
                taskId?: string
              }
              if (!notifyUser) {
                throw new Error('notify_user is not available')
              }
              if (typeof message !== 'string' || !message.trim()) {
                throw new Error('message is required')
              }
              const resolvedLevel = level ?? 'info'
              if (!NOTIFY_LEVELS.includes(resolvedLevel)) {
                throw new Error(`Invalid level: ${resolvedLevel}. Use one of ${NOTIFY_LEVELS.join(' / ')}`)
              }
              const tasks = taskService.list()
              const task =
                (taskId ? tasks.find((t) => t.id === taskId) : undefined) ??
                (taskTitle ? findTaskByTitle(tasks, taskTitle) : undefined)
              notifyUser({
                level: resolvedLevel,
                message: message.trim(),
                title: title?.trim() || task?.title || taskTitle?.trim() || undefined,
                taskId: task?.id,
              })
              return { content: [{ type: 'text' as const, text: 'notified' }] }
            }
            case 'stop_dev_server': {
              const { repoId, paneId, label } = args as { repoId: string; paneId: string; label: string }
              devServerService.stop(repoId, paneId, label)
              return { content: [{ type: 'text' as const, text: `stopped: ${repoId}:${paneId}:${label}` }] }
            }
            default:
              throw new Error(`Unknown tool: ${req.params.name}`)
          }
        } catch (e) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }],
            isError: true,
          }
        }
      })

      return server
    }

    // StreamableHTTP エンドポイント (GET/POST /mcp)
    localServer.addRawRoute('/mcp', async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      const server = createServer()
      await server.connect(transport)
      await transport.handleRequest(req, res)
    })
  }
}
