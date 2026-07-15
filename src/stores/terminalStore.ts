import { create } from 'zustand'

export const PANEL_MIN_WIDTH = 320
export const PANEL_DEFAULT_WIDTH = 480
const PANEL_WIDTH_STORAGE_KEY = 'terminalPanelWidth'

// 画面幅に対してKanban側の最低表示幅を確保する
export const getPanelMaxWidth = () => Math.max(PANEL_MIN_WIDTH, window.innerWidth - 400)

export const clampPanelWidth = (width: number) =>
  Math.min(getPanelMaxWidth(), Math.max(PANEL_MIN_WIDTH, Math.round(width)))

const loadPanelWidth = (): number => {
  const saved = Number(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY))
  if (!Number.isFinite(saved) || saved <= 0) return PANEL_DEFAULT_WIDTH
  return clampPanelWidth(saved)
}

type TerminalStore = {
  activeTaskId: string | null
  isOpen: boolean
  devServerLogKey: string | null
  panelCols: number
  panelRows: number
  panelWidth: number
  isResizing: boolean

  openTerminal: (taskId: string) => void
  openDevServerLog: (repoId: string, paneId: string, label: string) => void
  closeTerminal: () => void
  setPanelDimensions: (cols: number, rows: number) => void
  setPanelWidth: (width: number) => void
  setResizing: (resizing: boolean) => void
}

export const useTerminalStore = create<TerminalStore>((set) => ({
  activeTaskId: null,
  isOpen: false,
  devServerLogKey: null,
  panelCols: 60,
  panelRows: 30,
  panelWidth: loadPanelWidth(),
  isResizing: false,

  openTerminal: (taskId) =>
    set({ activeTaskId: taskId, isOpen: true, devServerLogKey: null }),

  openDevServerLog: (repoId, paneId, label) =>
    set({ devServerLogKey: `${repoId}:${paneId}:${label}`, isOpen: true, activeTaskId: null }),

  closeTerminal: () =>
    // activeTaskId は保持する（再度開いたとき同じセッションを再表示するため）
    set({ isOpen: false, devServerLogKey: null }),

  setPanelDimensions: (cols, rows) => set({ panelCols: cols, panelRows: rows }),

  setPanelWidth: (width) => {
    const clamped = clampPanelWidth(width)
    localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(clamped))
    set({ panelWidth: clamped })
  },

  setResizing: (resizing) => set({ isResizing: resizing })
}))
