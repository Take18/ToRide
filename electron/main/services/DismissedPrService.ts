import type Database from 'better-sqlite3'

/**
 * dismissしたレビューPRのURLを管理するサービス。
 * dismiss済みPRはPR自動同期でタスク再作成の対象外になる。
 * PRがclose/mergeされたレコードは同期時に削除され、テーブルの肥大を防ぐ。
 */
export class DismissedPrService {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
  }

  add(url: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO dismissed_prs (url, dismissed_at) VALUES (?, ?)`)
      .run(url, new Date().toISOString())
  }

  listUrls(): string[] {
    const rows = this.db.prepare(`SELECT url FROM dismissed_prs`).all() as Array<{ url: string }>
    return rows.map((row) => row.url)
  }

  remove(url: string): void {
    this.db.prepare(`DELETE FROM dismissed_prs WHERE url = ?`).run(url)
  }
}
