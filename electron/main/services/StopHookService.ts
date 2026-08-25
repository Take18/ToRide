import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import type { LocalHttpServer } from './LocalHttpServer'

const HOOK_INSTALL_DIR = path.join(homedir(), '.claude', 'hooks')
const HOOK_FILE = path.join(HOOK_INSTALL_DIR, 'stop.sh')
const CLAUDE_SETTINGS_FILE = path.join(homedir(), '.claude', 'settings.json')

const LEGACY_MARKERS = ['Claude Task Manager']

const HOOK_CONTENT = `#!/bin/sh
# ToRide - Stop Hook
# このファイルは ToRide アプリが自動生成しました。
# アプリの設定画面から管理できます。
PORT_FILE="$HOME/.toride/port"
if [ -z "$CLAUDE_TASK_ID" ] || [ ! -f "$PORT_FILE" ]; then
  exit 0
fi
PORT=$(cat "$PORT_FILE")
curl -s -X POST "http://127.0.0.1:$PORT/task-done" \\
  -H "Content-Type: application/json" \\
  -d "{\\"taskId\\":\\"$CLAUDE_TASK_ID\\"}" || true
`

// ~/.claude/settings.json の hooks.Stop エントリ型
type HookEntry = { type: string; command: string }
type HookMatcher = { matcher?: string; hooks: HookEntry[] }
type ClaudeSettings = { hooks?: { Stop?: HookMatcher[] }; [key: string]: unknown }

export class StopHookService {
  // 1タスクに複数の購読者がいる（タスク完了通知 / SessionRotationService の idle 検知）ため Set で持つ
  private callbacks = new Map<string, Set<() => void>>()

  constructor(localServer: LocalHttpServer) {
    localServer.addRoute('/task-done', (body, res) => {
      try {
        const { taskId } = JSON.parse(body) as { taskId?: string }
        if (taskId) {
          // ターン終了のたびに通知するため、コールバックは削除せず維持する
          // （削除は removeTaskCallback / 購読解除関数に任せる）
          const cbs = this.callbacks.get(taskId)
          if (cbs) {
            // 実行中に購読解除されても走査が壊れないようコピーしてから回す
            for (const cb of [...cbs]) {
              try {
                cb()
              } catch (e) {
                console.error('[StopHookService] callback failed:', e)
              }
            }
          }
        }
        res.writeHead(200)
        res.end('ok')
      } catch {
        res.writeHead(400)
        res.end('bad request')
      }
    })
  }

  /** 購読を登録し、解除用の関数を返す（ContextLineService.onContextUpdate と同じ規約） */
  onTaskComplete(taskId: string, cb: () => void): () => void {
    let set = this.callbacks.get(taskId)
    if (!set) {
      set = new Set()
      this.callbacks.set(taskId, set)
    }
    set.add(cb)
    return () => {
      const current = this.callbacks.get(taskId)
      if (!current) return
      current.delete(cb)
      if (current.size === 0) this.callbacks.delete(taskId)
    }
  }

  /** 当該タスクの購読をすべて破棄する（ターミナル kill 時など） */
  removeTaskCallback(taskId: string): void {
    this.callbacks.delete(taskId)
  }

  // ~/.claude/settings.json を読み込む（なければ空オブジェクト）
  private readClaudeSettings(): ClaudeSettings {
    try {
      const content = fs.readFileSync(CLAUDE_SETTINGS_FILE, 'utf-8')
      return JSON.parse(content) as ClaudeSettings
    } catch {
      return {}
    }
  }

  // settings.json の hooks.Stop に HOOK_FILE が登録されているか
  private isRegisteredInSettings(settings: ClaudeSettings): boolean {
    return (settings.hooks?.Stop ?? []).some((m) =>
      m.hooks.some((h) => h.command === HOOK_FILE)
    )
  }

  private isManagedFile(content: string): boolean {
    return content.includes('ToRide') || LEGACY_MARKERS.some((m) => content.includes(m))
  }

  installHook(): { success: boolean; error?: string } {
    try {
      // stop.sh の書き込み
      if (fs.existsSync(HOOK_FILE)) {
        const existing = fs.readFileSync(HOOK_FILE, 'utf-8')
        if (!this.isManagedFile(existing)) {
          return {
            success: false,
            error: `${HOOK_FILE} に既存の stop.sh が存在します。手動でバックアップしてから再実行してください。`
          }
        }
      }
      fs.mkdirSync(HOOK_INSTALL_DIR, { recursive: true })
      fs.writeFileSync(HOOK_FILE, HOOK_CONTENT, { encoding: 'utf-8', mode: 0o755 })

      // ~/.claude/settings.json に hooks.Stop エントリを追加
      const settings = this.readClaudeSettings()
      if (!this.isRegisteredInSettings(settings)) {
        if (!settings.hooks) settings.hooks = {}
        if (!settings.hooks.Stop) settings.hooks.Stop = []
        settings.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command: HOOK_FILE }] })
        fs.mkdirSync(path.dirname(CLAUDE_SETTINGS_FILE), { recursive: true })
        fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8')
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  uninstallHook(): { success: boolean; error?: string } {
    try {
      // stop.sh の削除
      if (fs.existsSync(HOOK_FILE)) {
        const existing = fs.readFileSync(HOOK_FILE, 'utf-8')
        if (!this.isManagedFile(existing)) {
          return {
            success: false,
            error: `${HOOK_FILE} はこのアプリが管理するファイルではないため削除できません。`
          }
        }
        fs.unlinkSync(HOOK_FILE)
      }

      // ~/.claude/settings.json から hooks.Stop エントリを削除
      const settings = this.readClaudeSettings()
      if (settings.hooks?.Stop) {
        settings.hooks.Stop = settings.hooks.Stop
          .map((m) => ({ ...m, hooks: m.hooks.filter((h) => h.command !== HOOK_FILE) }))
          .filter((m) => m.hooks.length > 0)
        if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks
        fs.writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8')
      }

      return { success: true }
    } catch (e) {
      return { success: false, error: (e as Error).message }
    }
  }

  getHookStatus(): { installed: boolean; path: string; managedByApp: boolean; registeredInSettings: boolean } {
    const exists = fs.existsSync(HOOK_FILE)
    let managedByApp = false
    if (exists) {
      try {
        const content = fs.readFileSync(HOOK_FILE, 'utf-8')
        managedByApp = this.isManagedFile(content)
      } catch {
        // ignore
      }
    }
    const settings = this.readClaudeSettings()
    const registeredInSettings = this.isRegisteredInSettings(settings)
    return { installed: exists, path: HOOK_FILE, managedByApp, registeredInSettings }
  }
}
