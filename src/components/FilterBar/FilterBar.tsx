import { useNavigate } from 'react-router-dom'
import { useTaskStore } from '../../stores/taskStore'
import type { TaskType } from '../../types/task'

const TASK_TYPES: { value: TaskType; label: string; color: string }[] = [
  { value: 'feat', label: 'feat', color: 'bg-blue-600' },
  { value: 'design', label: 'design', color: 'bg-purple-600' },
  { value: 'review', label: 'review', color: 'bg-yellow-600' },
  { value: 'bugfix', label: 'bugfix', color: 'bg-green-600' },
  { value: 'research', label: 'research', color: 'bg-cyan-600' },
  { value: 'chore', label: 'chore', color: 'bg-gray-600' },
  { value: 'orchestrate', label: 'orchestrate', color: 'bg-orange-600' }
]

type Props = {
  onNewTask: () => void
  onSyncPRs?: () => void
  prSyncing?: boolean
}

export default function FilterBar({ onNewTask, onSyncPRs, prSyncing }: Props) {
  const navigate = useNavigate()
  const searchQuery = useTaskStore((s) => s.searchQuery)
  const typeFilters = useTaskStore((s) => s.typeFilters)
  const setSearchQuery = useTaskStore((s) => s.setSearchQuery)
  const setTypeFilters = useTaskStore((s) => s.setTypeFilters)

  const toggleType = (type: TaskType) => {
    if (typeFilters.includes(type)) {
      setTypeFilters(typeFilters.filter((t) => t !== type))
    } else {
      setTypeFilters([...typeFilters, type])
    }
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-gray-900 border-b border-gray-700">
      <div className="relative flex-1 max-w-xs">
        <input
          type="text"
          placeholder="検索..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className={`w-full px-3 py-1.5 pl-8 bg-gray-800 border border-gray-600 rounded text-sm text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 ${searchQuery ? 'pr-7' : ''}`}
        />
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-sm">
          {'🔍'}
        </span>
        {searchQuery && (
          <button
            onClick={() => setSearchQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white text-sm leading-none"
          >
            &times;
          </button>
        )}
      </div>

      <div className="flex gap-1.5">
        {TASK_TYPES.map((tt) => {
          const active = typeFilters.includes(tt.value)
          return (
            <button
              key={tt.value}
              onClick={() => toggleType(tt.value)}
              className={`px-2 py-1 rounded text-xs font-medium transition-colors ${
                active
                  ? `${tt.color} text-white`
                  : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              {tt.label}
            </button>
          )
        })}
      </div>

      <div className="flex-1" />

      {onSyncPRs && (
        <button
          onClick={onSyncPRs}
          disabled={prSyncing}
          className="px-3 py-1.5 rounded bg-green-700 hover:bg-green-600 text-sm text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {prSyncing ? '同期中...' : 'PR同期'}
        </button>
      )}
      <button
        onClick={() => navigate('/archive')}
        className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm text-gray-300"
      >
        アーカイブ
      </button>
      <button
        onClick={() => navigate('/settings')}
        className="px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm text-gray-300"
      >
        設定
      </button>
      <button
        onClick={onNewTask}
        className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-sm text-white"
      >
        + 新規タスク
      </button>
    </div>
  )
}
