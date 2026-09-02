import { useEffect } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import DashboardPage from './pages/DashboardPage'
import ArchivePage from './pages/ArchivePage'
import SettingsPage from './pages/SettingsPage'
import BackgroundSlideshow from './components/BackgroundSlideshow/BackgroundSlideshow'
import TerminalPanel from './components/Terminal/TerminalPanel'
import { useTerminalStore } from './stores/terminalStore'
import { navigateToTarget } from './utils/navigateToTarget'

export default function App() {
  const navigate = useNavigate()
  const openTerminal = useTerminalStore((s) => s.openTerminal)
  const openDevServerLog = useTerminalStore((s) => s.openDevServerLog)

  useEffect(() => {
    return window.api.navigation.onNavigateTo((payload) => {
      navigateToTarget(payload, { navigate, openTerminal, openDevServerLog })
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
      <TerminalPanel />
    </>
  )
}
