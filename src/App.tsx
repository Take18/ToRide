import { useEffect } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import DashboardPage from './pages/DashboardPage'
import ArchivePage from './pages/ArchivePage'
import SettingsPage from './pages/SettingsPage'
import BackgroundSlideshow from './components/BackgroundSlideshow/BackgroundSlideshow'
import { useTerminalStore } from './stores/terminalStore'

export default function App() {
  const navigate = useNavigate()
  const openTerminal = useTerminalStore((s) => s.openTerminal)
  const openDevServerLog = useTerminalStore((s) => s.openDevServerLog)

  useEffect(() => {
    return window.api.navigation.onNavigateTo((payload) => {
      navigate('/')
      setTimeout(() => {
        if (payload.type === 'task') {
          openTerminal(payload.taskId)
          document.querySelector<HTMLElement>(`[data-card-id="${payload.taskId}"]`)?.focus()
        } else if (payload.type === 'pr-detected') {
          const el = document.querySelector<HTMLElement>(`[data-card-id="${payload.taskId}"]`)
          el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          el?.focus()
        } else if (payload.type === 'devserver') {
          openDevServerLog(payload.repoId, payload.paneId, payload.label)
        }
      }, 200)
    })
  }, [navigate, openTerminal, openDevServerLog])

  return (
    <>
      <BackgroundSlideshow />
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </>
  )
}
