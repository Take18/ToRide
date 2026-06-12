import { useState, useEffect } from 'react'
import type { TaskType, RuntimeTask } from '../../types/task'
import type { RepoConfig } from '../../types/ipc'
import type { TicketProviderMeta } from '../../types/plugin'
import { useTaskStore } from '../../stores/taskStore'
import { BranchCombobox } from '../Common/BranchCombobox'

type Props = {
  isOpen: boolean
  onClose: () => void
  editTask?: RuntimeTask  // 指定時は編集モード
}

const INITIAL_FORM = {
  type: 'feat' as TaskType,
  title: '',
  repoId: '',
  branch: '',
  baseBranch: '',
  ticket: '',
  prompt: '',
  depends_on: '',
  url: '',
  output: '',
  directory: ''
}

function taskToForm(task: RuntimeTask) {
  return {
    type: task.type,
    title: task.title,
    repoId: task.repoId ?? '',
    depends_on: task.depends_on ?? '',
    branch: 'branch' in task ? (task.branch ?? '') : '',
    baseBranch: ('baseBranch' in task ? (task.baseBranch ?? '') : '') as string,
    ticket: 'ticket' in task ? (task.ticket ?? '') : '',
    prompt: task.prompt ?? '',
    url: 'url' in task ? (task.url ?? '') : '',
    output: 'output' in task ? (task.output ?? '') : '',
    directory: 'directory' in task ? (task.directory ?? '') : ''
  }
}

