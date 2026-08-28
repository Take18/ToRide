import { forwardRef, useCallback, useEffect, useRef, useState } from 'react'
import type { SlashCommandInfo } from '../../types/ipc'

type Props = {
  value: string
  onChange: (value: string) => void
  /** プロジェクト定義（<workdir>/.claude）とプロジェクトスコープのプラグインを候補に含めるための作業ディレクトリ */
  workdir?: string
  placeholder?: string
  rows?: number
  className?: string
  required?: boolean
}

const SOURCE_LABEL: Record<SlashCommandInfo['source'], string> = {
  project: 'project',
  user: 'user',
  plugin: 'plugin'
}

const SOURCE_CLASS: Record<SlashCommandInfo['source'], string> = {
  project: 'text-green-400 border-green-800',
  user: 'text-blue-400 border-blue-800',
  plugin: 'text-purple-400 border-purple-800'
}

/** 入力の先頭トークンが `/xxx` で、かつカーソルがその中にあるときだけ補完クエリを返す */
function detectQuery(value: string, cursor: number): string | null {
  if (!value.startsWith('/') || cursor < 1) return null
  const boundary = value.search(/\s/)
  const tokenEnd = boundary === -1 ? value.length : boundary
  if (cursor > tokenEnd) return null
  return value.slice(1, tokenEnd)
}

function filterCommands(commands: SlashCommandInfo[], query: string): SlashCommandInfo[] {
  const q = query.toLowerCase()
  if (!q) return commands
  return commands
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(q)
      const bPrefix = b.name.toLowerCase().startsWith(q)
      if (aPrefix === bPrefix) return 0
      return aPrefix ? -1 : 1
    })
}

/**
 * スラッシュコマンド／スキルの補完つき textarea。
 * 入力全体の先頭で `/` を打つと候補が出る（文中の `/` では発火しない）。
 */
export const PromptTextarea = forwardRef<HTMLTextAreaElement, Props>(function PromptTextarea(
  { value, onChange, workdir, placeholder, rows, className, required },
  forwardedRef
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [commands, setCommands] = useState<SlashCommandInfo[]>([])
  const [query, setQuery] = useState<string | null>(null)
  const [highlight, setHighlight] = useState(0)
  const loadedFor = useRef<string | null>(null)
  // 候補を確定した直後や Escape で閉じた直後に、フォーカス・keyup 経由で再表示されるのを抑える。
  // 次に文字が入力されたら解除する
  const suppressed = useRef(false)

  const setRefs = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el
      if (typeof forwardedRef === 'function') forwardedRef(el)
      else if (forwardedRef) forwardedRef.current = el
    },
    [forwardedRef]
  )

  // workdir が変わったら候補を取り直す
  useEffect(() => {
    loadedFor.current = null
  }, [workdir])

  const loadCommands = useCallback(() => {
    const key = workdir ?? ''
    if (loadedFor.current === key) return
    loadedFor.current = key
    window.api.claude
      .listCommands(workdir || undefined)
      .then(setCommands)
      .catch(() => setCommands([]))
  }, [workdir])

  const syncQuery = useCallback((nextValue?: string) => {
    const el = innerRef.current
    if (!el) return
    if (suppressed.current) {
      setQuery(null)
      return
    }
    setQuery(detectQuery(nextValue ?? el.value, el.selectionStart))
  }, [])

  const filtered = query === null ? [] : filterCommands(commands, query)
  const isOpen = filtered.length > 0

  useEffect(() => {
    setHighlight(0)
  }, [query])

  // 外側クリックで閉じる
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setQuery(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const commit = (name: string) => {
    const boundary = value.search(/\s/)
    const tokenEnd = boundary === -1 ? value.length : boundary
    const rest = value.slice(tokenEnd)
    // 引数を続けて書けるよう、後ろに何も無ければ半角スペースを補う
    const inserted = `/${name}${rest === '' ? ' ' : ''}`
    onChange(inserted + rest)
    suppressed.current = true
    setQuery(null)
    requestAnimationFrame(() => {
      const el = innerRef.current
      if (!el) return
      el.selectionStart = el.selectionEnd = inserted.length
      el.focus()
    })
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
    suppressed.current = false
    loadCommands()
    syncQuery(e.target.value)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isOpen) return
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setHighlight((prev) => (prev + 1) % filtered.length)
        break
      case 'ArrowUp':
        e.preventDefault()
        setHighlight((prev) => (prev - 1 + filtered.length) % filtered.length)
        break
      case 'Enter':
      case 'Tab': {
        const selected = filtered[highlight]
        if (!selected) return
        e.preventDefault()
        commit(selected.name)
        break
      }
      case 'Escape':
        // モーダル全体の Escape ハンドラまで伝播させない（補完を閉じるだけに留める）
        e.preventDefault()
        e.stopPropagation()
        suppressed.current = true
        setQuery(null)
        break
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <textarea
        ref={setRefs}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onKeyUp={() => syncQuery()}
        onClick={() => syncQuery()}
        onFocus={() => {
          loadCommands()
          syncQuery()
        }}
        onBlur={() => setQuery(null)}
        placeholder={placeholder}
        rows={rows}
        className={className}
        required={required}
      />
      {isOpen && (
        <ul className="absolute z-50 left-0 right-0 mt-1 bg-gray-700 border border-gray-600 rounded shadow-lg max-h-56 overflow-y-auto">
          {filtered.map((c, i) => (
            <li
              key={`${c.source}:${c.kind}:${c.name}`}
              // blur より先に選択を確定させる
              onMouseDown={(e) => {
                e.preventDefault()
                commit(c.name)
              }}
              onMouseEnter={() => setHighlight(i)}
              className={`px-3 py-1.5 cursor-pointer ${i === highlight ? 'bg-blue-600' : 'hover:bg-gray-600'}`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-white">/{c.name}</span>
                {c.argumentHint && (
                  <span className="font-mono text-xs text-gray-400 truncate">{c.argumentHint}</span>
                )}
                <span
                  className={`ml-auto shrink-0 text-[10px] border rounded px-1 ${SOURCE_CLASS[c.source]}`}
                >
                  {SOURCE_LABEL[c.source]}
                </span>
              </div>
              {c.description && (
                <p className="text-xs text-gray-400 truncate">{c.description}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})
