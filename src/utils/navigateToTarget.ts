import type { NavigationPayload } from '../types/ipc'

type Deps = {
  navigate: (path: string) => void
  openTerminal: (taskId: string) => void
  openDevServerLog: (repoId: string, paneId: string, label: string) => void
}

/**
 * 通知クリック時の遷移処理。
 * デスクトップ通知（main → navigation:goto）と通知一覧の両方から呼ぶため、
 * App.tsx のハンドラから切り出して共有している。
 */
export function navigateToTarget(payload: NavigationPayload, deps: Deps): void {
  deps.navigate('/')
  setTimeout(() => {
    if (payload.type === 'task') {
      deps.openTerminal(payload.taskId)
      document.querySelector<HTMLElement>(`[data-card-id="${payload.taskId}"]`)?.focus()
    } else if (payload.type === 'pr-detected') {
      const el = document.querySelector<HTMLElement>(`[data-card-id="${payload.taskId}"]`)
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      el?.focus()
    } else if (payload.type === 'devserver') {
      deps.openDevServerLog(payload.repoId, payload.paneId, payload.label)
    }
  }, 200)
}