export default function TaskForm({ isOpen, onClose, editTask }: Props) {
  const [form, setForm] = useState(INITIAL_FORM)
  const [repos, setRepos] = useState<RepoConfig[]>([])
  const [availableBranches, setAvailableBranches] = useState<string[]>([])
  const [branchSourceDir, setBranchSourceDir] = useState<string>('')
  const [branchLoadError, setBranchLoadError] = useState<string>('')
  const [ticketUrl, setTicketUrl] = useState('')
  const [ticketFetching, setTicketFetching] = useState(false)
  const [ticketError, setTicketError] = useState('')
  const [ticketSuccess, setTicketSuccess] = useState(false)
  const [providers, setProviders] = useState<TicketProviderMeta[]>([])
  const tasks = useTaskStore((s) => s.tasks)
  const createTask = useTaskStore((s) => s.createTask)
  const updateTask = useTaskStore((s) => s.updateTask)

  const loadBranches = (repoId: string, allRepos: RepoConfig[]) => {
    setAvailableBranches([])
    setBranchSourceDir('')
    setBranchLoadError('')
    const repo = repoId ? allRepos.find((r) => r.id === repoId) : allRepos[0]
    const firstPane = repo?.panes[0]
    if (!firstPane?.path) {
      setBranchLoadError('リポジトリにペインが未登録です')
      return
    }
    setBranchSourceDir(firstPane.path)
    window.api.git.branches(firstPane.path)
      .then((branches) => {
        if (branches.length === 0) {
          setBranchLoadError('ブランチが取得できませんでした')
        }
        setAvailableBranches(branches)
      })
      .catch((e: Error) => setBranchLoadError(e.message))
  }

  useEffect(() => {
    if (isOpen) {
      const initialForm = editTask ? taskToForm(editTask) : INITIAL_FORM
      setForm(initialForm)
      setTicketUrl('')
      setTicketError('')
      setTicketSuccess(false)
      window.api.settings.get().then((settings) => {
        const allRepos = settings.repos ?? []
        setRepos(allRepos)
        if (allRepos.length === 0) {
          setBranchLoadError('設定にリポジトリが未登録です')
          return
        }
        const repoId = initialForm.repoId || allRepos[0]?.id || ''
        if (!initialForm.repoId) {
          setForm((prev) => ({ ...prev, repoId }))
        }
        loadBranches(repoId, allRepos)
      })
      window.api.ticket.providers().then(setProviders).catch(() => setProviders([]))
    }
  }, [isOpen, editTask])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const set = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleTicketFetch = async () => {
    if (!ticketUrl.trim()) return
    setTicketFetching(true)
    setTicketError('')
    setTicketSuccess(false)
    try {
      const info = await window.api.ticket.fetch(ticketUrl.trim())
      setForm((prev) => ({
        ...prev,
        type: info.taskType ?? prev.type,
        title: info.title,
        ticket: ticketUrl.trim(),
      }))
      setTicketSuccess(true)
    } catch (e) {
      setTicketError((e as Error).message)
    } finally {
      setTicketFetching(false)
    }
  }

  const doSubmit = async () => {
    if (!form.title) return

    if (editTask) {
      const common = {
        title: form.title,
        ...(form.type !== 'chore' ? { repoId: form.repoId || undefined } : {}),
        depends_on: form.depends_on || undefined,
        prompt: form.prompt || undefined,
        branch: form.branch || undefined,
        baseBranch: form.baseBranch || undefined,
        ticket: form.ticket || undefined,
        url: form.url || undefined,
        output: form.output || undefined,
        directory: form.directory || undefined,
      }
      await updateTask(editTask.id, common)
    } else {
      const base = {
        title: form.title,
        pane: '',
        status: 'will_do' as const,
        ...(form.depends_on ? { depends_on: form.depends_on } : {})
      }
      switch (form.type) {
        case 'feat':
          await createTask({ ...base, type: 'feat', repoId: form.repoId || undefined, branch: form.branch, baseBranch: form.baseBranch || undefined, ticket: form.ticket, prompt: form.prompt || undefined })
          break
        case 'design':
          await createTask({ ...base, type: 'design', repoId: form.repoId || undefined, output: form.output, prompt: form.prompt || undefined })
          break
        case 'review':
          await createTask({ ...base, type: 'review', repoId: form.repoId || undefined, url: form.url, prompt: form.prompt || undefined })
          break
        case 'bugfix':
          await createTask({ ...base, type: 'bugfix', repoId: form.repoId || undefined, branch: form.branch, baseBranch: form.baseBranch || undefined, ticket: form.ticket, prompt: form.prompt || undefined })
          break
        case 'research':
          await createTask({ ...base, type: 'research', repoId: form.repoId || undefined, branch: form.branch, prompt: form.prompt })
          break
        case 'chore':
          await createTask({ ...base, type: 'chore', directory: form.directory, prompt: form.prompt || undefined })
          break
      }
    }
    onClose()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await doSubmit()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      doSubmit()
    }
  }

  const inputClass = 'w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-400 focus:outline-none focus:border-blue-500'
  const labelClass = 'block text-xs text-gray-400 mb-1'
  const req = <span className="text-red-400 ml-1">*</span>

  const configuredProviders = providers.filter((p) => p.configured)

  const dependsOnOptions = form.type !== 'chore' && form.repoId
    ? tasks.filter((t) => t.id !== editTask?.id && t.repoId === form.repoId)
    : tasks.filter((t) => t.id !== editTask?.id)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60">
      <div className="bg-gray-800 rounded-lg shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="p-6">
          <h2 className="text-lg font-semibold text-white mb-4">{editTask ? 'タスクを編集' : '新規タスク'}</h2>

          <div className="space-y-3">
            {/* チケットから自動入力（新規作成時・設定済みプロバイダーがある場合のみ） */}
            {!editTask && configuredProviders.length > 0 && (
              <div className="bg-gray-750 border border-gray-600 rounded p-3">
                <label className="block text-xs text-gray-400 mb-1.5">
                  チケットから自動入力（対応: {configuredProviders.map((p) => p.displayName).join(', ')}）
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={ticketUrl}
                    onChange={(e) => { setTicketUrl(e.target.value); setTicketSuccess(false); setTicketError('') }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleTicketFetch() } }}
                    placeholder="チケットURL"
                    className={inputClass}
                  />
                  <button
                    type="button"
                    onClick={handleTicketFetch}
                    disabled={ticketFetching || !ticketUrl.trim()}
                    className="px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 text-white text-sm whitespace-nowrap disabled:opacity-40"
                  >
                    {ticketFetching ? '取得中...' : '取得'}
                  </button>
                </div>
                {ticketError && <p className="text-xs text-red-400 mt-1">{ticketError}</p>}
                {ticketSuccess && <p className="text-xs text-green-400 mt-1">チケット情報を取得しました</p>}
              </div>
            )}

            {/* Type */}
            <div>
              <label className={labelClass}>タイプ</label>
              {editTask ? (
                <div className={`${inputClass} text-gray-400 cursor-not-allowed`}>{form.type}</div>
              ) : (
                <select
                  value={form.type}
                  onChange={(e) => set('type', e.target.value)}
                  className={inputClass}
                >
                  <option value="feat">feat</option>
                  <option value="design">design</option>
                  <option value="review">review</option>
                  <option value="bugfix">bugfix</option>
                  <option value="research">research</option>
                  <option value="chore">chore</option>
                </select>
              )}
            </div>

            {/* Repository (chore以外) */}
            {form.type !== 'chore' && repos.length > 0 && (
              <div>
                <label className={labelClass}>リポジトリ{req}</label>
                <select
                  value={form.repoId}
                  onChange={(e) => {
                    const repoId = e.target.value
                    setForm((prev) => {
                      const dependsOnStillValid = tasks.some((t) => t.id === prev.depends_on && t.repoId === repoId)
                      return { ...prev, repoId, depends_on: dependsOnStillValid ? prev.depends_on : '' }
                    })
                    loadBranches(repoId, repos)
                  }}
                  className={inputClass}
                >
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Title */}
            <div>
              <label className={labelClass}>タイトル{req}</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="タスクタイトル"
                className={inputClass}
                required
              />
            </div>

            {(form.type === 'feat' || form.type === 'bugfix' || form.type === 'research') && (
              <div>
                <label className={labelClass}>Branch{req}</label>
                <BranchCombobox
                  value={form.branch}
                  onChange={(v) => set('branch', v)}
                  branches={availableBranches}
                  allowNew={true}
                  placeholder="feature-name"
                  className={inputClass}
                  required
                />
              </div>
            )}

            {(form.type === 'feat' || form.type === 'bugfix') && (
              <div>
                <label className={labelClass}>分岐元ブランチ</label>
                <BranchCombobox
                  value={form.baseBranch}
                  onChange={(v) => set('baseBranch', v)}
                  branches={availableBranches}
                  allowNew={false}
                  placeholder="現在のHEADから分岐"
                  className={inputClass}
                />
                {branchLoadError ? (
                  <p className="text-xs text-red-400 mt-1">{branchLoadError}</p>
                ) : branchSourceDir ? (
                  <p className="text-xs text-gray-500 mt-1">{branchSourceDir} のブランチ一覧</p>
                ) : null}
              </div>
            )}

            {(form.type === 'feat' || form.type === 'bugfix') && (
              <div>
                <label className={labelClass}>Ticket URL{req}</label>
                <input
                  type="text"
                  value={form.ticket}
                  onChange={(e) => set('ticket', e.target.value)}
                  placeholder="チケットURL"
                  className={inputClass}
                  required
                />
              </div>
            )}

            <div>
              <div className="flex items-center gap-2 mb-1">
                <label className={labelClass.replace(' mb-1', '')}>
                  Prompt{form.type === 'research' && req}
                </label>
                <span className="text-xs text-gray-500 flex flex-wrap gap-1">
                  <span className="font-mono text-blue-400">{'{title}'}</span>
                  {({
                    feat: ['{branch}', '{ticket}', '{prompt}'],
                    design: ['{output}'],
                    review: ['{pr-url}'],
                    bugfix: ['{branch}', '{ticket}'],
                    research: ['{branch}', '{prompt}'],
                    chore: ['{directory}'],
                  } as Record<string, string[]>)[form.type]?.map((v) => (
                    <span key={v} className="font-mono text-blue-400">{v}</span>
                  ))}
                </span>
              </div>
              <textarea
                value={form.prompt}
                onChange={(e) => set('prompt', e.target.value)}
                placeholder="Claude Codeへの指示..."
                rows={3}
                className={inputClass}
                required={form.type === 'research'}
              />
            </div>

            {form.type === 'design' && (
              <div>
                <label className={labelClass}>Output{req}</label>
                <input
                  type="text"
                  value={form.output}
                  onChange={(e) => set('output', e.target.value)}
                  placeholder="出力先ファイル"
                  className={inputClass}
                  required
                />
              </div>
            )}

            {form.type === 'review' && (
              <div>
                <label className={labelClass}>PR URL{req}</label>
                <input
                  type="text"
                  value={form.url}
                  onChange={(e) => set('url', e.target.value)}
                  placeholder="https://github.com/..."
                  className={inputClass}
                  required
                />
              </div>
            )}

            {form.type === 'chore' && (
              <div>
                <label className={labelClass}>Directory{req}</label>
                <input
                  type="text"
                  value={form.directory}
                  onChange={(e) => set('directory', e.target.value)}
                  placeholder="/path/to/directory"
                  className={inputClass}
                  required
                />
              </div>
            )}

            {/* Depends on */}
            <div>
              <label className={labelClass}>依存タスク</label>
              <select
                value={form.depends_on}
                onChange={(e) => set('depends_on', e.target.value)}
                className={inputClass}
              >
                <option value="">なし</option>
                {dependsOnOptions.map((t) => (
                  <option key={t.id} value={t.id}>
                    [{t.type}] {t.title}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded bg-gray-600 hover:bg-gray-500 text-white text-sm"
            >
              キャンセル
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm"
            >
              {editTask ? '保存' : '作成'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
