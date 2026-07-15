import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const execFileAsync = promisify(execFile)

// API から取得できなかった場合のフォールバック（claude CLI の --model エイリアス）
const FALLBACK_MODELS = ['opus', 'sonnet', 'haiku']
const CACHE_TTL_MS = 60 * 60 * 1000

/**
 * Anthropic の GET /v1/models で利用可能なモデル一覧を取得するサービス。
 * 認証には Claude Code のログイン情報（OAuth トークン）をそのまま使う。
 */
export class ModelListService {
  private cache: string[] | null = null
  private fetchedAt = 0

  async listModels(): Promise<string[]> {
    if (this.cache && Date.now() - this.fetchedAt < CACHE_TTL_MS) {
      return this.cache
    }
    try {
      const token = await this.getOAuthToken()
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          // OAuth トークンで API を呼ぶには oauth beta ヘッダーが必須
          'anthropic-beta': 'oauth-2025-04-20',
        },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { data?: { id: string }[] }
      const ids = (body.data ?? []).map((m) => m.id)
      if (ids.length === 0) throw new Error('empty model list')
      this.cache = ids
      this.fetchedAt = Date.now()
      return ids
    } catch (err) {
      console.error('[ModelListService] fetch failed, using fallback:', err)
      return this.cache ?? FALLBACK_MODELS
    }
  }

  private async getOAuthToken(): Promise<string> {
    let raw: string
    if (process.platform === 'darwin') {
      // macOS: Claude Code は OAuth トークンを Keychain に保存している
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        'Claude Code-credentials',
        '-w',
      ])
      raw = stdout.trim()
    } else {
      raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf-8')
    }
    const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } })
      .claudeAiOauth?.accessToken
    if (!token) throw new Error('no accessToken in Claude Code credentials')
    return token
  }
}
