import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTerminalStore } from '../../stores/terminalStore'
import { navigateToTarget } from '../../utils/navigateToTarget'
import type { NotificationCategory, NotificationLevel, NotificationRecord } from '../../types/ipc'

const CATEGORY_LABEL: Record<NotificationCategory, string> = {
  context: 'コンテキスト',
  rotation: 'ローテーション',
  devserver: 'Dev Server',
  mcp: 'MCP',
}

const LEVEL_DOT: Record<NotificationLevel, string> = {
  info: 'bg-blue-400',
  warning: 'bg-yellow-400',
  error: 'bg-red-500',
}

/** 「3分前」「2時間前」形式。日をまたいだら日付を出す */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.floor((Date.now() - then) / 1000)
  if (diffSec < 60) return 'たった今'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}時間前`
  return new Date(iso).toLocaleString('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function NotificationBell() {
  const [items, setItems] = useState<NotificationRecord[]>([])
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const openTerminal = useTerminalStore((s) => s.openTerminal)
  const openDevServerLog = useTerminalStore((s) => s.openDevServerLog)

  const refresh = useCallback(async () => {
    setItems(await window.api.notifications.list())
  }, [])

  useEffect(() => {
    refresh()
    return window.api.notifications.onUpdated(() => {
      refresh()
    })
  }, [refresh])

  // パネルの外側クリック・Escで閉じる
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: MouseEvent): void => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const unreadCount = items.filter((n) => !n.readAt).length

  const handleMarkRead = async (id: string): Promise<void> => {
    await window.api.notifications.markRead(id)
    await refresh()
  }

  const handleMarkAllRead = async (): Promise<void> => {
    await window.api.notifications.markAllRead()
    await refresh()
  }

  const handleClear = async (): Promise<void> => {
    await window.api.notifications.clear()
    await refresh()
  }

  const handleItemClick = async (item: NotificationRecord): Promise<void> => {
    if (!item.readAt) await handleMarkRead(item.id)
    setOpen(false)
    if (item.navigation) {
      navigateToTarget(item.navigation, { navigate, openTerminal, openDevServerLog })
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="通知"
        className="relative px-3 py-1.5 rounded bg-gray-700 hover:bg-gray-600 text-sm text-gray-300"
      >
        {'🔔'}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-red-600 text-[10px] leading-4 text-white font-bold">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-96 max-h-[70vh] flex flex-col rounded border border-gray-700 bg-gray-900 shadow-xl z-50">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700">
            <span className="text-sm text-gray-200 font-medium">通知</span>
            {unreadCount > 0 && <span className="text-xs text-gray-400">未読 {unreadCount}</span>}
            <div className="flex-1" />
            <button
              onClick={handleMarkAllRead}
              disabled={unreadCount === 0}
              className="px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              すべて既読
            </button>
            <button
              onClick={handleClear}
              disabled={items.length === 0}
              className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-xs text-gray-400 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              履歴を消去
            </button>
          </div>

          <div className="overflow-y-auto">
            {items.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-gray-500">通知はありません</div>
            )}
            {items.map((item) => (
              <div
                key={item.id}
                className={`flex gap-2 px-3 py-2 border-b border-gray-800 last:border-b-0 ${
                  item.readAt ? 'bg-transparent' : 'bg-gray-800/50'
                }`}
              >
                <span
                  className={`mt-1.5 w-2 h-2 shrink-0 rounded-full ${
                    item.readAt ? 'bg-gray-600' : LEVEL_DOT[item.level]
                  }`}
                />
                <button
                  onClick={() => handleItemClick(item)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`text-xs truncate ${item.readAt ? 'text-gray-400' : 'text-gray-100 font-medium'}`}
                    >
                      {item.title}
                    </span>
                  </div>
                  <div className="text-[11px] text-gray-400 whitespace-pre-wrap break-words">
                    {item.body}
                  </div>
                  <div className="mt-0.5 text-[10px] text-gray-500">
                    {CATEGORY_LABEL[item.category] ?? item.category} ・ {formatRelative(item.createdAt)}
                  </div>
                </button>
                {!item.readAt && (
                  <button
                    onClick={() => handleMarkRead(item.id)}
                    title="既読にする"
                    className="self-start px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-[10px] text-gray-300 shrink-0"
                  >
                    既読
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
