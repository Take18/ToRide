import { useState, useEffect, useCallback } from 'react'
import type { AgentCapabilities, AgentId, AgentInfo, AppSettings, CodexStatus, CodexTrustResult } from '../../types/ipc'
import type { TaskType } from '../../types/task'
import { DEFAULT_AGENT_ID } from '../../utils/agent'

const TASK_TYPES: TaskType[] = ['feat', 'design', 'review', 'bugfix', 'research', 'chore', 'orchestrate']

// 能力の一覧表の行。値をそのまま出すと意味が通らないので、読める言葉にしてから出す
const CAPABILITY_ROWS: { label: string; render: (c: AgentCapabilities) => { text: string; ok: boolean } }[] = [
  {
    label: '初期プロンプト',
    render: (c) => ({ text: c.initialPrompt === 'inject' ? '起動後に入力欄へ注入' : '起動引数で渡す', ok: true }),
  },
  {
    label: '添付画像',
    render: (c) => ({ text: c.imageInput === 'prompt' ? 'パスをプロンプトに書く' : '起動引数で添付', ok: true }),
  },
  {
    label: 'plan モード',
    render: (c) => ({
      text: c.planMode === 'flag' ? '起動フラグ' : c.planMode === 'slash' ? '起動後に /plan を送る' : '未対応',
      ok: c.planMode !== 'none',
    }),
  },
  {
    label: 'セッション再開',
    render: (c) => ({
      text: c.presetSessionId ? '起動前にIDを採番' : '起動後に hook でIDを受け取る',
      ok: true,
    }),
  },
  {
    label: 'コンテキスト表示',
    render: (c) =>
      c.contextSource === 'statusline'
        ? { text: 'Status Line Hook', ok: true }
        : { text: '未対応（#77 で対応予定）', ok: false },
  },
  {
    label: 'PR URL の自動検知',
    render: (c) => (c.prDetection ? { text: '対応', ok: true } : { text: '未対応', ok: false }),
  },
  {
    label: 'セッションローテーション',
    render: (c) => (c.rotation ? { text: '対応', ok: true } : { text: '未対応（#78 で対応予定）', ok: false }),
  },
]

const selectClass = 'bg-gray-700 border border-gray-600 rounded px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500'

type DefaultsProps = {
  agents: AgentInfo[]
  settings: AppSettings
  setSettings: React.Dispatch<React.SetStateAction<AppSettings>>
}

