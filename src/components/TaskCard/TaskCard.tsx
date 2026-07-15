import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import type { RuntimeTask } from '../../types/task'
import type { ClaudeModel, LaunchMode } from '../../types/ipc'
import { useTaskStore } from '../../stores/taskStore'
import { useTerminalStore } from '../../stores/terminalStore'
import ContextMeter from '../ContextMeter/ContextMeter'
import BranchStatus from '../BranchStatus/BranchStatus'
import PRStatusBadge from './PRStatusBadge'

type Props = {
  task: RuntimeTask
  hasFreePane?: boolean
  defaultLaunchMode?: LaunchMode
  onEdit?: (task: RuntimeTask) => void
  onNavigate?: (taskId: string, dir: 'up' | 'down' | 'left' | 'right') => void
}

const TYPE_COLORS: Record<string, string> = {
  feat: 'bg-blue-600',
  design: 'bg-purple-600',
  review: 'bg-yellow-600',
  bugfix: 'bg-green-600',
  research: 'bg-cyan-600',
  chore: 'bg-gray-600',
  orchestrate: 'bg-orange-600'
}

const ALL_LAUNCH_MODES: LaunchMode[] = ['normal', 'auto', 'bypass', 'plan']
const ALL_MODELS: ClaudeModel[] = ['default', 'opus', 'sonnet', 'haiku']

