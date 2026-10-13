import { useState, useEffect } from 'react'

type Props = {
  taskId: string
  used?: number
  limit?: number
}

export default function ContextMeter({ taskId, used: initialUsed, limit: initialLimit }: Props) {
  const [used, setUsed] = useState(initialUsed ?? 0)
  // 上限はエージェントやモデルで変わるので決め打ちしない。届くまで（0 も含む）は不明として表示する
  const [limit, setLimit] = useState(initialLimit ?? 0)

  useEffect(() => {
    const unsub = window.api.claude.onContextUpdate((info) => {
      if (info.taskId === taskId) {
        setUsed(info.used)
        setLimit(info.limit)
      }
    })
    return unsub
  }, [taskId])

  useEffect(() => {
    if (initialUsed != null) setUsed(initialUsed)
    if (initialLimit != null) setLimit(initialLimit)
  }, [initialUsed, initialLimit])

  const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0

  let barColor = 'bg-green-500'
  if (percentage >= 90) {
    barColor = 'bg-red-500'
  } else if (percentage >= 80) {
    barColor = 'bg-yellow-500'
  }

  return (
    <div className="w-full">
      <div className="flex justify-between text-xs text-gray-400 mb-1">
        <span>Context</span>
        <span>
          {limit > 0
            ? `${used.toLocaleString()}/${limit.toLocaleString()} tokens`
            : `${used.toLocaleString()} tokens（上限不明）`}
        </span>
      </div>
      <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${Math.min(percentage, 100)}%` }}
        />
      </div>
    </div>
  )
}
