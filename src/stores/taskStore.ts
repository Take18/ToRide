import { create } from 'zustand'
import type { RuntimeTask, TaskType, Task, RuntimeTaskState, DistributiveOmit } from '../types/task'
import type { ClaudeModel, LaunchMode } from '../types/ipc'
import { useTerminalStore } from './terminalStore'

type TaskStore = {
  tasks: RuntimeTask[]
  filteredTasks: RuntimeTask[]
  searchQuery: string
  typeFilters: TaskType[]
  fetchTasks: () => Promise<void>
  createTask: (task: DistributiveOmit<Task, 'id' | 'created_at'>) => Promise<void>
  updateTask: (id: string, data: Partial<Task & RuntimeTaskState>) => Promise<void>
  deleteTask: (id: string) => Promise<void>
  archiveTask: (id: string) => Promise<void>
  archiveAllDone: () => Promise<void>
  restoreArchived: (id: string) => Promise<void>
  startTask: (taskId: string, launchMode?: LaunchMode, model?: ClaudeModel) => Promise<void>
  resumeTask: (taskId: string, launchMode?: LaunchMode, model?: ClaudeModel) => Promise<void>
  setSearchQuery: (q: string) => void
  setTypeFilters: (types: TaskType[]) => void
}

function applyFilters(tasks: RuntimeTask[], searchQuery: string, typeFilters: TaskType[]): RuntimeTask[] {
  let result = tasks
  if (searchQuery) {
    const q = searchQuery.toLowerCase()
    result = result.filter((t) => {
      if (t.title.toLowerCase().includes(q)) return true
      if ('branch' in t && t.branch?.toLowerCase().includes(q)) return true
      if ('ticket' in t && t.ticket?.toLowerCase().includes(q)) return true
      if ('url' in t && t.url?.toLowerCase().includes(q)) return true
      if (t.type !== 'review' && t.prUrl?.toLowerCase().includes(q)) return true
      return false
    })
  }
  if (typeFilters.length > 0) {
    result = result.filter((t) => typeFilters.includes(t.type))
  }
  return result
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: [],
  filteredTasks: [],
  searchQuery: '',
  typeFilters: [],

  fetchTasks: async () => {
    const tasks = await window.api.tasks.list()
    const { searchQuery, typeFilters } = get()
    set({ tasks, filteredTasks: applyFilters(tasks, searchQuery, typeFilters) })
  },

  createTask: async (task) => {
    await window.api.tasks.create(task)
    await get().fetchTasks()
  },

  updateTask: async (id, data) => {
    await window.api.tasks.update(id, data)
    await get().fetchTasks()
  },

  deleteTask: async (id) => {
    await window.api.tasks.delete(id)
    await get().fetchTasks()
  },

  archiveTask: async (id) => {
    await window.api.tasks.archive(id)
    await get().fetchTasks()
  },

  archiveAllDone: async () => {
    await window.api.tasks.archiveAllDone()
    await get().fetchTasks()
  },

  restoreArchived: async (id) => {
    await window.api.tasks.restoreArchived(id)
    await get().fetchTasks()
  },

  startTask: async (taskId, launchMode, model) => {
    const { tasks } = get()
    const task = tasks.find((t) => t.id === taskId)
    if (!task) return

    const workdir = task.workdir || ''
    const prompt = task.prompt
    const { panelCols, panelRows } = useTerminalStore.getState()

    await window.api.claude.start(taskId, workdir, prompt, panelCols, panelRows, launchMode, model)
    await get().fetchTasks()
  },

  resumeTask: async (taskId, launchMode, model) => {
    const { panelCols, panelRows } = useTerminalStore.getState()
    await window.api.claude.resume(taskId, panelCols, panelRows, launchMode, model)
    await get().fetchTasks()
  },

  setSearchQuery: (q) => {
    const { tasks, typeFilters } = get()
    set({ searchQuery: q, filteredTasks: applyFilters(tasks, q, typeFilters) })
  },

  setTypeFilters: (types) => {
    const { tasks, searchQuery } = get()
    set({ typeFilters: types, filteredTasks: applyFilters(tasks, searchQuery, types) })
  }
}))
