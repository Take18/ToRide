import { useState, useEffect, useRef } from 'react'
import type { TaskType, RuntimeTask, ReviewTask, RotationConfig } from '../../types/task'
import type { RepoConfig } from '../../types/ipc'
import type { TicketProviderMeta } from '../../types/plugin'
import { useTaskStore } from '../../stores/taskStore'
import { BranchCombobox } from '../Common/BranchCombobox'
import { PromptTextarea } from '../Common/PromptTextarea'

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
  directory: '',
  images: [] as string[],
  rotationEnabled: false,
  rotationHandoffPath: '',
  rotationThreshold: '',
  rotationBootPrompt: ''
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
    directory: 'directory' in task ? (task.directory ?? '') : '',
    images: task.images ?? [],
    rotationEnabled: task.rotation?.enabled ?? false,
    rotationHandoffPath: task.rotation?.handoffPath ?? '',
    rotationThreshold: task.rotation?.threshold != null ? String(task.rotation.threshold) : '',
    rotationBootPrompt: task.rotation?.bootPrompt ?? ''
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
  // PR URL から取得した際の prStatus（作成時にそのまま保存してバッジを即時表示する）
  const [fetchedPrStatus, setFetchedPrStatus] = useState('')
  const [providers, setProviders] = useState<TicketProviderMeta[]>([])
  const tasks = useTaskStore((s) => s.tasks)
  const createTask = useTaskStore((s) => s.createTask)
  const updateTask = useTaskStore((s) => s.updateTask)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const [isDragging, setIsDragging] = useState(false)
  // このモーダルで新規に取り込んだ画像（キャンセル時に削除する）
  const newlyImportedRef = useRef<string[]>([])
  // 編集モードで外した既存画像（保存時に削除する）
  const removedOriginalsRef = useRef<string[]>([])

  const addImages = (stored: string[]) => {
    if (stored.length === 0) return
    newlyImportedRef.current.push(...stored)
    setForm((prev) => ({ ...prev, images: [...prev.images, ...stored] }))
  }

  const removeImage = (path: string) => {
    if (newlyImportedRef.current.includes(path)) {
      newlyImportedRef.current = newlyImportedRef.current.filter((p) => p !== path)
      window.api.images.delete([path])
    } else {
      removedOriginalsRef.current.push(path)
    }
    setForm((prev) => ({ ...prev, images: prev.images.filter((p) => p !== path) }))
  }

  const handleAddImages = async () => {
    const paths = await window.api.dialog.openImages()
    if (!paths || paths.length === 0) return
    addImages(await window.api.images.import(paths))
  }

  const handleDragOver = (e: React.DragEvent) => {
    if (Array.from(e.dataTransfer.items).some((item) => item.kind === 'file')) {
      e.preventDefault()
      setIsDragging(true)
    }
  }

  const handleDragLeave = () => setIsDragging(false)

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p)
    if (paths.length === 0) return
    addImages(await window.api.images.import(paths))
  }

  const dropProps = { onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop }

  // 保存せずに閉じるとき、新規取り込み分の画像ファイルを破棄する
  const handleCancel = () => {
    if (newlyImportedRef.current.length > 0) {
      window.api.images.delete(newlyImportedRef.current)
      newlyImportedRef.current = []
    }
    onClose()
  }

  const insertVariable = (variable: string) => {
    const textarea = promptRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const newValue = form.prompt.slice(0, start) + variable + form.prompt.slice(end)
    set('prompt', newValue)
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = start + variable.length
      textarea.focus()
    })
  }

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
      setFetchedPrStatus('')
      setIsDragging(false)
      newlyImportedRef.current = []
      removedOriginalsRef.current = []
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
      if (e.key === 'Escape') {
        if (newlyImportedRef.current.length > 0) {
          window.api.images.delete(newlyImportedRef.current)
          newlyImportedRef.current = []
        }
        onClose()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const set = (key: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // スラッシュコマンド補完でプロジェクト定義を拾うための作業ディレクトリ。
  // chore / orchestrate は入力された directory、それ以外はリポジトリ先頭ペインのパス
  const promptWorkdir =
    (form.type === 'chore' || form.type === 'orchestrate') && form.directory
      ? form.directory
      : branchSourceDir

  const handleTicketFetch = async () => {
    if (!ticketUrl.trim()) return
    setTicketFetching(true)
    setTicketError('')
    setTicketSuccess(false)
    try {
      const input = ticketUrl.trim()
      const info = await window.api.ticket.fetch(input)
      const type = info.taskType ?? form.type
      // gitリモートから解決できたリポジトリがあれば選択状態も合わせる
      const repoId = info.repoId && repos.some((r) => r.id === info.repoId) ? info.repoId : form.repoId
      setForm((prev) => ({
        ...prev,
        type,
        title: info.title,
        repoId,
        // review（PR URL）は PR URL 欄、それ以外は Ticket URL 欄に入れる
        ...(type === 'review' ? { url: info.url || input } : { ticket: input }),
      }))
      setFetchedPrStatus(type === 'review' ? info.meta?.prStatus ?? '' : '')
      if (repoId !== form.repoId) loadBranches(repoId, repos)
      setTicketSuccess(true)
    } catch (e) {
      setTicketError((e as Error).message)
    } finally {
      setTicketFetching(false)
    }
  }

  // 未入力のキーは undefined にしてグローバル既定値へフォールバックさせる。
  // history は設定編集で失わないよう編集前の値を引き継ぐ
  const buildRotation = (): RotationConfig | undefined => {
    const threshold = form.rotationThreshold.trim()
    const parsed = threshold ? Number(threshold) : undefined
    const rotation: RotationConfig = {
      ...(editTask?.rotation ?? {}),
      enabled: form.rotationEnabled,
      handoffPath: form.rotationHandoffPath.trim() || undefined,
      threshold: parsed != null && Number.isFinite(parsed) ? parsed : undefined,
      bootPrompt: form.rotationBootPrompt.trim() || undefined
    }
    const isEmpty =
      !rotation.enabled &&
      !rotation.handoffPath &&
      rotation.threshold == null &&
      !rotation.bootPrompt &&
      !(rotation.history && rotation.history.length > 0)
    return isEmpty ? undefined : rotation
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
        images: form.images,
        rotation: buildRotation(),
      }
      await updateTask(editTask.id, common)
      if (removedOriginalsRef.current.length > 0) {
        await window.api.images.delete(removedOriginalsRef.current)
        removedOriginalsRef.current = []
      }
    } else {
      const base = {
        title: form.title,
        pane: '',
        status: 'will_do' as const,
        ...(form.depends_on ? { depends_on: form.depends_on } : {}),
        ...(form.images.length > 0 ? { images: form.images } : {}),
        ...(buildRotation() ? { rotation: buildRotation() } : {})
      }
      switch (form.type) {
        case 'feat':
          await createTask({ ...base, type: 'feat', repoId: form.repoId || undefined, branch: form.branch, baseBranch: form.baseBranch || undefined, ticket: form.ticket, prompt: form.prompt || undefined })
          break
        case 'design':
          await createTask({ ...base, type: 'design', repoId: form.repoId || undefined, output: form.output, prompt: form.prompt || undefined })
          break
        case 'review':
          await createTask({
            ...base,
            type: 'review',
            repoId: form.repoId || undefined,
            url: form.url,
            prompt: form.prompt || undefined,
            ...(fetchedPrStatus ? { prStatus: fetchedPrStatus as ReviewTask['prStatus'] } : {})
          })
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
        case 'orchestrate':
          await createTask({ ...base, type: 'orchestrate', repoId: form.repoId || undefined, directory: form.directory || undefined, prompt: form.prompt || undefined })
          break
      }
    }
    newlyImportedRef.current = []
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
            {/* チケット / PR URL から自動入力（新規作成時・設定済みプロバイダーがある場合のみ） */}
            {!editTask && configuredProviders.length > 0 && (
              <div className="bg-gray-750 border border-gray-600 rounded p-3">
                <label className="block text-xs text-gray-400 mb-1.5">
                  URLから自動入力（対応: {configuredProviders.map((p) => p.displayName).join(', ')}）
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={ticketUrl}
                    onChange={(e) => { setTicketUrl(e.target.value); setTicketSuccess(false); setTicketError('') }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleTicketFetch() } }}
                    placeholder="チケットURL / PR URL"
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
                {ticketSuccess && <p className="text-xs text-green-400 mt-1">URLから情報を取得しました</p>}
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
                  <option value="orchestrate">orchestrate</option>
                </select>
              )}
            </div>

            {/* Repository (chore 以外 / orchestrate はリポジトリのみ選択) */}
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

            {form.type === 'orchestrate' ? (
              <div {...dropProps}>
                <label className={labelClass}>ミッション説明</label>
                <p className="text-xs text-gray-500 mb-1">
                  何を達成したいかを記述してください。オーケストレーターがサブタスクに分解して自律実行します。
                </p>
                <PromptTextarea
                  value={form.prompt}
                  onChange={(v) => set('prompt', v)}
                  workdir={promptWorkdir}
                  placeholder="例: Aコンポーネントの実装後にBをレビューして、両方完了したらCをリリースする"
                  rows={4}
                  className={inputClass}
                />
              </div>
            ) : (
              <div {...dropProps}>
                <div className="flex items-center gap-2 mb-1">
                  <label className={labelClass.replace(' mb-1', '')}>
                    Prompt{form.type === 'research' && req}
                  </label>
                  <span className="text-xs flex flex-wrap gap-1">
                    <span
                      className="font-mono text-blue-400 cursor-pointer hover:bg-blue-900/40 rounded px-0.5"
                      title="クリックして挿入"
                      onClick={() => insertVariable('{title}')}
                    >{'{title}'}</span>
                    {({
                      feat: ['{branch}', '{ticket}', '{prompt}'],
                      design: ['{output}'],
                      review: ['{pr-url}'],
                      bugfix: ['{branch}', '{ticket}'],
                      research: ['{branch}', '{prompt}'],
                      chore: ['{directory}'],
                    } as Record<string, string[]>)[form.type]?.map((v) => (
                      <span
                        key={v}
                        className="font-mono text-blue-400 cursor-pointer hover:bg-blue-900/40 rounded px-0.5"
                        title="クリックして挿入"
                        onClick={() => insertVariable(v)}
                      >{v}</span>
                    ))}
                  </span>
                </div>
                <PromptTextarea
                  ref={promptRef}
                  value={form.prompt}
                  onChange={(v) => set('prompt', v)}
                  workdir={promptWorkdir}
                  placeholder="Claude Codeへの指示..."
                  rows={3}
                  className={inputClass}
                  required={form.type === 'research'}
                />
              </div>
            )}

            {/* 添付画像 */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className={labelClass.replace(' mb-1', '')}>添付画像</label>
                <button
                  type="button"
                  onClick={handleAddImages}
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  + 画像を選択...
                </button>
              </div>
              <div
                {...dropProps}
                className={`border border-dashed rounded p-2 ${isDragging ? 'border-blue-500 bg-blue-900/20' : 'border-gray-600'}`}
              >
                {form.images.length === 0 ? (
                  <p className="text-xs text-gray-500 text-center py-2">画像をここにドラッグ＆ドロップ</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {form.images.map((p) => (
                      <div key={p} className="relative group">
                        <img
                          src={`bg://local?path=${encodeURIComponent(p)}`}
                          alt="添付画像"
                          className="h-16 w-16 object-cover rounded border border-gray-600"
                        />
                        <button
                          type="button"
                          onClick={() => removeImage(p)}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-gray-900 border border-gray-500 text-gray-300 hover:text-white hover:border-white text-[10px] leading-none hidden group-hover:block"
                          title="画像を削除"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={form.directory}
                    onChange={(e) => set('directory', e.target.value)}
                    placeholder="/path/to/directory"
                    className={`${inputClass} flex-1`}
                    required
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const dir = await window.api.dialog.openDirectory()
                      if (dir) set('directory', dir)
                    }}
                    className="px-3 py-1.5 rounded bg-gray-600 hover:bg-gray-500 text-white text-sm whitespace-nowrap"
                    title="フォルダを選択"
                  >
                    参照...
                  </button>
                </div>
              </div>
            )}

            {/* セッションローテーション */}
            <div className="border border-gray-700 rounded p-3 space-y-2">
              <label className="flex items-center gap-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={form.rotationEnabled}
                  onChange={(e) => set('rotationEnabled', e.target.checked)}
                  className="accent-blue-500"
                />
                セッションローテーションを有効にする
              </label>
              <p className="text-[11px] text-gray-500 leading-relaxed">
                コンテキストが閾値に達したら引き継ぎファイルを書かせてセッションを作り直します。
                空欄の項目は設定画面のグローバル既定値が使われます。
              </p>
              <div>
                <label className={labelClass}>引き継ぎファイル (handoffPath)</label>
                <input
                  type="text"
                  value={form.rotationHandoffPath}
                  onChange={(e) => set('rotationHandoffPath', e.target.value)}
                  placeholder="~/my-ai/state/orchestrator/handoff.md"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>開始する使用率 (%)</label>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={form.rotationThreshold}
                  onChange={(e) => set('rotationThreshold', e.target.value)}
                  placeholder="60"
                  className={inputClass}
                />
              </div>
              <div>
                <label className={labelClass}>新セッションへの追記文面 (bootPrompt)</label>
                <textarea
                  value={form.rotationBootPrompt}
                  onChange={(e) => set('rotationBootPrompt', e.target.value)}
                  placeholder="未入力ならデフォルト文面。変数: {handoffPath} {rotationCount}"
                  rows={3}
                  className={inputClass}
                />
              </div>
            </div>

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
              onClick={handleCancel}
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
