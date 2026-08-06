import type { AppSettings } from '../../../src/types/ipc'

/**
 * トークンのスコープ文字列を "owner" または "owner/repo" に正規化する。
 * URL貼り付け・末尾スラッシュ・.git サフィックス・大文字小文字を許容する。
 */
export function normalizeTokenScope(input: string): string {
  const trimmed = (input ?? '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length === 0) return ''
  return parts.slice(0, 2).join('/').toLowerCase()
}

/**
 * github.com のURLから owner / repo を取り出す（issues・pull・リポジトリトップ共通）。
 * api.github.com/repos/... 形式もHTML形式に読み替えてから解析する。
 */
export function parseOwnerRepoFromUrl(url: string): { owner: string; repo: string } | null {
  const normalized = (url ?? '').replace(
    /^https?:\/\/api\.github\.com\/repos\//i,
    'https://github.com/'
  )
  const match = normalized.match(/github\.com[:/]([^/\s]+)\/([^/\s?#]+)/i)
  if (!match) return null
  return { owner: match[1], repo: match[2].replace(/\.git$/i, '') }
}

/**
 * 使用するトークンを owner/repo → owner → 全owner共通の githubPat の順に引く。
 * owner が不明な場合は共通PATのみを返す。
 */
export function resolveGitHubToken(
  settings: AppSettings,
  owner?: string,
  repo?: string
): string | undefined {
  const entries = settings.githubTokens ?? []

  if (owner) {
    const ownerKey = owner.toLowerCase()

    if (repo) {
      const fullKey = `${ownerKey}/${repo.toLowerCase()}`
      const exact = entries.find(
        (e) => e.token?.trim() && normalizeTokenScope(e.scope) === fullKey
      )
      if (exact) return exact.token.trim()
    }

    const byOwner = entries.find(
      (e) => e.token?.trim() && normalizeTokenScope(e.scope) === ownerKey
    )
    if (byOwner) return byOwner.token.trim()
  }

  return settings.githubPat?.trim() || undefined
}

/** github.com のURLから対応するトークンを引く */
export function resolveGitHubTokenForUrl(
  settings: AppSettings,
  url: string
): string | undefined {
  const parsed = parseOwnerRepoFromUrl(url)
  return resolveGitHubToken(settings, parsed?.owner, parsed?.repo)
}

export type SearchTokenEntry = {
  token: string
  /** 通知・エラー表示用のラベル（トークン本体は含めない） */
  label: string
}

/**
 * レビュー依頼PRの横断検索に使うトークン一覧。
 * fine-grained token は選択したリポジトリしか見えないため、登録トークンごとに検索して結果をマージする必要がある。
 * 同一トークンが複数スコープに登録されていても検索は1回だけ行う。
 */
export function listSearchTokens(settings: AppSettings): SearchTokenEntry[] {
  const seen = new Set<string>()
  const result: SearchTokenEntry[] = []

  for (const entry of settings.githubTokens ?? []) {
    const token = entry.token?.trim()
    const scope = normalizeTokenScope(entry.scope)
    if (!token || !scope || seen.has(token)) continue
    seen.add(token)
    result.push({ token, label: scope })
  }

  const legacy = settings.githubPat?.trim()
  if (legacy && !seen.has(legacy)) {
    result.push({ token: legacy, label: '共通PAT' })
  }

  return result
}
