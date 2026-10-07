import type { LocalHttpServer } from './LocalHttpServer'

export type AgentSessionInfo = {
  taskId: string
  sessionId: string
  /** セッションの記録ファイル（Codex の rollout）。tail してコンテキスト使用量を読む（TranscriptContextService） */
  transcriptPath?: string
}

// セッションIDを起動前に採番できないエージェント（Codex）が、SessionStart hook から
// 採番されたIDを知らせてくる窓口。hook の stdin をそのまま data に入れて POST してくる
export class AgentSessionService {
  private callbacks = new Set<(info: AgentSessionInfo) => void>()

  constructor(localServer: LocalHttpServer) {
    localServer.addRoute('/agent-session', (body, res) => {
      try {
        const { taskId, data } = JSON.parse(body) as {
          taskId?: string
          data?: { session_id?: string; transcript_path?: string }
        }
        const sessionId = data?.session_id
        if (taskId && sessionId) {
          const info = { taskId, sessionId, transcriptPath: data?.transcript_path || undefined }
          for (const cb of [...this.callbacks]) {
            try {
              cb(info)
            } catch (e) {
              console.error('[AgentSessionService] callback failed:', e)
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

  onSession(cb: (info: AgentSessionInfo) => void): () => void {
    this.callbacks.add(cb)
    return () => this.callbacks.delete(cb)
  }
}
