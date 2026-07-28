import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import type { DevServerConfig, PaneConfig, DevServerStatus } from '../../../src/types/ipc'
import { expandPath } from '../utils/path'
import { resolveDevServerUrl } from '../../../src/utils/devServerUrl'

export type DevServerChangeCallback = (statuses: DevServerStatus[]) => void
export type AbnormalExitCallback = (info: { repoId: string; paneId: string; label: string }) => void

export class DevServerService {
  private processes: Map<string, ChildProcess> = new Map()
  private logs: Map<string, string> = new Map()
  private configs: Map<string, { repoId: string; paneConfig: PaneConfig; serverConfig: DevServerConfig }> =
    new Map()
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

    if (!existsSync(resolvedPath)) {
      this.logs.set(k, `[error] ディレクトリが存在しません: ${resolvedPath}\n設定画面でpaneのパスを確認してください。\n`)
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
      const current = this.logs.get(k) || ''
      this.logs.set(k, current + data.toString())
    })

    child.stderr?.on('data', (data: Buffer) => {
      const current = this.logs.get(k) || ''
      this.logs.set(k, current + data.toString())
    })

    child.on('error', (err) => {
      const current = this.logs.get(k) || ''
      this.logs.set(k, current + `[error] ${err.message}\n`)
      this.processes.delete(k)
      this.notifyChange()
    })

    child.on('exit', (code, signal) => {
      const current = this.logs.get(k) || ''
      this.logs.set(k, current + `\n[exited: code=${code} signal=${signal}]\n`)
      const intentional = this.stoppingKeys.has(k)
      this.stoppingKeys.delete(k)
      this.processes.delete(k)
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
        url: resolveDevServerUrl(config.serverConfig.url)
      })
    }

    return statuses
  }

  getLog(repoId: string, paneId: string, label: string): string {
    return this.logs.get(this.key(repoId, paneId, label)) || ''
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
