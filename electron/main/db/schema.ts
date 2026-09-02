import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'fs'
import path from 'path'

let db: Database.Database

export function initDatabase(): Database.Database {
  const userDataDir = app.getPath('userData')
  const dbPath = path.join(userDataDir, 'toride.db')

  // アプリ名変更（claude-task-manager → toride）に伴うDB移行
  if (!fs.existsSync(dbPath)) {
    const oldDbPath = path.join(path.dirname(userDataDir), 'claude-task-manager', 'claude-task-manager.db')
    if (fs.existsSync(oldDbPath)) {
      fs.mkdirSync(userDataDir, { recursive: true })
      fs.copyFileSync(oldDbPath, dbPath)
    }
  }

  db = new Database(dbPath)

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'will_do',
      title TEXT NOT NULL,
      pane TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_runtime (
      task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
      pid INTEGER,
      workdir TEXT,
      context_used INTEGER,
      context_limit INTEGER,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS task_archive (
      id TEXT PRIMARY KEY,
      task_data TEXT NOT NULL,
      archived_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dismissed_prs (
      url TEXT PRIMARY KEY,
      dismissed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      level TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      navigation TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_created_at
      ON notifications(created_at DESC);
  `)

  // マイグレーション: task_runtime.rotation_state（RotationRuntime を JSON で保持）
  // 列を1本にまとめることで、項目追加のたびに ALTER TABLE を増やさずに済む
  const runtimeCols = db.prepare(`PRAGMA table_info(task_runtime)`).all() as Array<{ name: string }>
  if (!runtimeCols.some((c) => c.name === 'rotation_state')) {
    db.exec(`ALTER TABLE task_runtime ADD COLUMN rotation_state TEXT`)
  }

  return db
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.')
  }
  return db
}
