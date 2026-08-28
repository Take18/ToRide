import { useEffect, useState, useMemo } from 'react'
import { useTaskStore } from '../stores/taskStore'
import FilterBar from '../components/FilterBar/FilterBar'
import PaneStatusSidebar from '../components/PaneStatusSidebar/PaneStatusSidebar'
import TaskCard from '../components/TaskCard/TaskCard'
import TaskForm from '../components/TaskForm/TaskForm'
import Toast from '../components/Common/Toast'
import { useTerminalStore } from '../stores/terminalStore'
import type { TaskStatus, RuntimeTask } from '../types/task'
import type { RepoConfig, LaunchMode, ResidentOrchestratorConfig } from '../types/ipc'

const COLUMNS: { status: TaskStatus; label: string; borderColor: string }[] = [
  { status: 'will_do', label: '未実行', borderColor: 'border-t-gray-500' },
  { status: 'doing', label: '実行中', borderColor: 'border-t-blue-500' },
  { status: 'done', label: '完了', borderColor: 'border-t-green-500' }
]

export default function DashboardPage() {
  const [formOpen, setFormOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<RuntimeTask | null>(null)
  const [repos, setRepos] = useState<RepoConfig[]>([])
  const [settingsLaunchMode, setSettingsLaunchMode] = useState<LaunchMode>('normal')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [prSyncing, setPrSyncing] = useState(false)
  const [residentOrchestrator, setResidentOrchestrator] = useState<ResidentOrchestratorConfig | undefined>(undefined)
  const [orchestratorBooting, setOrchestratorBooting] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
  const fetchTasks = useTaskStore((s) => s.fetchTasks)
  const filteredTasks = useTaskStore((s) => s.filteredTasks)
  const tasks = useTaskStore((s) => s.tasks)
  const archiveTask = useTaskStore((s) => s.archiveTask)
  const isTerminalOpen = useTerminalStore((s) => s.isOpen)
  const terminalPanelWidth = useTerminalStore((s) => s.panelWidth)
  const isTerminalResizing = useTerminalStore((s) => s.isResizing)

  const cardsByColumn = useMemo(
    () => COLUMNS.map((col) => filteredTasks.filter((t) => t.status === col.status)),
    [filteredTasks]
  )

  const handleNavigate = (taskId: string, dir: 'up' | 'down' | 'left' | 'right') => {
    let colIdx = -1, cardIdx = -1
    for (let c = 0; c < cardsByColumn.length; c++) {
      const i = cardsByColumn[c].findIndex((t) => t.id === taskId)
      if (i !== -1) { colIdx = c; cardIdx = i; break }
    }
    if (colIdx === -1) return

    let newColIdx = colIdx, newCardIdx = cardIdx
    if (dir === 'up') newCardIdx = Math.max(0, cardIdx - 1)
    if (dir === 'down') newCardIdx = Math.min(cardsByColumn[colIdx].length - 1, cardIdx + 1)
    if (dir === 'left') {
      for (let c = colIdx - 1; c >= 0; c--) {
        if (cardsByColumn[c].length > 0) { newColIdx = c; newCardIdx = Math.min(cardIdx, cardsByColumn[c].length - 1); break }
      }
    }
    if (dir === 'right') {
      for (let c = colIdx + 1; c < cardsByColumn.length; c++) {
        if (cardsByColumn[c].length > 0) { newColIdx = c; newCardIdx = Math.min(cardIdx, cardsByColumn[c].length - 1); break }
      }
    }

    const target = cardsByColumn[newColIdx]?.[newCardIdx]
    if (target && target.id !== taskId) {
      requestAnimationFrame(() => {
        (document.querySelector(`[data-card-id="${target.id}"]`) as HTMLElement)?.focus()
      })
    }
  }

  // Ctrl+` でターミナルパネルをトグル（xterm より先にキャプチャ）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === '`' && e.ctrlKey) {
        e.preventDefault()
        e.stopPropagation()
        const { isOpen, activeTaskId, closeTerminal } = useTerminalStore.getState()
        if (isOpen) {
          closeTerminal()
          if (activeTaskId) {
            requestAnimationFrame(() => {
              (document.querySelector(`[data-card-id="${activeTaskId}"]`) as HTMLElement)?.focus()
            })
          }
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  useEffect(() => {
    fetchTasks()
    window.api.settings.get().then((s) => {
      setRepos(s.repos ?? [])
      setResidentOrchestrator(s.residentOrchestrator)
      if (s.useDangerouslySkipPermissions) setSettingsLaunchMode('bypass')
      else if (s.useAutoMode) setSettingsLaunchMode('auto')
      else setSettingsLaunchMode('normal')
    })
    window.api.claude.listModels().then(setAvailableModels).catch(() => {})
  }, [fetchTasks])

  useEffect(() => {
    return window.api.tasks.onUpdated(() => {
      fetchTasks()
    })
  }, [fetchTasks])

  // タスクごとに、そのリポジトリに空きペインがあるか判定
  // repoId:paneId の複合キーで管理して別リポジトリの同名paneを区別する
  const occupiedPaneKeys = new Set(
    tasks.filter((t) => t.status === 'doing' && t.pane).map((t) => `${t.repoId ?? repos[0]?.id ?? ''}:${t.pane}`)
  )
  const hasFreePaneForTask = (task: RuntimeTask): boolean => {
    if (task.type === 'chore') return true
    const repo = task.repoId
      ? repos.find((r) => r.id === task.repoId)
      : repos[0]
    if (!repo) return false
    return repo.panes.some((p) => !occupiedPaneKeys.has(`${repo.id}:${p.id}`))
  }

  // ボタンの隣に出す「どこに立つか」。設定画面には repoId を出さないので、ここで確認できるようにする。
  // 未設定のまま押せると意図しないリポジトリに立ってそのまま起動してしまうため、その場合はボタンを止める
  const orchestrator = useMemo(() => {
    if (!residentOrchestrator?.repoId) {
      return { label: '設定画面で起票先のリポジトリを選んでください', ready: false }
    }
    const repo = repos.find((r) => r.id === residentOrchestrator.repoId)
    if (!repo) {
      return { label: `リポジトリ「${residentOrchestrator.repoId}」が設定に見つかりません`, ready: false }
    }
    return { label: `${repo.name}（${repo.id}）に起票します`, ready: true }
  }, [residentOrchestrator, repos])

  const handleBootOrchestrator = async () => {
    setOrchestratorBooting(true)
    try {
      const result = await window.api.residentOrchestrator.runNow()
      if (result.result === 'created') {
        setToast({
          message: result.started
            ? `「${result.title}」を起票して起動しました`
            : `「${result.title}」を起票しました`,
          type: 'success'
        })
      } else if (result.result === 'skipped') {
        setToast({ message: `見送りました: ${result.message}`, type: 'success' })
      } else if (result.result === 'start-failed') {
        setToast({ message: `起票しましたが起動に失敗しました: ${result.message}`, type: 'error' })
      } else {
        setToast({ message: result.message, type: 'error' })
      }
      fetchTasks()
    } catch (e) {
      setToast({ message: `エラー: ${(e as Error).message}`, type: 'error' })
    } finally {
      setOrchestratorBooting(false)
    }
  }

  const handleSyncPRs = async () => {
    setPrSyncing(true)
    try {
      await window.api.github.syncPRs()
    } finally {
      setPrSyncing(false)
    }
  }

  return (
    <div className="h-screen flex flex-col">
      <FilterBar
        onNewTask={() => { setEditingTask(null); setFormOpen(true) }}
        onSyncPRs={handleSyncPRs}
        prSyncing={prSyncing}
        onBootOrchestrator={handleBootOrchestrator}
        orchestratorTarget={orchestrator.label}
        orchestratorReady={orchestrator.ready}
        orchestratorBooting={orchestratorBooting}
      />

      <div className="flex flex-1 overflow-hidden">
        <PaneStatusSidebar />

        <div
          className={`flex-1 flex overflow-hidden ${isTerminalResizing ? '' : 'transition-all'}`}
          style={{ marginRight: isTerminalOpen ? terminalPanelWidth : 0 }}
        >
          {COLUMNS.map((col) => {
            const columnTasks = filteredTasks.filter((t) => t.status === col.status)
            return (
              <div key={col.status} className="flex-1 flex flex-col min-w-0">
                <div className={`px-4 py-2 border-t-2 ${col.borderColor} bg-gray-900 flex items-center justify-between`}>
                  <h2 className="text-sm font-semibold text-gray-300">
                    {col.label}
                    <span className="ml-2 text-xs text-gray-500">{columnTasks.length}</span>
                  </h2>
                  {col.status === 'done' && columnTasks.length > 0 && (
                    <button
                      onClick={() => Promise.all(columnTasks.map((t) => archiveTask(t.id)))}
                      className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
                      title="完了タスクを全てアーカイブ"
                    >
                      一括アーカイブ
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto px-3 py-2">
                  {columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      hasFreePane={hasFreePaneForTask(task)}
                      defaultLaunchMode={settingsLaunchMode}
                      availableModels={availableModels}
                      onEdit={task.status === 'will_do' ? (t) => { setEditingTask(t); setFormOpen(true) } : undefined}
                      onNavigate={handleNavigate}
                    />
                  ))}
                  {columnTasks.length === 0 && (
                    <p className="text-xs text-gray-600 text-center mt-4">タスクなし</p>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <TaskForm
        isOpen={formOpen}
        onClose={() => { setFormOpen(false); setEditingTask(null) }}
        editTask={editingTask ?? undefined}
      />

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  )
}
