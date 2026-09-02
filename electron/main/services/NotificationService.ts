import type Database from 'better-sqlite3'
import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type {
  NavigationPayload,
  NotificationCategory,
  NotificationLevel,
  NotificationRecord,
} from '../../../src/types/ipc'

/** 履歴の保持上限。超えた分は古い側から削除する */
const MAX_RECORDS = 200

export type NotifyInput = {
  category: NotificationCategory
  level: NotificationLevel
  title: string
  body: string
  /** クリック時の遷移先。省略時はウィンドウのフォーカスのみ */
  navigation?: NavigationPayload | null
  /** デスクトップ通知の urgency（Linux/macOS 向け） */
  urgency?: 'normal' | 'critical'
}

type Deps = {
  db: Database.Database
  getWindow: () => BrowserWindow | null
  /** デスクトップ通知を出すか。false でも履歴には残す */
  isDesktopEnabled: () => boolean
}

type Row = {
  id: string
  category: string
  level: string
  title: string
  body: string
  navigation: string | null
  created_at: string
  read_at: string | null
}

/**
 * デスクトップ通知の発行と履歴の保存をまとめて受け持つサービス。
 *
 * Stop Hook 由来のタスク完了通知はここを通さない。
 * 完了は必ずタスクカードに残るので履歴に積むと同じ情報が二重になるうえ、
 * 「見逃すと困る通知」だけを一覧に残したいため。
 */
export class NotificationService {
  private deps: Deps

  constructor(deps: Deps) {
    this.deps = deps
  }

  /** 履歴に記録したうえでデスクトップ通知を出す */
  notify(input: NotifyInput): void {
    const record = this.record(input)

    if (!this.deps.isDesktopEnabled()) return

    const notification = new Notification({
      title: input.title,
      body: input.body,
      urgency: input.urgency ?? (input.level === 'info' ? 'normal' : 'critical'),
    })
    notification.on('click', () => {
      // 通知から来たものは読んだとみなす（一覧に未読が残り続けるのを防ぐ）
      this.markRead(record.id)
      const win = this.deps.getWindow()
      win?.show()
      win?.focus()
      if (record.navigation) win?.webContents.send('navigation:goto', record.navigation)
      this.emitUpdated()
    })
    notification.show()
  }

  list(): NotificationRecord[] {
    const rows = this.deps.db
      .prepare(`SELECT * FROM notifications ORDER BY created_at DESC, rowid DESC`)
      .all() as Row[]
    return rows.map(toRecord)
  }

  markRead(id: string): void {
    this.deps.db
      .prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`)
      .run(new Date().toISOString(), id)
  }

  markAllRead(): void {
    this.deps.db
      .prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`)
      .run(new Date().toISOString())
  }

  clear(): void {
    this.deps.db.prepare(`DELETE FROM notifications`).run()
  }

  private record(input: NotifyInput): NotificationRecord {
    const record: NotificationRecord = {
      id: randomUUID(),
      category: input.category,
      level: input.level,
      title: input.title,
      body: input.body,
      navigation: input.navigation ?? null,
      createdAt: new Date().toISOString(),
      readAt: null,
    }

    this.deps.db
      .prepare(
        `INSERT INTO notifications (id, category, level, title, body, navigation, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        record.id,
        record.category,
        record.level,
        record.title,
        record.body,
        record.navigation ? JSON.stringify(record.navigation) : null,
        record.createdAt
      )
    this.trim()
    this.emitUpdated()
    return record
  }

  /** 上限を超えた古いレコードを削除する */
  private trim(): void {
    this.deps.db
      .prepare(
        `DELETE FROM notifications WHERE id NOT IN (
           SELECT id FROM notifications ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`
      )
      .run(MAX_RECORDS)
  }

  emitUpdated(): void {
    const win = this.deps.getWindow()
    if (win && !win.isDestroyed()) win.webContents.send('notifications:updated')
  }
}

function toRecord(row: Row): NotificationRecord {
  let navigation: NavigationPayload | null = null
  if (row.navigation) {
    try {
      navigation = JSON.parse(row.navigation) as NavigationPayload
    } catch {
      navigation = null
    }
  }
  return {
    id: row.id,
    category: row.category as NotificationCategory,
    level: row.level as NotificationLevel,
    title: row.title,
    body: row.body,
    navigation,
    createdAt: row.created_at,
    readAt: row.read_at,
  }
}
