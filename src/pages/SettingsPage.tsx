import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  AppSettings,
  RepoConfig,
  PaneConfig,
  DevServerConfig,
  GitHubTokenEntry
} from '../types/ipc'
import type { TicketProviderMeta, PluginCatalogEntry } from '../types/plugin'
import ConfirmDialog from '../components/Common/ConfirmDialog'
import Toast from '../components/Common/Toast'

// args配列 ↔ テキスト変換をonBlurで行うinput
function ArgsInput({
  value,
  onChange,
  className,
  placeholder
}: {
  value: string[]
  onChange: (args: string[]) => void
  className?: string
  placeholder?: string
}) {
  const [text, setText] = useState(value.join(' '))

  useEffect(() => {
    setText(value.join(' '))
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(text.split(/\s+/).filter(Boolean))}
      placeholder={placeholder}
      className={className}
    />
  )
}

// Wrike専用：チケットURLからcustomItemTypeIdを確認するヘルパー
function TicketIdChecker({ configured, inputClass }: { configured: boolean; inputClass: string }) {
  const [url, setUrl] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const handleCheck = async () => {
    if (!url.trim() || !configured) return
    setChecking(true)
    setResult(null)
    try {
      const info = await window.api.ticket.fetch(url.trim())
      if (info.meta?.customItemTypeId) {
        setResult(`customItemTypeId: ${info.meta.customItemTypeId}`)
      } else {
        setResult('このチケットにはカスタム項目タイプが設定されていません')
      }
    } catch (e) {
      setResult(`エラー: ${(e as Error).message}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="bg-gray-750 border border-gray-700 rounded p-3">
      <p className="text-xs text-gray-400 mb-2">チケットURLからカスタム項目タイプIDを確認</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setResult(null) }}
          placeholder="チケットURL"
          className={`${inputClass} flex-1 text-xs`}
        />
        <button
          type="button"
          onClick={handleCheck}
          disabled={checking || !url.trim() || !configured}
          className="px-3 py-1.5 rounded text-xs bg-gray-600 hover:bg-gray-500 text-white whitespace-nowrap disabled:opacity-40"
        >
          {checking ? '確認中...' : 'ID確認'}
        </button>
      </div>
      {result && (
        <p className={`text-xs mt-1.5 font-mono ${result.startsWith('エラー') ? 'text-red-400' : 'text-green-400'}`}>
          {result}
        </p>
      )}
    </div>
  )
}

// "owner" / "owner/repo" への正規化（main側の normalizeTokenScope と同じ規則）
function normalizeScope(input: string): string {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
  return trimmed.split('/').filter(Boolean).slice(0, 2).join('/').toLowerCase()
}

function formatExpiration(expiresAt: string): { text: string; className: string } {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return { text: expiresAt, className: 'text-gray-500' }
  const daysLeft = Math.floor((date.getTime() - Date.now()) / 86_400_000)
  const text = `期限: ${date.toLocaleDateString()}（残り${daysLeft}日）`
  if (daysLeft < 0) return { text: `期限切れ: ${date.toLocaleDateString()}`, className: 'text-red-400' }
  if (daysLeft <= 7) return { text, className: 'text-yellow-400' }
  return { text, className: 'text-gray-500' }
}

// fine-grained token を owner / owner/repo 単位で管理するセクション
function GitHubTokenList({
  tokens,
  onChange,
  legacyPatConfigured,
  inputClass
}: {
  tokens: GitHubTokenEntry[]
  onChange: (tokens: GitHubTokenEntry[]) => void
  legacyPatConfigured: boolean
  inputClass: string
}) {
  const [owners, setOwners] = useState<string[]>([])
  const [verifyingIndex, setVerifyingIndex] = useState<number | null>(null)

  useEffect(() => {
    window.api.github.repoOwners().then(setOwners).catch(() => setOwners([]))
  }, [])

  const coveredOwners = new Set(
    tokens
      .filter((t) => t.token.trim())
      .map((t) => normalizeScope(t.scope).split('/')[0])
      .filter(Boolean)
  )
  const uncoveredOwners = owners.filter((o) => !coveredOwners.has(o.toLowerCase()))

  const updateEntry = (index: number, patch: Partial<GitHubTokenEntry>) => {
    onChange(tokens.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }

  const handleVerify = async (index: number) => {
    const entry = tokens[index]
    setVerifyingIndex(index)
    try {
      const result = await window.api.github.verifyToken(entry.scope, entry.token)
      updateEntry(index, {
        expiresAt: result.expiresAt ?? entry.expiresAt,
        lastCheck: { at: new Date().toISOString(), ok: result.ok, message: result.message }
      })
    } catch (e) {
      updateEntry(index, {
        lastCheck: { at: new Date().toISOString(), ok: false, message: (e as Error).message }
      })
    } finally {
      setVerifyingIndex(null)
    }
  }

  return (
    <div className="space-y-3">
      {tokens.length === 0 && (
        <p className="text-xs text-gray-500">
          トークンが未登録です。「トークンを追加」から owner 単位で登録してください。
        </p>
      )}

      {tokens.map((entry, index) => {
        const expiration = entry.expiresAt ? formatExpiration(entry.expiresAt) : null
        return (
          <div key={index} className="bg-gray-750 border border-gray-700 rounded p-3 space-y-2">
            <div className="flex gap-2 items-center">
              <input
                type="text"
                value={entry.scope}
                onChange={(e) => updateEntry(index, { scope: e.target.value })}
                placeholder="owner または owner/repo"
                className={`${inputClass} w-56 text-xs`}
              />
              <input
                type="password"
                value={entry.token}
                onChange={(e) => updateEntry(index, { token: e.target.value })}
                placeholder="github_pat_xxxxxxxx"
                className={`${inputClass} flex-1 text-xs`}
              />
              <button
                type="button"
                onClick={() => handleVerify(index)}
                disabled={verifyingIndex !== null || !entry.scope.trim() || !entry.token.trim()}
                className="px-3 py-1.5 rounded text-xs bg-gray-600 hover:bg-gray-500 text-white whitespace-nowrap disabled:opacity-40"
              >
                {verifyingIndex === index ? '確認中...' : '疎通確認'}
              </button>
              <button
                type="button"
                onClick={() => onChange(tokens.filter((_, i) => i !== index))}
                className="px-2 py-1.5 rounded text-xs bg-red-900/60 hover:bg-red-800 text-red-200"
              >
                削除
              </button>
            </div>

            {(expiration || entry.lastCheck) && (
              <div className="text-xs space-y-0.5">
                {expiration && <p className={expiration.className}>{expiration.text}</p>}
                {entry.lastCheck && (
                  <p className={entry.lastCheck.ok ? 'text-green-400' : 'text-red-400'}>
                    {entry.lastCheck.ok ? '✓ ' : '✗ '}
                    {entry.lastCheck.message}
                  </p>
                )}
              </div>
            )}
          </div>
        )
      })}

      <button
        type="button"
        onClick={() => onChange([...tokens, { scope: '', token: '' }])}
        className="px-3 py-1.5 rounded text-xs bg-gray-600 hover:bg-gray-500 text-white"
      >
        + トークンを追加
      </button>

      {uncoveredOwners.length > 0 && (
        <p className={`text-xs ${legacyPatConfigured ? 'text-gray-500' : 'text-yellow-400'}`}>
          {legacyPatConfigured
            ? `トークン未登録の owner: ${uncoveredOwners.join(', ')}（下の共通PATで動作します）`
            : `トークン未登録の owner: ${uncoveredOwners.join(', ')} — このownerのPRステータス取得・レビュー依頼PR同期は行われません`}
        </p>
      )}
    </div>
  )
}

const TASK_TYPES = ['feat', 'design', 'review', 'bugfix', 'research', 'chore'] as const

const DEFAULT_ORCHESTRATE_PROMPT = `あなたはタスクオーケストレーターです。ToRide MCPツールを使ってミッションを自律的に実行してください。

## 基本方針
- サブタスクは事前に全部作るのではなく、状況に応じて動的に作成・起動する
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
4. list_tasks を定期的に呼び出し、対象タスクの status が "done" になるまで待つ（ポーリング間隔の目安: 30〜60秒）
5. status が "done" を確認したら、メモリファイルを読んで内容を把握し、次のタスクを作成・起動する
6. 全ステップが完了したらミッション達成を報告する

## ⚠️ 重要なルール
- メモリファイルの存在だけでタスク完了と判断してはいけない。必ず list_tasks で status が "done" であることを確認すること
- start_task は非同期。起動直後はまだ "doing" なので、すぐ次に進まず必ずポーリングで完了を確認する
- 空きペインがない場合は start_task がエラーになる。完了待ちのタスクがあれば、それが done になってから再試行する`

type DeleteTarget =
  | { kind: 'repo'; repoIndex: number }
  | { kind: 'pane'; repoIndex: number; paneIndex: number }
  | { kind: 'devserver'; repoIndex: number; paneIndex: number; dsIndex: number }

export default function SettingsPage() {
  const navigate = useNavigate()
  const [settings, setSettings] = useState<AppSettings>({ repos: [], promptTemplates: {} })
  const [providers, setProviders] = useState<TicketProviderMeta[]>([])
  const [catalog, setCatalog] = useState<PluginCatalogEntry[]>([])
  const [pluginLoading, setPluginLoading] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const templateRefs = useRef<Record<string, HTMLTextAreaElement | null>>({})
  const dragSrc = useRef<{ ri: number; pi: number; di: number } | null>(null)
  const [dragOver, setDragOver] = useState<{ ri: number; pi: number; di: number; position: 'top' | 'bottom' } | null>(null)
  const [newExtraPath, setNewExtraPath] = useState('')

  const [, setImportResult] = useState<'ok' | 'cancelled' | 'error' | null>(null)
  const [hookStatus, setHookStatus] = useState<{ installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean } | null>(null)
  const [hookLoading, setHookLoading] = useState(false)
  const [statuslineStatus, setStatuslineStatus] = useState<{ installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean } | null>(null)
  const [statuslineLoading, setStatuslineLoading] = useState(false)
  const [mcpStatus, setMcpStatus] = useState<{ installed: boolean; url: string } | null>(null)
  const [mcpLoading, setMcpLoading] = useState(false)

  useEffect(() => {
    window.api.settings.get().then(setSettings)
    window.api.ticket.providers().then(setProviders).catch(() => setProviders([]))
    window.api.ticket.catalog().then(setCatalog).catch(() => setCatalog([]))
    window.api.hooks.status().then(setHookStatus).catch(() => {})
    window.api.hooks.statuslineStatus().then(setStatuslineStatus).catch(() => {})
    window.api.mcp.status().then(setMcpStatus).catch(() => {})
  }, [])

  const insertTemplateVariable = (type: string, variable: string) => {
    const textarea = templateRefs.current[type]
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const current = settings.promptTemplates?.[type] ?? ''
    const newValue = current.slice(0, start) + variable + current.slice(end)
    setSettings((prev) => ({
      ...prev,
      promptTemplates: { ...prev.promptTemplates, [type]: newValue }
    }))
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = start + variable.length
      textarea.focus()
    })
  }

  const updateRepo = (ri: number, updates: Partial<RepoConfig>) => {
    setSettings((prev) => {
      const repos = [...prev.repos]
      repos[ri] = { ...repos[ri], ...updates }
      return { ...prev, repos }
    })
  }

  const addRepo = () => {
    setSettings((prev) => ({
      ...prev,
      repos: [...prev.repos, { id: '', name: '', panes: [] }]
    }))
  }

  const removeRepo = (ri: number) => {
    setDeleteTarget({ kind: 'repo', repoIndex: ri })
  }

  const updatePane = (ri: number, pi: number, updates: Partial<PaneConfig>) => {
    setSettings((prev) => {
      const repos = [...prev.repos]
      const panes = [...repos[ri].panes]
      panes[pi] = { ...panes[pi], ...updates }
      repos[ri] = { ...repos[ri], panes }
      return { ...prev, repos }
    })
  }

  const addPane = (ri: number) => {
    setSettings((prev) => {
      const repos = [...prev.repos]
      repos[ri] = { ...repos[ri], panes: [...repos[ri].panes, { id: '', path: '', devServers: [] }] }
      return { ...prev, repos }
    })
  }

  const removePane = (ri: number, pi: number) => {
    setDeleteTarget({ kind: 'pane', repoIndex: ri, paneIndex: pi })
  }

  const updateDevServer = (ri: number, pi: number, di: number, updates: Partial<DevServerConfig>) => {
    setSettings((prev) => {
      const repos = [...prev.repos]
      const panes = [...repos[ri].panes]
      const devServers = [...panes[pi].devServers]
      devServers[di] = { ...devServers[di], ...updates }
      panes[pi] = { ...panes[pi], devServers }
      repos[ri] = { ...repos[ri], panes }
      return { ...prev, repos }
    })
  }

  const addDevServer = (ri: number, pi: number) => {
    setSettings((prev) => {
      const repos = [...prev.repos]
      const panes = [...repos[ri].panes]
      panes[pi] = { ...panes[pi], devServers: [...panes[pi].devServers, { label: '', command: '', args: [] }] }
      repos[ri] = { ...repos[ri], panes }
      return { ...prev, repos }
    })
  }

  const removeDevServer = (ri: number, pi: number, di: number) => {
    setDeleteTarget({ kind: 'devserver', repoIndex: ri, paneIndex: pi, dsIndex: di })
  }

  const moveDevServer = (ri: number, pi: number, fromIndex: number, insertBefore: number) => {
    if (insertBefore === fromIndex || insertBefore === fromIndex + 1) return
    setSettings((prev) => {
      const repos = [...prev.repos]
      const panes = [...repos[ri].panes]
      const devServers = [...panes[pi].devServers]
      const item = devServers[fromIndex]
      const result = devServers.filter((_, i) => i !== fromIndex)
      const adjustedIndex = fromIndex < insertBefore ? insertBefore - 1 : insertBefore
      result.splice(adjustedIndex, 0, item)
      panes[pi] = { ...panes[pi], devServers: result }
      repos[ri] = { ...repos[ri], panes }
      return { ...prev, repos }
    })
  }

  const confirmDelete = () => {
    if (!deleteTarget) return
    if (deleteTarget.kind === 'repo') {
      setSettings((prev) => ({
        ...prev,
        repos: prev.repos.filter((_, i) => i !== deleteTarget.repoIndex)
      }))
    } else if (deleteTarget.kind === 'pane') {
      setSettings((prev) => {
        const repos = [...prev.repos]
        repos[deleteTarget.repoIndex] = {
          ...repos[deleteTarget.repoIndex],
          panes: repos[deleteTarget.repoIndex].panes.filter((_, i) => i !== deleteTarget.paneIndex)
        }
        return { ...prev, repos }
      })
    } else {
      setSettings((prev) => {
        const repos = [...prev.repos]
        const panes = [...repos[deleteTarget.repoIndex].panes]
        panes[deleteTarget.paneIndex] = {
          ...panes[deleteTarget.paneIndex],
          devServers: panes[deleteTarget.paneIndex].devServers.filter((_, i) => i !== deleteTarget.dsIndex)
        }
        repos[deleteTarget.repoIndex] = { ...repos[deleteTarget.repoIndex], panes }
        return { ...prev, repos }
      })
    }
    setDeleteTarget(null)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.api.settings.set(settings)
      setToast({ message: '設定を保存しました', type: 'success' })
      window.api.ticket.providers().then(setProviders).catch(() => {})
    } catch {
      setToast({ message: '保存に失敗しました', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const handlePluginToggle = useCallback(async (id: string, currentlyEnabled: boolean) => {
    setPluginLoading(id)
    try {
      if (currentlyEnabled) {
        await window.api.ticket.uninstall(id)
      } else {
        await window.api.ticket.install(id)
      }
      const [newSettings, newProviders] = await Promise.all([
        window.api.settings.get(),
        window.api.ticket.providers().catch(() => [] as TicketProviderMeta[])
      ])
      setSettings(newSettings)
      setProviders(newProviders)
    } catch (e) {
      setToast({ message: `プラグイン操作に失敗しました: ${(e as Error).message}`, type: 'error' })
    } finally {
      setPluginLoading(null)
    }
  }, [])

  const handleHookInstall = useCallback(async () => {
    setHookLoading(true)
    try {
      const result = await window.api.hooks.install()
      if (result.success) {
        setToast({ message: 'Stop Hook をインストールしました', type: 'success' })
        const status = await window.api.hooks.status()
        setHookStatus(status)
      } else {
        setToast({ message: result.error ?? 'インストールに失敗しました', type: 'error' })
      }
    } catch (e) {
      setToast({ message: `エラー: ${(e as Error).message}`, type: 'error' })
    } finally {
      setHookLoading(false)
    }
  }, [])

  const handleHookUninstall = useCallback(async () => {
    setHookLoading(true)
    try {
      const result = await window.api.hooks.uninstall()
      if (result.success) {
        setToast({ message: 'Stop Hook をアンインストールしました', type: 'success' })
        const status = await window.api.hooks.status()
        setHookStatus(status)
      } else {
        setToast({ message: result.error ?? 'アンインストールに失敗しました', type: 'error' })
      }
    } catch (e) {
      setToast({ message: `エラー: ${(e as Error).message}`, type: 'error' })
    } finally {
      setHookLoading(false)
    }
  }, [])

  const handleStatuslineInstall = useCallback(async () => {
    setStatuslineLoading(true)
    try {
      const result = await window.api.hooks.statuslineInstall()
      if (result.success) {
        setToast({ message: 'Status Line Hook をインストールしました', type: 'success' })
        const status = await window.api.hooks.statuslineStatus()
        setStatuslineStatus(status)
      } else {
        setToast({ message: result.error ?? 'インストールに失敗しました', type: 'error' })
      }
    } catch (e) {
      setToast({ message: `エラー: ${(e as Error).message}`, type: 'error' })
    } finally {
      setStatuslineLoading(false)
    }
  }, [])

  const handleStatuslineUninstall = useCallback(async () => {
    setStatuslineLoading(true)
    try {
      const result = await window.api.hooks.statuslineUninstall()
      if (result.success) {
        setToast({ message: 'Status Line Hook をアンインストールしました', type: 'success' })
        const status = await window.api.hooks.statuslineStatus()
        setStatuslineStatus(status)
      } else {
        setToast({ message: result.error ?? 'アンインストールに失敗しました', type: 'error' })
      }
    } catch (e) {
      setToast({ message: `エラー: ${(e as Error).message}`, type: 'error' })
    } finally {
      setStatuslineLoading(false)
    }
  }, [])

  const handleMcpInstall = useCallback(async () => {
    setMcpLoading(true)
    try {
      const result = await window.api.mcp.install()
      if (result.success) {
        setToast({ message: 'MCP サーバを settings.json に登録しました', type: 'success' })
        const status = await window.api.mcp.status()
        setMcpStatus(status)
      } else {
        setToast({ message: result.error ?? '登録に失敗しました', type: 'error' })
      }
    } catch (e) {
      setToast({ message: `エラー: ${(e as Error).message}`, type: 'error' })
    } finally {
      setMcpLoading(false)
    }
  }, [])

  const handleMcpUninstall = useCallback(async () => {
    setMcpLoading(true)
    try {
      const result = await window.api.mcp.uninstall()
      if (result.success) {
        setToast({ message: 'MCP サーバを settings.json から削除しました', type: 'success' })
        const status = await window.api.mcp.status()
        setMcpStatus(status)
      } else {
        setToast({ message: result.error ?? '削除に失敗しました', type: 'error' })
      }
    } catch (e) {
      setToast({ message: `エラー: ${(e as Error).message}`, type: 'error' })
    } finally {
      setMcpLoading(false)
    }
  }, [])


  const inputClass = 'px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-400 focus:outline-none focus:border-blue-500'

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <h1 className="text-lg font-semibold text-white">設定</h1>
        <button
          onClick={() => navigate('/')}
          className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm text-gray-300"
        >
          ダッシュボードに戻る
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Repository / Pane Settings */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-3">リポジトリ / Pane マッピング</h2>

          {settings.repos.map((repo, ri) => (
            <div key={ri} className="bg-gray-800 rounded-lg p-4 mb-4">
              <div className="flex items-center gap-3 mb-3">
                <input
                  type="text"
                  value={repo.id}
                  onChange={(e) => updateRepo(ri, { id: e.target.value })}
                  placeholder="Repo ID (例: repo1)"
                  className={`${inputClass} w-32`}
                />
                <input
                  type="text"
                  value={repo.name}
                  onChange={(e) => updateRepo(ri, { name: e.target.value })}
                  placeholder="表示名 (例: mep-frontend)"
                  className={`${inputClass} flex-1`}
                />
                <button
                  onClick={() => removeRepo(ri)}
                  className="px-2 py-1 rounded text-xs bg-red-600 hover:bg-red-700 text-white"
                >
                  削除
                </button>
              </div>

              <div className="pl-4 border-l-2 border-gray-600 space-y-3">
                <span className="text-xs text-gray-400">Panes</span>
                {repo.panes.map((pane, pi) => (
                  <div key={pi} className="bg-gray-750 border border-gray-700 rounded p-3">
                    <div className="flex items-center gap-3 mb-2">
                      <input
                        type="text"
                        value={pane.id}
                        onChange={(e) => updatePane(ri, pi, { id: e.target.value })}
                        placeholder="Pane ID (例: p1)"
                        className={`${inputClass} w-28`}
                      />
                      <input
                        type="text"
                        value={pane.path}
                        onChange={(e) => updatePane(ri, pi, { path: e.target.value })}
                        placeholder="絶対パス"
                        className={`${inputClass} flex-1`}
                      />
                      <button
                        onClick={async () => {
                          const dir = await window.api.dialog.openDirectory()
                          if (dir) updatePane(ri, pi, { path: dir })
                        }}
                        className="px-2 py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 text-gray-200 whitespace-nowrap"
                      >
                        選択
                      </button>
                      <button
                        onClick={() => removePane(ri, pi)}
                        className="px-2 py-1 rounded text-xs bg-red-600 hover:bg-red-700 text-white"
                      >
                        削除
                      </button>
                    </div>

                    <div className="pl-3 border-l-2 border-gray-700">
                      <span className="text-xs text-gray-500 block mb-1.5">Dev Servers</span>
                      {pane.devServers.map((ds, di) => (
                        <div
                          key={di}
                          draggable
                          onDragStart={() => { dragSrc.current = { ri, pi, di } }}
                          onDragOver={(e) => {
                            e.preventDefault()
                            const rect = e.currentTarget.getBoundingClientRect()
                            const position = e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'
                            setDragOver({ ri, pi, di, position })
                          }}
                          onDragLeave={(e) => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null)
                          }}
                          onDrop={() => {
                            if (dragSrc.current && dragOver && dragOver.ri === ri && dragOver.pi === pi) {
                              const insertBefore = dragOver.position === 'top' ? dragOver.di : dragOver.di + 1
                              moveDevServer(ri, pi, dragSrc.current.di, insertBefore)
                            }
                            dragSrc.current = null
                            setDragOver(null)
                          }}
                          onDragEnd={() => { dragSrc.current = null; setDragOver(null) }}
                          className="relative flex items-center gap-2 mb-2 cursor-default"
                        >
                          {dragOver?.ri === ri && dragOver?.pi === pi && dragOver?.di === di && dragOver?.position === 'top' && (
                            <div className="absolute -top-1 left-0 right-0 h-0.5 bg-blue-400 rounded z-10" />
                          )}
                          {dragOver?.ri === ri && dragOver?.pi === pi && dragOver?.di === di && dragOver?.position === 'bottom' && (
                            <div className="absolute -bottom-1 left-0 right-0 h-0.5 bg-blue-400 rounded z-10" />
                          )}
                          <span className="text-gray-500 cursor-grab active:cursor-grabbing select-none px-0.5" title="ドラッグして並べ替え">⠿</span>
                          <input
                            type="text"
                            value={ds.label}
                            onChange={(e) => updateDevServer(ri, pi, di, { label: e.target.value })}
                            placeholder="Label"
                            className={`${inputClass} flex-[3] min-w-0`}
                          />
                          <input
                            type="text"
                            value={ds.command}
                            onChange={(e) => updateDevServer(ri, pi, di, { command: e.target.value })}
                            placeholder="Command"
                            className={`${inputClass} flex-[2] min-w-0`}
                          />
                          <ArgsInput
                            value={ds.args}
                            onChange={(args) => updateDevServer(ri, pi, di, { args })}
                            placeholder="Args (space sep)"
                            className={`${inputClass} flex-[3] min-w-0`}
                          />
                          <input
                            type="text"
                            value={ds.url ?? ''}
                            onChange={(e) =>
                              updateDevServer(ri, pi, di, { url: e.target.value || undefined })
                            }
                            placeholder="Port / URL"
                            title="ポート番号（例: 3000）またはローカル環境のURL（例: https://localhost.example.test:3000）"
                            className={`${inputClass} flex-[2] min-w-0`}
                          />
                          <button
                            onClick={() => removeDevServer(ri, pi, di)}
                            className="px-2 py-0.5 rounded text-xs bg-red-600 hover:bg-red-700 text-white"
                          >
                            x
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => addDevServer(ri, pi)}
                        className="mt-1 px-2 py-0.5 rounded text-xs bg-gray-600 hover:bg-gray-500 text-gray-300"
                      >
                        + Dev Server追加
                      </button>
                    </div>
                  </div>
                ))}
                <button
                  onClick={() => addPane(ri)}
                  className="px-2 py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 text-gray-300"
                >
                  + Pane追加
                </button>
              </div>
            </div>
          ))}

          <button
            onClick={addRepo}
            className="px-3 py-1 rounded text-xs bg-blue-600 hover:bg-blue-700 text-white"
          >
            + リポジトリ追加
          </button>
        </section>

        {/* Claude Code Stop Hook */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">Claude Code Stop Hook</h2>
          <p className="text-xs text-gray-500 mb-3">
            Stop Hook をインストールすると、Claude Code がタスクを完了した際にステータスを自動で更新します。
          </p>
          <div className="bg-gray-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16">ポート番号</span>
              <input
                type="number"
                min={1024}
                max={65535}
                value={settings.stopHookPort ?? 39457}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, stopHookPort: Number(e.target.value) || 39457 }))
                }
                className={`${inputClass} w-28`}
              />
              <span className="text-xs text-gray-500">Stop Hook・Status Line Hook で共有（変更後は再起動が必要）</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16">インストール先</span>
              <span className="text-xs text-gray-300 font-mono">
                {hookStatus?.path ?? '~/.claude/hooks/stop.sh'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16">状態</span>
              {hookStatus === null ? (
                <span className="text-xs text-gray-500">確認中...</span>
              ) : hookStatus.installed && hookStatus.managedByApp && hookStatus.registeredInSettings ? (
                <span className="text-xs text-green-400">✅ インストール済み・settings.json 登録済み</span>
              ) : hookStatus.installed && hookStatus.managedByApp && !hookStatus.registeredInSettings ? (
                <span className="text-xs text-yellow-400">⚠️ stop.sh はあるが settings.json 未登録（再インストールしてください）</span>
              ) : hookStatus.installed ? (
                <span className="text-xs text-yellow-400">⚠️ 別の stop.sh が存在します（このアプリが管理していません）</span>
              ) : (
                <span className="text-xs text-gray-400">⬜ 未インストール</span>
              )}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleHookInstall}
                disabled={hookLoading || (hookStatus?.installed && hookStatus?.managedByApp && hookStatus?.registeredInSettings)}
                className="px-4 py-1.5 rounded text-sm bg-green-700 hover:bg-green-600 text-white disabled:opacity-40"
              >
                {hookLoading ? '処理中...' : 'インストール'}
              </button>
              <button
                onClick={handleHookUninstall}
                disabled={hookLoading || !hookStatus?.installed || !hookStatus?.managedByApp}
                className="px-4 py-1.5 rounded text-sm bg-red-700 hover:bg-red-600 text-white disabled:opacity-40"
              >
                アンインストール
              </button>
            </div>
          </div>
        </section>

        {/* Status Line Hook */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">Claude Code Status Line Hook</h2>
          <p className="text-xs text-gray-500 mb-3">
            Status Line Hook をインストールすると、Claude の各レスポンス後にコンテキスト使用量がリアルタイム更新されます。
          </p>
          <div className="bg-gray-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16">インストール先</span>
              <span className="text-xs text-gray-300 font-mono">
                {statuslineStatus?.path ?? '~/.claude/statusline.sh'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16">状態</span>
              {statuslineStatus === null ? (
                <span className="text-xs text-gray-500">確認中...</span>
              ) : statuslineStatus.installed && statuslineStatus.managedByApp && statuslineStatus.registeredInSettings ? (
                <span className="text-xs text-green-400">✅ インストール済み・settings.json 登録済み</span>
              ) : statuslineStatus.installed && statuslineStatus.managedByApp && !statuslineStatus.registeredInSettings ? (
                <span className="text-xs text-yellow-400">⚠️ statusline.sh はあるが settings.json 未登録（再インストールしてください）</span>
              ) : statuslineStatus.installed ? (
                <span className="text-xs text-yellow-400">⚠️ 別の statusline.sh が存在します（このアプリが管理していません）</span>
              ) : (
                <span className="text-xs text-gray-400">⬜ 未インストール</span>
              )}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleStatuslineInstall}
                disabled={statuslineLoading || (statuslineStatus?.installed && statuslineStatus?.managedByApp && statuslineStatus?.registeredInSettings)}
                className="px-4 py-1.5 rounded text-sm bg-green-700 hover:bg-green-600 text-white disabled:opacity-40"
              >
                {statuslineLoading ? '処理中...' : 'インストール'}
              </button>
              <button
                onClick={handleStatuslineUninstall}
                disabled={statuslineLoading || !statuslineStatus?.installed || !statuslineStatus?.managedByApp}
                className="px-4 py-1.5 rounded text-sm bg-red-700 hover:bg-red-600 text-white disabled:opacity-40"
              >
                アンインストール
              </button>
            </div>
          </div>
        </section>

        {/* MCP サーバ */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">Claude Code MCP サーバ</h2>
          <p className="text-xs text-gray-500 mb-3">
            インストールすると、Claude Code から <code className="text-gray-300">create_task</code> /
            <code className="text-gray-300"> list_tasks</code> /
            <code className="text-gray-300"> update_task</code> ツールでタスクを直接操作できます。
            インストール後は Claude Code を再起動してください。
          </p>
          <div className="bg-gray-800 rounded-lg p-4 space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16">エンドポイント</span>
              <span className="text-xs text-gray-300 font-mono">
                {mcpStatus?.url || `http://127.0.0.1:${settings.stopHookPort ?? 39457}/mcp`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-400 w-16">状態</span>
              {mcpStatus === null ? (
                <span className="text-xs text-gray-500">確認中...</span>
              ) : mcpStatus.installed ? (
                <span className="text-xs text-green-400">✅ settings.json 登録済み</span>
              ) : (
                <span className="text-xs text-gray-400">⬜ 未登録</span>
              )}
            </div>
            <div className="flex items-center gap-2 pt-1">
              <button
                onClick={handleMcpInstall}
                disabled={mcpLoading || mcpStatus?.installed === true}
                className="px-4 py-1.5 rounded text-sm bg-green-700 hover:bg-green-600 text-white disabled:opacity-40"
              >
                {mcpLoading ? '処理中...' : 'インストール'}
              </button>
              <button
                onClick={handleMcpUninstall}
                disabled={mcpLoading || !mcpStatus?.installed}
                className="px-4 py-1.5 rounded text-sm bg-red-700 hover:bg-red-600 text-white disabled:opacity-40"
              >
                アンインストール
              </button>
            </div>
          </div>
        </section>

        {/* 通知設定 */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">通知</h2>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.notificationsEnabled ?? true}
              onChange={(e) => setSettings((prev) => ({ ...prev, notificationsEnabled: e.target.checked }))}
              className="w-4 h-4 rounded"
            />
            <span className="text-sm text-gray-300">デスクトップ通知を有効にする</span>
          </label>
          <p className="text-xs text-gray-500 mt-1 ml-7">タスク完了・コンテキスト警告・PR同期の通知を表示します</p>
        </section>

        {/* Claude 起動オプション */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">Claude Code 起動オプション（デフォルト）</h2>
          <div className="space-y-2">
            {([
              { value: 'normal', label: 'normal', desc: 'パーミッション確認あり（デフォルト）', color: 'text-gray-300' },
              { value: 'auto',   label: 'auto',   desc: '操作を自動承認して実行（--permission-mode auto）', color: 'text-blue-400' },
              { value: 'bypass', label: 'bypass', desc: 'パーミッション確認なしで実行（--dangerously-skip-permissions）', color: 'text-yellow-400' },
            ] as const).map(({ value, label, desc, color }) => {
              const checked =
                value === 'bypass' ? (settings.useDangerouslySkipPermissions ?? false) :
                value === 'auto'   ? (!settings.useDangerouslySkipPermissions && (settings.useAutoMode ?? false)) :
                (!settings.useDangerouslySkipPermissions && !settings.useAutoMode)
              return (
                <label key={value} className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="radio"
                    name="launchMode"
                    checked={checked}
                    onChange={() => setSettings((prev) => ({
                      ...prev,
                      useAutoMode: value === 'auto',
                      useDangerouslySkipPermissions: value === 'bypass',
                    }))}
                    className="mt-0.5 w-4 h-4"
                  />
                  <span className="text-sm">
                    <span className={`font-mono font-medium ${color}`}>{label}</span>
                    <span className="text-gray-400 ml-2 text-xs">{desc}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </section>

        {/* プロンプトテンプレート */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">プロンプトテンプレート（タスクタイプ別）</h2>
          <p className="text-xs text-gray-500 mb-3">
            タスク開始時に自動送信される初期プロンプト。タスク個別の prompt が優先されます。
            <br />
            <span className="text-gray-400">変数名をクリックするとカーソル位置に挿入できます。</span>
          </p>
          <div className="space-y-3">
            {TASK_TYPES.map((type) => {
              const hints: Record<string, string[]> = {
                feat: ['{branch}', '{ticket}', '{prompt}'],
                design: ['{output}'],
                review: ['{pr-url}'],
                bugfix: ['{branch}', '{ticket}'],
                research: ['{branch}', '{prompt}'],
                chore: ['{directory}'],
              }
              return (
                <div key={type}>
                  <div className="flex items-center gap-2 mb-1">
                    <label className="text-xs text-gray-400 font-mono">{type}</label>
                    <span className="text-xs flex flex-wrap gap-1">
                      <span
                        className="font-mono text-blue-500 cursor-pointer hover:bg-blue-900/40 rounded px-0.5"
                        title="クリックして挿入"
                        onClick={() => insertTemplateVariable(type, '{title}')}
                      >{'{title}'}</span>
                      {hints[type].map((v) => (
                        <span
                          key={v}
                          className="font-mono text-blue-500 cursor-pointer hover:bg-blue-900/40 rounded px-0.5"
                          title="クリックして挿入"
                          onClick={() => insertTemplateVariable(type, v)}
                        >{v}</span>
                      ))}
                    </span>
                  </div>
                  <textarea
                    ref={(el) => { templateRefs.current[type] = el }}
                    value={settings.promptTemplates?.[type] ?? ''}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        promptTemplates: { ...prev.promptTemplates, [type]: e.target.value }
                      }))
                    }
                    placeholder={`${type} タスクの初期プロンプト`}
                    rows={2}
                    className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-y font-mono"
                  />
                </div>
              )
            })}
          </div>
        </section>

        {/* Orchestrate システムプロンプト */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">Orchestrate システムプロンプト</h2>
          <p className="text-xs text-gray-500 mb-3">
            orchestrate タスク起動時に先頭に付与されるプロンプト。MCPツールの使い方や進め方を記述します。
            <br />
            空欄の場合はデフォルトのシステムプロンプトが使われます。
          </p>
          <div className="flex justify-between items-center mb-1">
            <span className="text-xs text-gray-400">カスタムシステムプロンプト</span>
            <button
              type="button"
              onClick={() => setSettings((prev) => ({ ...prev, orchestrateSystemPrompt: '' }))}
              className="text-xs text-gray-500 hover:text-gray-300"
            >
              デフォルトに戻す
            </button>
          </div>
          <textarea
            value={settings.orchestrateSystemPrompt ?? ''}
            onChange={(e) =>
              setSettings((prev) => ({ ...prev, orchestrateSystemPrompt: e.target.value }))
            }
            placeholder={DEFAULT_ORCHESTRATE_PROMPT}
            rows={10}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-600 focus:outline-none focus:border-blue-500 resize-y font-mono"
          />
        </section>

        {/* プラグイン管理 */}
        {catalog.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-300 mb-3">プラグイン管理</h2>
            <div className="space-y-2">
              {catalog.map((entry) => {
                const isEnabled = (settings.enabledPlugins ?? []).includes(entry.id)
                const loading = pluginLoading === entry.id
                return (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between bg-gray-800 rounded px-4 py-3"
                  >
                    <div>
                      <span className="text-sm text-white font-medium">{entry.displayName}</span>
                      <span className="text-xs text-gray-400 ml-3">{entry.description}</span>
                    </div>
                    <button
                      onClick={() => handlePluginToggle(entry.id, isEnabled)}
                      disabled={loading}
                      className={`px-3 py-1 rounded text-xs font-medium whitespace-nowrap disabled:opacity-40 ${
                        isEnabled
                          ? 'bg-red-700 hover:bg-red-600 text-white'
                          : 'bg-green-700 hover:bg-green-600 text-white'
                      }`}
                    >
                      {loading ? '処理中...' : isEnabled ? 'アンインストール' : 'インストール'}
                    </button>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* チケット連携プラグイン設定（動的レンダリング） */}
        {providers.filter((p) => p.settingFields.length > 0 || p.id === 'wrike').map((provider) => (
          <section key={provider.id}>
            <h2 className="text-sm font-semibold text-gray-300 mb-3">{provider.displayName} 連携</h2>
            <div className="space-y-3">
              {provider.settingFields.map((field) => (
                <div key={field.key}>
                  <label className="block text-xs text-gray-400 mb-1">{field.label}</label>
                  <input
                    type={field.type === 'password' ? 'password' : 'text'}
                    value={settings.pluginSettings?.[provider.id]?.[field.key] ?? ''}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        pluginSettings: {
                          ...prev.pluginSettings,
                          [provider.id]: {
                            ...(prev.pluginSettings?.[provider.id] ?? {}),
                            [field.key]: e.target.value,
                          },
                        },
                      }))
                    }
                    placeholder={field.placeholder}
                    className={`${inputClass} w-full max-w-md`}
                  />
                  {field.description && (
                    <p className="text-xs text-gray-500 mt-1">{field.description}</p>
                  )}
                </div>
              ))}
              {provider.id === 'wrike' && (
                <TicketIdChecker configured={provider.configured} inputClass={inputClass} />
              )}
            </div>
          </section>
        ))}

        {/* GitHub トークン（fine-grained） */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">GitHub トークン（fine-grained）</h2>
          <p className="text-xs text-gray-500 mb-3">
            owner または owner/repo 単位でトークンを登録します。使用時は owner/repo → owner → 共通PAT の順に解決されます。
            fine-grained token に必要な権限は Pull requests: Read / Metadata: Read（GitHub Issue チケット利用時は Issues: Read も）です。
          </p>
          <GitHubTokenList
            tokens={settings.githubTokens ?? []}
            onChange={(githubTokens) => setSettings((prev) => ({ ...prev, githubTokens }))}
            legacyPatConfigured={!!settings.githubPat?.trim()}
            inputClass={inputClass}
          />
        </section>

        {/* GitHub PAT（共通フォールバック） */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">
            GitHub Personal Access Token（共通フォールバック）
          </h2>
          <input
            type="password"
            value={settings.githubPat ?? ''}
            onChange={(e) => setSettings((prev) => ({ ...prev, githubPat: e.target.value }))}
            placeholder="ghp_xxxxxxxxxxxx"
            className={`${inputClass} w-full max-w-md`}
          />
          <p className="text-xs text-gray-500 mt-1">
            上のトークンで解決できない owner に対して使用します（暗号化して保存）。
            fine-grained token へ完全移行する場合は空にしてください。
          </p>
        </section>

        {/* GitHub PR 自動同期 */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">GitHub PR レビュー自動同期</h2>
          <p className="text-xs text-gray-500 mb-3">
            レビュー依頼されているPRを定期取得し、未起票のものを自動でタスク作成します。
          </p>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-400 whitespace-nowrap w-32">GitHub ユーザー名 *</label>
              <input
                type="text"
                value={settings.githubUsername ?? ''}
                onChange={(e) => setSettings((prev) => ({ ...prev, githubUsername: e.target.value }))}
                placeholder="your-github-username"
                className={`${inputClass} w-64`}
              />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-400 whitespace-nowrap w-32">同期間隔（分）</label>
              <input
                type="number"
                min={1}
                value={settings.githubPrSyncIntervalMin ?? 5}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, githubPrSyncIntervalMin: Number(e.target.value) || 5 }))
                }
                className={`${inputClass} w-24`}
              />
            </div>
          </div>
        </section>

        {/* 背景画像スライドショー */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">背景画像スライドショー</h2>
          <p className="text-xs text-gray-500 mb-3">指定ディレクトリ内の画像を一定間隔で背景表示します。</p>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.backgroundImageDir ?? ''}
                onChange={(e) => setSettings((prev) => ({ ...prev, backgroundImageDir: e.target.value }))}
                placeholder="画像ディレクトリのパス"
                className={`${inputClass} flex-1`}
              />
              <button
                onClick={async () => {
                  const dir = await window.api.dialog.openDirectory()
                  if (dir) setSettings((prev) => ({ ...prev, backgroundImageDir: dir }))
                }}
                className="px-3 py-1.5 rounded text-sm bg-gray-600 hover:bg-gray-500 text-gray-200 whitespace-nowrap"
              >
                フォルダ選択
              </button>
              {settings.backgroundImageDir && (
                <button
                  onClick={() => setSettings((prev) => ({ ...prev, backgroundImageDir: undefined }))}
                  className="px-3 py-1.5 rounded text-sm bg-red-600 hover:bg-red-700 text-white"
                >
                  解除
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-400 whitespace-nowrap">切替間隔（秒）</label>
              <input
                type="number"
                min={5}
                value={settings.backgroundIntervalSec ?? 30}
                onChange={(e) =>
                  setSettings((prev) => ({ ...prev, backgroundIntervalSec: Number(e.target.value) || 30 }))
                }
                className={`${inputClass} w-24`}
              />
            </div>
          </div>
        </section>

        {/* 追加PATH */}
        <section>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">追加PATH</h2>
          <p className="text-xs text-gray-500 mb-3">
            git hooks 等の子プロセスに追加するPATHエントリ。Volta・pnpm など、シェル経由でないと見つからないツールのパスを登録してください。
          </p>
          <div className="space-y-1.5 mb-2">
            {(settings.extraPaths ?? []).map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="flex-1 px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-gray-200 font-mono truncate">
                  {p}
                </span>
                <button
                  onClick={() =>
                    setSettings((prev) => ({
                      ...prev,
                      extraPaths: (prev.extraPaths ?? []).filter((_, j) => j !== i)
                    }))
                  }
                  className="px-2 py-1.5 rounded text-xs bg-red-600 hover:bg-red-700 text-white whitespace-nowrap"
                >
                  削除
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newExtraPath}
              onChange={(e) => setNewExtraPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newExtraPath.trim()) {
                  setSettings((prev) => ({
                    ...prev,
                    extraPaths: [...(prev.extraPaths ?? []), newExtraPath.trim()]
                  }))
                  setNewExtraPath('')
                }
              }}
              placeholder="/Users/yourname/.volta/bin"
              className={`${inputClass} flex-1 font-mono`}
            />
            <button
              onClick={() => {
                if (!newExtraPath.trim()) return
                setSettings((prev) => ({
                  ...prev,
                  extraPaths: [...(prev.extraPaths ?? []), newExtraPath.trim()]
                }))
                setNewExtraPath('')
              }}
              disabled={!newExtraPath.trim()}
              className="px-3 py-1.5 rounded text-sm bg-gray-600 hover:bg-gray-500 text-white disabled:opacity-40 whitespace-nowrap"
            >
              追加
            </button>
          </div>
        </section>

        {/* Save / Import / Export */}
        <div className="pt-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
          <button
            onClick={async () => { await window.api.settings.export() }}
            className="px-4 py-2 rounded bg-gray-600 hover:bg-gray-500 text-white text-sm"
          >
            エクスポート
          </button>
          <button
            onClick={async () => {
              setImportResult(null)
              try {
                const imported = await window.api.settings.import()
                if (imported) {
                  setSettings(imported)
                  setImportResult('ok')
                  setToast({ message: 'インポート完了！設定を反映しました', type: 'success' })
                } else {
                  setImportResult('cancelled')
                }
              } catch {
                setImportResult('error')
                setToast({ message: 'インポートに失敗しました', type: 'error' })
              }
            }}
            className="px-4 py-2 rounded bg-gray-600 hover:bg-gray-500 text-white text-sm"
          >
            インポート
          </button>
        </div>
      </div>

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title="削除の確認"
        message={
          deleteTarget?.kind === 'repo'
            ? `リポジトリ「${settings.repos[deleteTarget.repoIndex]?.name || ''}」を削除しますか？`
            : deleteTarget?.kind === 'pane'
            ? `Pane「${settings.repos[deleteTarget.repoIndex]?.panes[deleteTarget.paneIndex]?.id || ''}」を削除しますか？`
            : `Dev Server「${settings.repos[deleteTarget?.repoIndex ?? 0]?.panes[deleteTarget?.paneIndex ?? 0]?.devServers[deleteTarget?.dsIndex ?? 0]?.label || ''}」を削除しますか？`
        }
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
