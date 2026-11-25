import type Database from 'better-sqlite3'

export type DecisionStatus = 'open' | 'answered' | 'resolved'

export type DecisionOption = { key: string; label: string }

export type DecisionAnswer = { choice?: string; text?: string; at: string }

export type Decision = {
  id: string
  project?: string
  title: string
  body?: string
  link?: string
  options?: DecisionOption[]
  task_id?: string
  status: DecisionStatus
  answer?: DecisionAnswer
  createdAt: string
  updatedAt: string
}

export type CreateDecisionInput = {
  project?: unknown
  title?: unknown
  body?: unknown
  link?: unknown
  options?: unknown
  task_id?: unknown
}

type Row = {
  seq: number
  project: string | null
  title: string
  body: string | null
  link: string | null
  options: string | null
  task_id: string | null
  status: DecisionStatus
  answer: string | null
  created_at: string
  updated_at: string
}

/** ID は全体の通し番号 Q1, Q2, …。AUTOINCREMENT なので行を消しても番号は再利用されない */
const toId = (seq: number): string => `Q${seq}`

const parseId = (id: string): number | null => {
  const match = /^Q([1-9]\d*)$/i.exec(id.trim())
  return match ? Number(match[1]) : null
}

const optionalString = (value: unknown, name: string): string | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const trimmed = value.trim()
  return trimmed || undefined
}

const validateLink = (value: unknown): string | undefined => {
  const link = optionalString(value, 'link')
  if (!link) return undefined
  let url: URL
  try {
    url = new URL(link)
  } catch {
    throw new Error(`link is not a valid URL: ${link}`)
  }
  // アーティファクトがそのままリンクとして開くため、javascript: などを通さない
  if (url.protocol !== 'https:') throw new Error('link must be an https URL')
  return url.toString()
}

const validateOptions = (value: unknown): DecisionOption[] | undefined => {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('options must be an array of {key, label}')
  if (value.length === 0) return undefined
  const seen = new Set<string>()
  return value.map((item, i) => {
    const { key, label } = (item ?? {}) as { key?: unknown; label?: unknown }
    if (typeof key !== 'string' || !key.trim()) throw new Error(`options[${i}].key is required`)
    if (typeof label !== 'string' || !label.trim()) throw new Error(`options[${i}].label is required`)
    const k = key.trim()
    if (seen.has(k)) throw new Error(`options key is duplicated: ${k}`)
    seen.add(k)
    return { key: k, label: label.trim() }
  })
}

/**
 * オーケストレーターがユーザーに出す判断待ちの質問（MCP の ask_user / list_pending_decisions /
 * answer_decision / resolve_decision）を保存する。
 * 常駐オーケストレーターはディレクトリ単位のメモリでは運用を共有できないため、ToRide の DB に持たせる。
 */
export class DecisionService {
  constructor(private db: Database.Database) {}

  create(input: CreateDecisionInput): Decision {
    const title = optionalString(input.title, 'title')
    if (!title) throw new Error('title is required')
    const now = new Date().toISOString()
    const options = validateOptions(input.options)
    const result = this.db
      .prepare(
        `INSERT INTO decisions (project, title, body, link, options, task_id, status, answer, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?)`
      )
      .run(
        optionalString(input.project, 'project') ?? null,
        title,
        optionalString(input.body, 'body') ?? null,
        validateLink(input.link) ?? null,
        options ? JSON.stringify(options) : null,
        optionalString(input.task_id, 'task_id') ?? null,
        now,
        now
      )
    return this.getBySeq(Number(result.lastInsertRowid))!
  }

  /** 既定は open と answered。includeResolved で解決済みも含める。古い順（番号順） */
  list(opts: { includeResolved?: boolean; project?: string } = {}): Decision[] {
    const where: string[] = []
    const params: unknown[] = []
    if (!opts.includeResolved) where.push(`status IN ('open', 'answered')`)
    if (opts.project) {
      where.push(`project = ?`)
      params.push(opts.project)
    }
    const rows = this.db
      .prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ASC`)
      .all(...params) as Row[]
    return rows.map(toDecision)
  }

  get(id: string): Decision {
    const seq = parseId(id)
    const decision = seq === null ? undefined : this.getBySeq(seq)
    if (!decision) throw new Error(`Decision not found: ${id}. Use list_pending_decisions to get valid IDs.`)
    return decision
  }

  answer(id: string, input: { choice?: unknown; text?: unknown }): Decision {
    const decision = this.get(id)
    if (decision.status === 'resolved') throw new Error(`${decision.id} is already resolved`)
    const choice = optionalString(input.choice, 'choice')
    const text = optionalString(input.text, 'text')
    if (!choice && !text) throw new Error('Either choice or text is required')
    if (choice) {
      const keys = decision.options?.map((o) => o.key) ?? []
      if (!keys.includes(choice)) {
        throw new Error(
          keys.length
            ? `choice must be one of: ${keys.join(', ')}`
            : `${decision.id} has no options. Answer with text instead.`
        )
      }
    }
    const now = new Date().toISOString()
    const answer: DecisionAnswer = { ...(choice ? { choice } : {}), ...(text ? { text } : {}), at: now }
    this.db
      .prepare(`UPDATE decisions SET status = 'answered', answer = ?, updated_at = ? WHERE seq = ?`)
      .run(JSON.stringify(answer), now, parseId(decision.id))
    return this.get(decision.id)
  }

  resolve(id: string): Decision {
    const decision = this.get(id)
    if (decision.status === 'resolved') return decision
    this.db
      .prepare(`UPDATE decisions SET status = 'resolved', updated_at = ? WHERE seq = ?`)
      .run(new Date().toISOString(), parseId(decision.id))
    return this.get(decision.id)
  }

  private getBySeq(seq: number): Decision | undefined {
    const row = this.db.prepare(`SELECT * FROM decisions WHERE seq = ?`).get(seq) as Row | undefined
    return row ? toDecision(row) : undefined
  }
}

function toDecision(row: Row): Decision {
  // 空の項目は落とす。並びは id → 内容 → 状態 → 日時にそろえる（一覧で読みやすいように）
  return {
    id: toId(row.seq),
    ...(row.project ? { project: row.project } : {}),
    title: row.title,
    ...(row.body ? { body: row.body } : {}),
    ...(row.link ? { link: row.link } : {}),
    ...(row.options ? { options: JSON.parse(row.options) as DecisionOption[] } : {}),
    ...(row.task_id ? { task_id: row.task_id } : {}),
    status: row.status,
    ...(row.answer ? { answer: JSON.parse(row.answer) as DecisionAnswer } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 回答を質問したタスクに届けるときの本文。例: 「Q3 に回答あり: Q3-A（案A） / 補足…」 */
export function formatAnswerMessage(decision: Decision): string {
  const answer = decision.answer
  const parts: string[] = []
  if (answer?.choice) {
    const label = decision.options?.find((o) => o.key === answer.choice)?.label
    parts.push(`${decision.id}-${answer.choice}${label ? `（${label}）` : ''}`)
  }
  if (answer?.text) parts.push(answer.text)
  return [
    `${decision.id} に回答あり: ${parts.join(' / ')}`,
    `質問: ${decision.title}`,
    `（対応を終えたら ToRide の resolve_decision で id="${decision.id}" を閉じる）`,
  ].join('\n')
}
