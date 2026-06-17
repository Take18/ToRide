import { Routes, Route } from 'react-router-dom'
import DashboardPage from './pages/DashboardPage'
import ArchivePage from './pages/ArchivePage'
import SettingsPage from './pages/SettingsPage'
import BackgroundSlideshow from './components/BackgroundSlideshow/BackgroundSlideshow'
import TerminalPanel from './components/Terminal/TerminalPanel'

export default function App() {
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
