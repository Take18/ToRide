import { execFileSync } from 'child_process'
import * as pty from 'node-pty'

export type TerminalDataCallback = (data: string) => void

/** SIGTERM を送ってから SIGKILL に切り替えるまでの猶予 */
const KILL_GRACE_MS = 3000

export class TerminalService {
  private sessions: Map<string, pty.IPty> = new Map()
  private dataListeners: Map<string, Set<TerminalDataCallback>> = new Map()
  // 猶予後の SIGKILL タイマー（アプリ終了時にまとめて片付ける）
  private killTimers: Set<NodeJS.Timeout> = new Set()

  start(taskId: string, workdir: string, cols = 120, rows = 30, extraEnv?: Record<string, string>): void {
    if (this.sessions.has(taskId)) {
      this.kill(taskId)
    }

    const shell = process.env.SHELL || '/bin/bash'
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
      ...extraEnv
    }

    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: workdir,
      env
    })

    this.sessions.set(taskId, ptyProcess)

    ptyProcess.onData((data) => {
      const listeners = this.dataListeners.get(taskId)
      if (listeners) {
        for (const cb of listeners) {
          cb(data)
        }
      }
    })

    ptyProcess.onExit(() => {
      if (this.sessions.get(taskId) === ptyProcess) {
        this.sessions.delete(taskId)
      }
    })
  }

  hasSession(taskId: string): boolean {
    return this.sessions.has(taskId)
  }

  write(taskId: string, data: string): void {
    const session = this.sessions.get(taskId)
    if (!session) {
      throw new Error(`No terminal session for task: ${taskId}`)
    }
    session.write(data)
  }

  /**
   * セッションを終了する。
   * pty.kill() はログインシェルにしかシグナルを送らないため、claude が起動した
   * バックグラウンドジョブが生き残って通知を出し続けることがある。
   * そのため kill 前に子孫プロセスを洗い出し、まとめて終了させる。
   *
   * @param immediate true なら猶予なしで SIGKILL（アプリ終了時など、タイマーが発火しない場面用）
   */
  kill(taskId: string, immediate = false): void {
    const session = this.sessions.get(taskId)
    if (!session) return

    const rootPid = session.pid
    // 親を殺すと子は reparent されて辿れなくなるので、シグナルを送る前に洗い出す
    const descendants = this.collectDescendants(rootPid)

    this.emit(taskId, '\r\n\x1b[33m[ToRide] セッションを終了しました\x1b[0m\r\n')
    this.sessions.delete(taskId)
    this.dataListeners.delete(taskId)

    if (immediate) {
      this.signal([...descendants, rootPid], 'SIGKILL')
      this.killPty(session, 'SIGKILL')
      return
    }

    // claude 本体に後片付けの猶予を与えつつ、子孫にも同時に停止を通知する
    this.signal(descendants, 'SIGTERM')
    this.killPty(session)

    const timer = setTimeout(() => {
      this.killTimers.delete(timer)
      const alive = [...descendants, rootPid].filter((pid) => this.isAlive(pid))
      if (alive.length > 0) {
        console.warn(`[TerminalService] SIGTERM に応じないプロセスを SIGKILL します: ${alive.join(', ')}`)
        this.signal(alive, 'SIGKILL')
      }
    }, KILL_GRACE_MS)
    timer.unref?.()
    this.killTimers.add(timer)
  }

  resize(taskId: string, cols: number, rows: number): void {
    const session = this.sessions.get(taskId)
    if (session) {
      session.resize(cols, rows)
    }
  }

  onData(taskId: string, callback: TerminalDataCallback): () => void {
    if (!this.dataListeners.has(taskId)) {
      this.dataListeners.set(taskId, new Set())
    }
    this.dataListeners.get(taskId)!.add(callback)

    return () => {
      const listeners = this.dataListeners.get(taskId)
      if (listeners) {
        listeners.delete(callback)
      }
    }
  }

  getPid(taskId: string): number | undefined {
    const session = this.sessions.get(taskId)
    return session?.pid
  }

  killAll(): void {
    // アプリ終了後は setTimeout が発火しないので、猶予なしで落とし切る
    for (const [taskId] of this.sessions) {
      this.kill(taskId, true)
    }
    for (const timer of this.killTimers) {
      clearTimeout(timer)
    }
    this.killTimers.clear()
  }

  private emit(taskId: string, data: string): void {
    const listeners = this.dataListeners.get(taskId)
    if (!listeners) return
    for (const cb of [...listeners]) {
      try {
        cb(data)
      } catch {
        // 表示用の通知なので、購読側の失敗で kill を止めない
      }
    }
  }

  private killPty(session: pty.IPty, signal?: string): void {
    try {
      session.kill(signal)
    } catch {
      // 既に終了している
    }
  }

  /** rootPid 配下の子孫 PID を ps から集める（深さ優先・rootPid 自身は含まない） */
  private collectDescendants(rootPid: number): number[] {
    if (process.platform === 'win32') return []
    let output: string
    try {
      output = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf-8' })
    } catch (e) {
      console.error('[TerminalService] プロセス一覧の取得に失敗しました:', e)
      return []
    }

    const childrenByPpid = new Map<number, number[]>()
    for (const line of output.split('\n')) {
      const matched = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (!matched) continue
      const pid = Number(matched[1])
      const ppid = Number(matched[2])
      const siblings = childrenByPpid.get(ppid)
      if (siblings) siblings.push(pid)
      else childrenByPpid.set(ppid, [pid])
    }

    const descendants: number[] = []
    const stack = [rootPid]
    const seen = new Set<number>([rootPid])
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const child of childrenByPpid.get(current) ?? []) {
        if (seen.has(child)) continue
        seen.add(child)
        descendants.push(child)
        stack.push(child)
      }
    }
    return descendants
  }

  private signal(pids: number[], sig: NodeJS.Signals): void {
    for (const pid of pids) {
      if (pid <= 1) continue
      try {
        process.kill(pid, sig)
      } catch {
        // 既に終了している
      }
    }
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