/** 既定のエージェント（全体・タスクタイプ別）と、エージェントごとの能力の一覧 */
export function AgentDefaultsSection({ agents, settings, setSettings }: DefaultsProps) {
  const options = agents.length > 0 ? agents : [{ id: DEFAULT_AGENT_ID, displayName: 'Claude' } as AgentInfo]
  const globalDefault = settings.defaultAgentId ?? DEFAULT_AGENT_ID

  const setTypeDefault = (type: TaskType, value: string) => {
    setSettings((prev) => {
      const next = { ...(prev.agentDefaults ?? {}) }
      if (value) next[type] = value as AgentId
      else delete next[type]
      return { ...prev, agentDefaults: next }
    })
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-300 mb-2">エージェント</h2>
      <p className="text-xs text-gray-500 mb-3">
        タスクを作るときに選ばれているエージェントです。タスクごとにフォームで変えられます。
        起動ボタンで選ぶモードとモデルの候補は、タスクのエージェントに合わせて変わります。
      </p>
      <div className="bg-gray-800 rounded-lg p-4 space-y-4">
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400 w-24">全体の既定</span>
          <select
            value={globalDefault}
            onChange={(e) => setSettings((prev) => ({ ...prev, defaultAgentId: e.target.value as AgentId }))}
            className={selectClass}
          >
            {options.map((a) => (
              <option key={a.id} value={a.id}>{a.displayName}</option>
            ))}
          </select>
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-2">タスクタイプ別（全体の既定より優先）</div>
          <div className="grid grid-cols-2 gap-2">
            {TASK_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2">
                <span className="text-xs font-mono text-gray-300 w-24">{type}</span>
                <select
                  value={settings.agentDefaults?.[type] ?? ''}
                  onChange={(e) => setTypeDefault(type, e.target.value)}
                  className={selectClass}
                >
                  <option value="">全体の既定に従う</option>
                  {options.map((a) => (
                    <option key={a.id} value={a.id}>{a.displayName}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>

        {agents.length > 0 && (
          <div>
            <div className="text-xs text-gray-400 mb-2">エージェントごとの能力</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400">
                  <th className="text-left font-normal py-1 pr-2"></th>
                  {agents.map((a) => (
                    <th key={a.id} className="text-left font-medium text-gray-300 py-1 pr-2">{a.displayName}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {CAPABILITY_ROWS.map((row) => (
                  <tr key={row.label} className="border-t border-gray-700">
                    <td className="text-gray-400 py-1 pr-2 whitespace-nowrap">{row.label}</td>
                    {agents.map((a) => {
                      const { text, ok } = row.render(a.capabilities)
                      return (
                        <td key={a.id} className={`py-1 pr-2 ${ok ? 'text-gray-300' : 'text-yellow-400'}`}>{text}</td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  )
}

function formatTrustResult(result: CodexTrustResult): { message: string; ok: boolean } {
  if (result.error) return { message: `書き込みに失敗しました: ${result.error}`, ok: false }
  const parts: string[] = []
  if (result.added.length > 0) parts.push(`${result.added.length}件を信頼済みにしました`)
  if (result.alreadyTrusted.length > 0) parts.push(`${result.alreadyTrusted.length}件は信頼済みでした`)
  if (result.skipped.length > 0) {
    parts.push(
      `${result.skipped.length}件は trust_level が trusted 以外で書かれているため変更していません（~/.codex/config.toml を直接直してください）`
    )
  }
  return { message: parts.join('。') || '登録済みのペインがありません', ok: result.skipped.length === 0 }
}

/** Codex 連携: ログイン状態とペインの信頼状態 */
export function CodexSection() {
  const [status, setStatus] = useState<CodexStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [trusting, setTrusting] = useState(false)
  const [trustMessage, setTrustMessage] = useState<{ message: string; ok: boolean } | null>(null)

  const load = useCallback((refresh: boolean) => {
    setLoading(true)
    window.api.codex
      .status(refresh)
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load(false)
  }, [load])

  const handleTrust = async () => {
    setTrusting(true)
    setTrustMessage(null)
    try {
      setTrustMessage(formatTrustResult(await window.api.codex.trustPanes()))
      load(false)
    } catch (e) {
      setTrustMessage({ message: (e as Error).message, ok: false })
    } finally {
      setTrusting(false)
    }
  }

  // 同じリポジトリの複数ペイン（worktree）は Codex 上では1件になるため、キーでまとめて出す
  const projects = new Map<string, { trustLevel?: string; panes: string[] }>()
  for (const pane of status?.panes ?? []) {
    const entry = projects.get(pane.projectKey) ?? { trustLevel: pane.trustLevel, panes: [] }
    entry.panes.push(`${pane.repoName}/${pane.paneId}`)
    projects.set(pane.projectKey, entry)
  }
  const untrustedCount = [...projects.values()].filter((p) => p.trustLevel !== 'trusted').length

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-300 mb-2">Codex 連携</h2>
      <p className="text-xs text-gray-500 mb-3">
        Codex は初めて開くディレクトリで「Do you trust the contents of this directory」の確認を出し、選ぶまで開始しません。
        この確認は起動オプションでは消せず、<code className="text-gray-300">~/.codex/config.toml</code> の
        <code className="text-gray-300"> trust_level</code> だけが効きます。下のボタンを押すと、登録済みペインを信頼済みとして書き込みます
        （既存の設定には触らず、足りないエントリを末尾に足すだけです）。
        完了検知・セッションID・MCP は起動のたびに <code className="text-gray-300">-c</code> で渡すので、インストールは要りません。
      </p>
      <div className="bg-gray-800 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 w-16">ログイン</span>
          {status === null ? (
            <span className="text-xs text-gray-500">{loading ? '確認中...（codex doctor に10秒ほどかかります）' : '確認できませんでした'}</span>
          ) : status.loggedIn ? (
            <span className="text-xs text-green-400">✅ ログイン済み</span>
          ) : (
            <span className="text-xs text-yellow-400 break-all">⚠ {status.reason}</span>
          )}
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="ml-auto px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 disabled:opacity-40"
          >
            {loading ? '確認中...' : '再確認'}
          </button>
        </div>

        <div>
          <div className="text-xs text-gray-400 mb-1">ペインの信頼状態</div>
          {projects.size === 0 ? (
            <p className="text-xs text-gray-500">{status === null ? '—' : '登録済みのペインがありません'}</p>
          ) : (
            <ul className="space-y-1">
              {[...projects.entries()].map(([key, p]) => (
                <li key={key} className="text-xs flex gap-2">
                  <span className={p.trustLevel === 'trusted' ? 'text-green-400' : p.trustLevel ? 'text-yellow-400' : 'text-gray-400'}>
                    {p.trustLevel === 'trusted' ? '✅' : p.trustLevel ? `⚠ ${p.trustLevel}` : '⬜'}
                  </span>
                  <span className="font-mono text-gray-300 break-all">{key}</span>
                  <span className="text-gray-500 shrink-0">（{p.panes.join(', ')}）</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={handleTrust}
            disabled={trusting || untrustedCount === 0}
            className="px-4 py-1.5 rounded text-sm bg-green-700 hover:bg-green-600 text-white disabled:opacity-40"
          >
            {trusting ? '書き込み中...' : 'ペインを信頼済みにする'}
          </button>
          {trustMessage && (
            <span className={`text-xs ${trustMessage.ok ? 'text-green-400' : 'text-yellow-400'}`}>{trustMessage.message}</span>
          )}
        </div>
      </div>
    </section>
  )
}
