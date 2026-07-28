import { useState, useEffect } from 'react'
import type { RepoConfig, PaneConfig, DevServerStatus } from '../../types/ipc'
import { useTerminalStore } from '../../stores/terminalStore'
import { useTaskStore } from '../../stores/taskStore'
import { resolveDevServerUrl } from '../../utils/devServerUrl'

export default function PaneStatusSidebar() {
  const [repos, setRepos] = useState<RepoConfig[]>([])
  const [serverStatuses, setServerStatuses] = useState<DevServerStatus[]>([])
  const [collapsedPanes, setCollapsedPanes] = useState<Set<string>>(new Set())
  const openDevServerLog = useTerminalStore((s) => s.openDevServerLog)
  const tasks = useTaskStore((s) => s.tasks)

  const toggleCollapse = (repoId: string, paneId: string) => {
    const key = `${repoId}:${paneId}`
    setCollapsedPanes((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  useEffect(() => {
    const load = async () => {
      const settings = await window.api.settings.get()
      const loadedRepos = settings.repos ?? []
      setRepos(loadedRepos)
      setCollapsedPanes(
        new Set(loadedRepos.flatMap((repo) => repo.panes.map((pane) => `${repo.id}:${pane.id}`))),
      )
      const statuses = await window.api.devserver.status()
      setServerStatuses(statuses)
    }
    load()

    const unsub = window.api.devserver.onStatusChange((statuses) => {
      setServerStatuses(statuses)
    })
    return unsub
  }, [])

  const getServerStatus = (repoId: string, paneId: string, label: string): DevServerStatus | undefined => {
    return serverStatuses.find((s) => s.repoId === repoId && s.paneId === paneId && s.label === label)
  }

  const toggleServer = async (repoId: string, paneId: string, label: string) => {
    const status = getServerStatus(repoId, paneId, label)
    if (status?.running) {
      await window.api.devserver.stop(repoId, paneId, label)
    } else {
      await window.api.devserver.start(repoId, paneId, label)
    }
  }

  const getActiveTask = (paneId: string, repoId: string) => {
    return tasks.find((t) => t.pane === paneId && (t.repoId ?? repos[0]?.id) === repoId && t.status === 'doing')
  }

  const shortenPath = (p: string): string => {
    const parts = p.split('/')
    if (parts.length <= 3) return p
    return '.../' + parts.slice(-2).join('/')
  }

  const renderPane = (pane: PaneConfig, repoId: string) => {
    const collapseKey = `${repoId}:${pane.id}`
    const isCollapsed = collapsedPanes.has(collapseKey)
    const runningServers = pane.devServers.filter(
      (ds) => getServerStatus(repoId, pane.id, ds.label)?.running,
    )
    const serversToShow = isCollapsed ? runningServers : pane.devServers
    const activeTask = getActiveTask(pane.id, repoId)
    const isActive = !!activeTask
    return (
      <div key={pane.id} className={`border-b border-gray-800 ${isActive ? 'bg-blue-950/30' : ''}`}>
        <button
          className={`w-full flex items-center gap-1 px-3 py-2 hover:bg-gray-800 text-left ${isActive ? 'border-l-2 border-blue-400' : 'border-l-2 border-transparent'}`}
          onClick={() => toggleCollapse(repoId, pane.id)}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="currentColor"
            className={`text-gray-500 flex-shrink-0 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
          >
            <path d="M0 2.5l5 5 5-5H0z" />
          </svg>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`text-sm font-medium leading-none ${isActive ? 'text-blue-300' : 'text-white'}`}>
                {pane.id}
              </span>
              {isActive && (
                <span className="inline-flex items-center gap-0.5 text-blue-400" title={`使用中: ${activeTask.title}`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse inline-block" />
                </span>
              )}
            </div>
            <div className="text-xs text-gray-500 font-mono truncate mt-0.5" title={pane.path}>
              {shortenPath(pane.path)}
            </div>
            {isActive && (
              <div className="text-xs text-blue-400/70 truncate mt-0.5" title={activeTask.title}>
                {activeTask.title}
              </div>
            )}
          </div>
          {isCollapsed && runningServers.length > 0 && (
            <span className="text-green-400 text-xs flex-shrink-0">●{runningServers.length}</span>
          )}
        </button>
        {serversToShow.length > 0 && (
          <div className="px-3 pb-2">
            {serversToShow.map((ds) => {
              const status = getServerStatus(repoId, pane.id, ds.label)
              const running = status?.running ?? false
              const serverUrl = resolveDevServerUrl(ds.url)
              return (
                <div
                  key={ds.label}
                  className="flex items-center gap-0.5 pl-2 text-xs hover:bg-gray-800 rounded py-0.5 group"
                >
                  <button
                    className="flex items-center gap-1.5 flex-1 cursor-pointer text-left"
                    onClick={() => toggleServer(repoId, pane.id, ds.label)}
                    title={serverUrl ? `${serverUrl} — クリックで${running ? '停止' : '起動'}` : `クリックで${running ? '停止' : '起動'}`}
                  >
                    <span className={running ? 'text-green-400' : 'text-gray-500'}>
                      {running ? '\u25CF' : '\u25CB'}
                    </span>
                    <span className={running ? 'text-gray-200' : 'text-gray-500'}>
                      {ds.label}
                    </span>
                  </button>
                  {running && serverUrl && (
                    <button
                      className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-blue-400 px-1 transition-opacity"
                      onClick={() => window.api.shell.openExternal(serverUrl)}
                      title={`${serverUrl} をブラウザで開く`}
                    >
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                        <path d="M6 2H2a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4h-2v3H3V4h3V2zm4 0v2h2.586L7.293 9.293l1.414 1.414L14 5.414V8h2V2h-6z"/>
                      </svg>
                    </button>
                  )}
                  <button
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-gray-200 px-1 transition-opacity"
                    onClick={() => openDevServerLog(repoId, pane.id, ds.label)}
                    title="ログを開く"
                  >
                    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M2 2h12v2H2V2zm0 4h12v2H2V6zm0 4h8v2H2v-2z"/>
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="w-48 bg-gray-900 border-r border-gray-700 overflow-y-auto h-full">
      <div className="px-3 py-2 text-xs font-semibold text-gray-400 uppercase tracking-wider">
        Panes
      </div>
      {repos.map((repo) => (
        <div key={repo.id}>
          {repos.length > 1 && (
            <div className="px-3 py-1 text-xs font-semibold text-gray-500 bg-gray-800/50 border-b border-gray-700">
              {repo.name}
            </div>
          )}
          {repo.panes.map((pane) => renderPane(pane, repo.id))}
        </div>
      ))}
    </div>
  )
}