type SplitButtonProps = {
  label: string
  disabled?: boolean
  disabledTitle?: string
  colorClass: string
  defaultMode: LaunchMode
  onLaunch: (mode: LaunchMode, model: ClaudeModel) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

function SplitButton({ label, disabled, disabledTitle, colorClass, defaultMode, onLaunch, onKeyDown }: SplitButtonProps) {
  const [selectedMode, setSelectedMode] = useState<LaunchMode>(defaultMode)
  const [selectedModel, setSelectedModel] = useState<ClaudeModel>('default')
  const [open, setOpen] = useState(false)
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 })
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setSelectedMode(defaultMode) }, [defaultMode])

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const dropHeight = dropRef.current?.offsetHeight ?? 0
    const spaceBelow = window.innerHeight - r.bottom
    const openUpward = dropHeight > 0 && spaceBelow < dropHeight + 8
    setDropPos({
      top: openUpward ? r.top - dropHeight - 4 : r.bottom + 4,
      left: r.left,
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node) &&
          triggerRef.current && !triggerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const disabledColor = 'bg-gray-600 text-gray-400 cursor-not-allowed'
  const base = disabled ? disabledColor : colorClass

  return (
    <div className="flex">
      <button
        onClick={disabled ? undefined : () => onLaunch(selectedMode, selectedModel)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        className={`px-3 py-1 rounded-l text-xs font-medium ${base}`}
      >
        {label}（{selectedMode}{selectedModel !== 'default' ? ` / ${selectedModel}` : ''}）
      </button>
      <button
        ref={triggerRef}
        onClick={disabled ? undefined : () => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        className={`px-1.5 py-1 rounded-r border-l border-black/20 text-xs ${base}`}
        aria-label="起動モードを選択"
      >
        ▾
      </button>
      {open && createPortal(
        <div
          ref={dropRef}
          style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, zIndex: 9999 }}
          className="bg-gray-900 border border-gray-700 rounded shadow-xl min-w-max"
        >
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] text-gray-500">起動モード</div>
          {ALL_LAUNCH_MODES.map((mode) => (
            <button
              key={mode}
              onClick={() => { setSelectedMode(mode); setOpen(false) }}
              className={`block w-full text-left px-4 py-1.5 text-xs whitespace-nowrap ${
                mode === selectedMode
                  ? 'text-white bg-gray-700'
                  : 'text-gray-300 hover:bg-gray-700'
              }`}
            >
              {mode}
            </button>
          ))}
          <div className="px-3 pt-1.5 pb-0.5 text-[10px] text-gray-500 border-t border-gray-700">モデル</div>
          {ALL_MODELS.map((model) => (
            <button
              key={model}
              onClick={() => { setSelectedModel(model); setOpen(false) }}
              className={`block w-full text-left px-4 py-1.5 text-xs whitespace-nowrap ${
                model === selectedModel
                  ? 'text-white bg-gray-700'
                  : 'text-gray-300 hover:bg-gray-700'
              }`}
            >
              {model}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

function DoneDetail({ task, onButtonKeyDown }: { task: RuntimeTask; onButtonKeyDown: (e: React.KeyboardEvent) => void }) {
  const [open, setOpen] = useState(false)

  const rows: { label: string; value: string }[] = []
  if ('branch' in task && task.branch) rows.push({ label: 'ブランチ', value: task.branch })
  if ('baseBranch' in task && task.baseBranch) rows.push({ label: '分岐元', value: task.baseBranch })
  if ('ticket' in task && task.ticket) rows.push({ label: 'チケット', value: task.ticket })
  if ('url' in task && task.url) rows.push({ label: 'PR URL', value: task.url })
  if ('output' in task && task.output) rows.push({ label: '出力先', value: task.output })
  if ('directory' in task && task.directory) rows.push({ label: 'Dir', value: task.directory })
  if (task.prompt) rows.push({ label: 'プロンプト', value: task.prompt })

  if (rows.length === 0) return null

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
        className="text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1"
      >
        <span>{open ? '▾' : '▸'}</span>
        詳細
      </button>
      {open && (
        <div className="mt-1 space-y-1 text-xs bg-gray-900/60 rounded p-2">
          {rows.map(({ label, value }) => (
            <div key={label} className="flex gap-2">
              <span className="text-gray-500 shrink-0 w-16">{label}</span>
              <span className="text-gray-300 break-all">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function TaskCard({ task, hasFreePane = true, defaultLaunchMode = 'normal', onEdit, onNavigate }: Props) {
  const tasks = useTaskStore((s) => s.tasks)
  const startTask = useTaskStore((s) => s.startTask)
  const resumeTask = useTaskStore((s) => s.resumeTask)
  const updateTask = useTaskStore((s) => s.updateTask)
  const archiveTask = useTaskStore((s) => s.archiveTask)
  const openTerminal = useTerminalStore((s) => s.openTerminal)

  const activeTaskId = useTerminalStore((s) => s.activeTaskId)
  const isTerminalOpen = useTerminalStore((s) => s.isOpen)
  const isHighlighted = isTerminalOpen && activeTaskId === task.id

  const [startError, setStartError] = useState<string | null>(null)

  const depTask = task.depends_on ? tasks.find((t) => t.id === task.depends_on) : null
  const depBlocked = depTask ? depTask.status !== 'done' : false
  const paneBlocked = task.type !== 'chore' && task.type !== 'orchestrate' && !hasFreePane
  const effectiveDefaultMode: LaunchMode = task.type === 'research' ? 'plan' : defaultLaunchMode

  const handleStart = async (launchMode?: LaunchMode, model?: ClaudeModel) => {
    setStartError(null)
    try {
      await startTask(task.id, launchMode, model)
      openTerminal(task.id)
    } catch (err) {
      setStartError((err as Error).message)
    }
  }

  const handleComplete = async () => {
    await updateTask(task.id, { status: 'done', completedAt: new Date().toISOString() })
    const { activeTaskId, closeTerminal } = useTerminalStore.getState()
    if (activeTaskId === task.id) closeTerminal()
  }

  const handleArchive = async () => {
    await archiveTask(task.id)
  }

  const handleRevert = async () => {
    await updateTask(task.id, { status: 'will_do', completedAt: null, startedAt: null })
  }

  const handleResume = async (launchMode?: LaunchMode, model?: ClaudeModel) => {
    setStartError(null)
    try {
      await resumeTask(task.id, launchMode, model)
      openTerminal(task.id)
    } catch (err) {
      setStartError((err as Error).message)
    }
  }

  const openLink = (url: string) => {
    window.api.shell.openExternal(url)
  }

  const prLabel = task.prUrl
    ? `PR#${task.prUrl.match(/\/pull\/(\d+)/)?.[1] ?? ''}`
    : 'PR'

  const handleCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return
    switch (e.key) {
      case 'ArrowUp':    onNavigate?.(task.id, 'up');    e.preventDefault(); break
      case 'ArrowDown':  onNavigate?.(task.id, 'down');  e.preventDefault(); break
      case 'ArrowLeft':  onNavigate?.(task.id, 'left');  e.preventDefault(); break
      case 'ArrowRight': onNavigate?.(task.id, 'right'); e.preventDefault(); break
      case ' ': {
        const firstBtn = e.currentTarget.querySelector('button:not([disabled])') as HTMLButtonElement
        firstBtn?.focus()
        e.preventDefault()
        break
      }
      case 't': {
        if (task.status === 'doing') {
          openTerminal(task.id)
          e.preventDefault()
        }
        break
      }
    }
  }

  const handleButtonKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      const card = (e.currentTarget as HTMLElement).closest('[data-card-id]') as HTMLElement
      card?.focus()
    }
  }

  return (
    <>
      <div
        data-card-id={task.id}
        tabIndex={0}
        onKeyDown={handleCardKeyDown}
        className={`rounded-lg p-4 shadow mb-3 backdrop-blur-sm transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
          isHighlighted
            ? 'bg-blue-900/60 ring-2 ring-blue-400/70'
            : 'bg-gray-800/55'
        }`}
      >
        {/* Type badge + Title */}
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-xs px-2 py-0.5 rounded text-white font-medium ${TYPE_COLORS[task.type]}`}>
            {task.type}
          </span>
          <span className="text-sm font-medium text-white truncate" title={task.title}>{task.title}</span>
        </div>

        {/* will_do card */}
        {task.status === 'will_do' && (
          <div>
            {depTask && (
              <p className="text-xs text-gray-400 mb-2">
                依存: {depTask.title} ({depTask.status})
              </p>
            )}

            {startError && (
              <p className="text-xs text-red-400 mb-2 break-all">{startError}</p>
            )}

            <div className="flex items-center gap-2 mt-2">
              <SplitButton
                label="開始"
                disabled={depBlocked || paneBlocked}
                disabledTitle={depBlocked ? '依存タスクが未完了です' : paneBlocked ? '空きペインがありません' : undefined}
                colorClass="bg-blue-600 hover:bg-blue-700 text-white"
                defaultMode={effectiveDefaultMode}
                onLaunch={(mode, model) => handleStart(mode, model)}
                onKeyDown={handleButtonKeyDown}
              />
              <button
                onClick={handleComplete}
                onKeyDown={handleButtonKeyDown}
                className="px-3 py-1 rounded text-xs bg-green-600 hover:bg-green-700 text-white"
                title="実行せずに完了にする"
              >
                完了
              </button>
              {onEdit && (
                <button
                  onClick={() => onEdit(task)}
                  onKeyDown={handleButtonKeyDown}
                  className="px-3 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                >
                  編集
                </button>
              )}

              {task.type === 'feat' && 'ticket' in task && task.ticket && (
                <button
                  onClick={() => openLink(task.ticket)}
                  onKeyDown={handleButtonKeyDown}
                  className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                >
                  チケット
                </button>
              )}
              {task.type === 'bugfix' && 'ticket' in task && task.ticket && (
                <button
                  onClick={() => openLink(task.ticket)}
                  onKeyDown={handleButtonKeyDown}
                  className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                >
                  チケット
                </button>
              )}
              {task.type === 'review' && 'url' in task && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openLink(task.url)}
                    onKeyDown={handleButtonKeyDown}
                    className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                  >
                    PR
                  </button>
                  <PRStatusBadge prStatus={task.prStatus} />
                </div>
              )}
              {task.type !== 'review' && task.prUrl && (
                <button
                  onClick={() => openLink(task.prUrl!)}
                  onKeyDown={handleButtonKeyDown}
                  className="px-2 py-1 rounded text-xs bg-purple-700 hover:bg-purple-600 text-white"
                >
                  {prLabel}
                </button>
              )}
            </div>
          </div>
        )}

        {/* doing card */}
        {task.status === 'doing' && (
          <div className="space-y-2">
            <div className="text-xs text-gray-400">
              Pane: <span className="text-gray-300 font-mono">{task.pane}</span>
              {task.workdir && (
                <span className="text-gray-500"> → {task.workdir}</span>
              )}
            </div>

            {task.type !== 'chore' && task.workdir && (
              <BranchStatus workdir={task.workdir} />
            )}
            {task.type === 'chore' && 'directory' in task && (
              <div className="text-xs text-gray-400">
                Dir: <span className="font-mono text-gray-300">{task.directory}</span>
              </div>
            )}
            {task.type === 'orchestrate' && (
              <div className="text-xs text-gray-400">
                Orchestrator: <span className="font-mono text-orange-400">MCP で自律実行中</span>
              </div>
            )}

            <ContextMeter
              taskId={task.id}
              used={task.contextUsed}
              limit={task.contextLimit}
            />

            <div className="flex items-center gap-2 mt-2">
              <button
                onClick={() => openTerminal(task.id)}
                onKeyDown={handleButtonKeyDown}
                className="px-3 py-1 rounded text-xs bg-blue-600 hover:bg-blue-700 text-white"
              >
                対話を開く
              </button>
              <button
                onClick={handleComplete}
                onKeyDown={handleButtonKeyDown}
                className="px-3 py-1 rounded text-xs bg-green-600 hover:bg-green-700 text-white"
              >
                完了
              </button>
              {(task.type === 'feat' || task.type === 'bugfix') && 'ticket' in task && task.ticket && (
                <button
                  onClick={() => openLink(task.ticket)}
                  onKeyDown={handleButtonKeyDown}
                  className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                >
                  チケット
                </button>
              )}
              {task.type === 'review' && 'url' in task && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openLink(task.url)}
                    onKeyDown={handleButtonKeyDown}
                    className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                  >
                    PR
                  </button>
                  <PRStatusBadge prStatus={task.prStatus} />
                </div>
              )}
              {task.type !== 'review' && task.prUrl && (
                <button
                  onClick={() => openLink(task.prUrl!)}
                  onKeyDown={handleButtonKeyDown}
                  className="px-2 py-1 rounded text-xs bg-purple-700 hover:bg-purple-600 text-white"
                >
                  {prLabel}
                </button>
              )}
            </div>
          </div>
        )}

        {/* done card */}
        {task.status === 'done' && (
          <div>
            {task.completedAt && (
              <p className="text-xs text-gray-500 mb-2">
                完了: {new Date(task.completedAt).toLocaleString('ja-JP')}
              </p>
            )}
            <DoneDetail task={task} onButtonKeyDown={handleButtonKeyDown} />
            <div className="flex items-center gap-2 mt-2">
              {task.type === 'review' && 'url' in task && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openLink(task.url)}
                    onKeyDown={handleButtonKeyDown}
                    className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                  >
                    PR
                  </button>
                  <PRStatusBadge prStatus={task.prStatus} />
                </div>
              )}
              {(task.type === 'feat' || task.type === 'bugfix') && 'ticket' in task && task.ticket && (
                <button
                  onClick={() => openLink(task.ticket)}
                  onKeyDown={handleButtonKeyDown}
                  className="px-2 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-gray-300"
                >
                  チケット
                </button>
              )}
              {task.type !== 'review' && task.prUrl && (
                <button
                  onClick={() => openLink(task.prUrl!)}
                  onKeyDown={handleButtonKeyDown}
                  className="px-2 py-1 rounded text-xs bg-purple-700 hover:bg-purple-600 text-white"
                >
                  {prLabel}
                </button>
              )}
              {'sessionId' in task && task.sessionId && (
                <SplitButton
                  label="再開"
                  disabled={paneBlocked}
                  disabledTitle="空きペインがありません"
                  colorClass="bg-indigo-600 hover:bg-indigo-700 text-white"
                  defaultMode={effectiveDefaultMode}
                  onLaunch={(mode, model) => handleResume(mode, model)}
                  onKeyDown={handleButtonKeyDown}
                />
              )}
              <button
                onClick={handleArchive}
                onKeyDown={handleButtonKeyDown}
                className="px-3 py-1 rounded text-xs bg-gray-600 hover:bg-gray-500 text-gray-300"
              >
                アーカイブ
              </button>
              <button
                onClick={handleRevert}
                onKeyDown={handleButtonKeyDown}
                className="px-3 py-1 rounded text-xs bg-yellow-700 hover:bg-yellow-600 text-white"
              >
                未実行に戻す
              </button>
            </div>
          </div>
        )}
      </div>

    </>
  )
}
