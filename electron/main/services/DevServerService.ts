import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import type { DevServerConfig, PaneConfig, DevServerStatus, DevServerExitInfo } from '../../../src/types/ipc'
import { expandPath } from '../utils/path'
import { resolveDevServerUrl } from '../../../src/utils/devServerUrl'

/**
 * 1サーバーあたりのログ保持上限（String.length 基準＝UTF-16コードユニット数。
 * 日本語ログでは実メモリはこれより大きくなる）。超えたら KEEP_LOG_CHARS まで古い側を捨てる。
 * 毎チャンク切り詰めると保持分まるごとのコピーが走るため、切り落とし先を別に設けて頻度を落としている。
 */
const MAX_LOG_CHARS = 2 * 1024 * 1024
const KEEP_LOG_CHARS = 1.5 * 1024 * 1024
const TRUNCATED_MARK = '[... 古いログは省略されました ...]\n'

export type DevServerChangeCallback = (statuses: DevServerStatus[]) => void
export type AbnormalExitCallback = (info: { repoId: string; paneId: string; label: string }) => void

export class DevServerService {
  private processes: Map<string, ChildProcess> = new Map()
  private logs: Map<string, string> = new Map()
  private configs: Map<string, { repoId: string; paneConfig: PaneConfig; serverConfig: DevServerConfig }> =
    new Map()
  private lastExits: Map<string, DevServerExitInfo> = new Map()
  private changeCallbacks: Set<DevServerChangeCallback> = new Set()
  private stoppingKeys: Set<string> = new Set()
  private abnormalExitCallback?: AbnormalExitCallback

  private key(repoId: string, paneId: string, label: string): string {
    return `${repoId}:${paneId}:${label}`
  }

  start(repoId: string, paneConfig: PaneConfig, serverConfig: DevServerConfig): void {
    const k = this.key(repoId, paneConfig.id, serverConfig.label)

    if (this.processes.has(k)) {
      this.stop(repoId, paneConfig.id, serverConfig.label)
    }

    const resolvedPath = expandPath(paneConfig.path)
    this.configs.set(k, { repoId, paneConfig, serverConfig })
    this.logs.set(k, '')
    this.lastExits.delete(k)

    if (!existsSync(resolvedPath)) {
      const message = `ディレクトリが存在しません: ${resolvedPath}`
      this.logs.set(k, `[error] ${message}\n設定画面でpaneのパスを確認してください。\n`)
      this.recordExit(k, { code: null, signal: null, at: new Date().toISOString(), reason: 'abnormal', message })
      this.notifyChange()
      return
    }

    // Electronはシェルの環境を継承しないためhomebrew等がPATHに入らない。
    // -l（ログインシェル）は .zprofile 等でexit/execが走り即終了するリスクがあるため
    // 使わず、PATHを明示的に補強して -c でコマンドを実行する。
    const userShell = process.env.SHELL || '/bin/bash'
    const cmdString = [serverConfig.command, ...serverConfig.args].join(' ')
    const home = process.env.HOME || ''
    const env = {
      ...process.env,
      PATH: `${home}/.bun/bin:${home}/.volta/bin:${home}/.nvm/versions/node/current/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
      NODE_ENV: 'development'
    }

    const child = spawn(userShell, ['-c', cmdString], {
      cwd: resolvedPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    })

    this.processes.set(k, child)

    child.stdout?.on('data', (data: Buffer) => {
      this.appendLog(k, data.toString())
    })

    child.stderr?.on('data', (data: Buffer) => {
      this.appendLog(k, data.toString())
    })

    child.on('error', (err) => {
      this.appendLog(k, `[error] ${err.message}\n`)
      this.processes.delete(k)
      this.recordExit(k, {
        code: null,
        signal: null,
        at: new Date().toISOString(),
        reason: this.stoppingKeys.has(k) ? 'manual' : 'abnormal',
        message: err.message
      })
      this.notifyChange()
    })

    child.on('exit', (code, signal) => {
      this.appendLog(k, `\n[exited: code=${code} signal=${signal}]\n`)
      const intentional = this.stoppingKeys.has(k)
      this.stoppingKeys.delete(k)
      this.processes.delete(k)
      this.recordExit(k, {
        code,
        signal,
        at: new Date().toISOString(),
        reason: intentional ? 'manual' : 'abnormal'
      })
      this.notifyChange()
      if (!intentional && code !== 0) {
        const cfg = this.configs.get(k)
        if (cfg) {
          this.abnormalExitCallback?.({ repoId: cfg.repoId, paneId: cfg.paneConfig.id, label: serverConfig.label })
        }
      }
    })

    this.notifyChange()
  }

  stop(repoId: string, paneId: string, label: string): void {
    const k = this.key(repoId, paneId, label)
    const child = this.processes.get(k)
    if (!child || child.pid == null) return

    this.stoppingKeys.add(k)
    const pid = child.pid
    try {
      // detached: true で起動したプロセスグループ全体に SIGTERM を送る
      process.kill(-pid, 'SIGTERM')
    } catch {
      this.processes.delete(k)
      this.notifyChange()
      return
    }

    setTimeout(() => {
      if (this.processes.has(k)) {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // already dead
        }
        this.processes.delete(k)
        this.notifyChange()
      }
    }, 3000)
  }

  status(): DevServerStatus[] {
    const statuses: DevServerStatus[] = []

    for (const [k, config] of this.configs) {
      const child = this.processes.get(k)
      statuses.push({
        repoId: config.repoId,
        paneId: config.paneConfig.id,
        label: config.serverConfig.label,
        running: !!child,
        pid: child?.pid,
        url: resolveDevServerUrl(config.serverConfig.url),
        lastExit: this.lastExits.get(k)
      })
    }

    return statuses
  }

  getLog(repoId: string, paneId: string, label: string): string {
    return this.logs.get(this.key(repoId, paneId, label)) || ''
  }

  /** 直近の終了情報。起動したことがない／まだ終了していない場合は undefined */
  getLastExit(repoId: string, paneId: string, label: string): DevServerExitInfo | undefined {
    return this.lastExits.get(this.key(repoId, paneId, label))
  }

  private recordExit(key: string, info: DevServerExitInfo): void {
    this.lastExits.set(key, info)
  }

  /** ログを追記する。上限を超えたら古い側を行頭で切り落とす */
  private appendLog(key: string, chunk: string): void {
    const next = (this.logs.get(key) || '') + chunk
    if (next.length <= MAX_LOG_CHARS) {
      this.logs.set(key, next)
      return
    }
    const kept = next.slice(next.length - KEEP_LOG_CHARS)
    const nl = kept.indexOf('\n')
    this.logs.set(key, TRUNCATED_MARK + (nl >= 0 ? kept.slice(nl + 1) : kept))
  }

  onStatusChange(callback: DevServerChangeCallback): () => void {
    this.changeCallbacks.add(callback)
    return () => {
      this.changeCallbacks.delete(callback)
    }
  }

  onAbnormalExit(callback: AbnormalExitCallback): void {
    this.abnormalExitCallback = callback
  }

  stopAll(): void {
    for (const [k, child] of this.processes) {
      if (child.pid != null) {
        try {
          // アプリ終了時なので SIGKILL で確実に終了させる
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // already dead
        }
      }
      this.processes.delete(k)
    }
  }

  private notifyChange(): void {
    const statuses = this.status()
    for (const cb of this.changeCallbacks) {
      cb(statuses)
    }
  }
}
