import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { LocalHttpServer } from './LocalHttpServer.js'
import type { TaskService } from './TaskService.js'
import type { DevServerService } from './DevServerService.js'
import type { Task } from '../../../src/types/task.js'
import type { AppSettings } from '../../../src/types/ipc.js'

export class McpServerService {
  constructor(
    localServer: LocalHttpServer,
    taskService: TaskService,
    devServerService: DevServerService,
    getSettings: () => AppSettings,
    notifyTasksUpdated: () => void = () => {},
    startTask?: (taskId: string) => Promise<void>
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
                ticket: { type: 'string', description: 'WrikeチケットURL' },
                prompt: { type: 'string', description: 'Claude に渡すプロンプト' },
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
              },
              required: ['id'],
            },
          },
          {
            name: 'list_dev_servers',
            description:
              '設定済みの開発サーバーの一覧と起動状態を取得する。start_dev_server / stop_dev_server に使う repoId / paneId / label がわかる',
            inputSchema: { type: 'object' as const, properties: {} },
          },
          {
            name: 'start_dev_server',
            description:
              '開発サーバーを起動する。すでに起動中の場合は再起動される。起動は非同期のため、結果は list_dev_servers で確認できる',
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
              if (type !== 'chore' && !rest.repoId) {
                throw new Error('repoId is required for non-chore tasks. Use list_repos to get valid repo IDs.')
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
              const { id } = args as { id: string }
              if (!startTask) {
                throw new Error('start_task is not available')
              }
              await startTask(id)
              notifyTasksUpdated()
              const task = taskService.list().find((t) => t.id === id)
              return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] }
            }
            case 'list_dev_servers': {
              const statuses = devServerService.status()
              const servers = getSettings().repos.flatMap((repo) =>
                repo.panes.flatMap((pane) =>
                  pane.devServers.map((server) => {
                    const status = statuses.find(
                      (s) => s.repoId === repo.id && s.paneId === pane.id && s.label === server.label
                    )
                    return {
                      repoId: repo.id,
                      repoName: repo.name,
                      paneId: pane.id,
                      label: server.label,
                      port: server.port,
                      running: status?.running ?? false,
                      pid: status?.pid,
                    }
                  })
                )
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
