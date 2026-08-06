import type { GitHubTokenVerifyResult } from '../../../src/types/ipc'
import type { SearchTokenEntry } from '../utils/githubToken'

export type GitHubPullRequest = {
  number: number
  title: string
  html_url: string
  repositoryName: string
  repositoryFullName: string
  draft: boolean
  state: string
}

export type GitHubAuthFailure = {
  /** トークンのスコープ等の識別ラベル（トークン本体は含めない） */
  label: string
  status: number
  detail: string
}

export type ReviewRequestedResult = {
  prs: GitHubPullRequest[]
  /** PRのURL → そのPRを発見したトークン。同期処理内でのみ使用し永続化しない */
  tokenByUrl: Map<string, string>
  authErrors: GitHubAuthFailure[]
}

/** 401 / 403（権限不足）。レート制限とは区別する */
export class GitHubAuthError extends Error {
  constructor(
    readonly status: number,
    readonly target: string,
    readonly detail: string
  ) {
    super(`GitHub 認証エラー ${status} (${target}): ${detail}`)
    this.name = 'GitHubAuthError'
  }
}

const BASE_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28'
} as const

function authHeaders(token: string): Record<string, string> {
  return { ...BASE_HEADERS, Authorization: `Bearer ${token}` }
}

/**
 * 認証・権限エラーかどうか。
 * 403 はレート制限でも返るため、残数が0のときは認証エラー扱いにしない。
 */
function isAuthFailure(res: Response): boolean {
  if (res.status === 401) return true
  if (res.status === 403) return res.headers.get('x-ratelimit-remaining') !== '0'
  return false
}

/** "2026-08-05 12:00:00 UTC" 形式の有効期限ヘッダをISO8601に変換する */
function parseExpirationHeader(value: string | null): string | undefined {
  if (!value) return undefined
  const date = new Date(value.replace(/ UTC$/, 'Z').replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

export class GitHubService {
  /**
   * レビュー依頼されているオープンなPRを取得する。
   * fine-grained token はアクセス可能リポジトリしか検索できないため、
   * 登録トークンごとに検索して結果をURLでマージする。
   * 認証エラーは throw せず authErrors に集約し、他トークンの検索は続行する。
   */
  async fetchReviewRequestedPRs(
    username: string,
    tokens: SearchTokenEntry[]
  ): Promise<ReviewRequestedResult> {
    const prs: GitHubPullRequest[] = []
    const seenUrls = new Set<string>()
    const tokenByUrl = new Map<string, string>()
    const authErrors: GitHubAuthFailure[] = []
    const otherErrors: Error[] = []

    for (const { token, label } of tokens) {
      try {
        const found = await this.searchReviewRequestedPRs(username, token, label)
        for (const pr of found) {
          if (!tokenByUrl.has(pr.html_url)) tokenByUrl.set(pr.html_url, token)
          if (seenUrls.has(pr.html_url)) continue
          seenUrls.add(pr.html_url)
          prs.push(pr)
        }
      } catch (error) {
        if (error instanceof GitHubAuthError) {
          authErrors.push({ label, status: error.status, detail: error.detail })
        } else {
          console.warn(`[github] review-requested search failed (${label}):`, error)
          otherErrors.push(error as Error)
        }
      }
    }

    // 認証以外の理由で全滅した場合は手動同期でエラーを見せたいので throw する
    if (prs.length === 0 && authErrors.length === 0 && otherErrors.length > 0) {
      throw otherErrors[0]
    }

    return { prs, tokenByUrl, authErrors }
  }

  private async searchReviewRequestedPRs(
    username: string,
    token: string,
    label: string
  ): Promise<GitHubPullRequest[]> {
    const query = `is:pr is:open review-requested:${username} archived:false`
    const headers = authHeaders(token)

    type RawItem = {
      number: number
      title: string
      html_url: string
      repository_url: string
      draft: boolean
      state: string
    }

    const allItems: RawItem[] = []
    const perPage = 100
    let page = 1

    while (true) {
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`
      const res = await fetch(url, { headers })

      if (!res.ok) {
        const body = await res.text()
        if (isAuthFailure(res)) {
          throw new GitHubAuthError(res.status, `search/issues (${label})`, body)
        }
        throw new Error(`GitHub API error ${res.status}: ${body}`)
      }

      const data = (await res.json()) as { total_count?: number; items?: RawItem[] }

      if (!data.items) {
        throw new Error(`GitHub API returned unexpected response (items missing)`)
      }

      allItems.push(...data.items)

      // 取得件数が total_count に達したか、1ページ未満なら終了
      if (data.items.length < perPage || allItems.length >= (data.total_count ?? 0)) {
        break
      }
      page++
    }

    return allItems.map((item) => {
      // repository_url: https://api.github.com/repos/owner/repo
      const parts = item.repository_url.split('/')
      const repositoryFullName = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
      const repositoryName = parts[parts.length - 1]
      return {
        number: item.number,
        title: item.title,
        html_url: item.html_url,
        repositoryName,
        repositoryFullName,
        draft: item.draft ?? false,
        state: item.state
      }
    })
  }

  /** PRのURLから単一PRの情報を取得する（トークンは任意・publicリポジトリなら省略可） */
  async fetchPullRequest(url: string, pat?: string): Promise<GitHubPullRequest> {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!match) throw new Error('PRのURLを解析できませんでした')
    const [, owner, repo, number] = match

    const headers = pat ? authHeaders(pat) : { ...BASE_HEADERS }

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers
    })
    if (!res.ok) {
      // fine-grained token では対象リポジトリ未選択でも404が返るため、トークンの有無を問わず案内する
      if (res.status === 404) {
        throw new Error(
          `PRが見つかりませんでした（privateリポジトリの場合は設定で ${owner} 用のGitHubトークンを登録してください）`
        )
      }
      const body = await res.text()
      if (isAuthFailure(res)) {
        throw new GitHubAuthError(res.status, `${owner}/${repo}`, body)
      }
      throw new Error(`GitHub API エラー ${res.status}: ${body}`)
    }

    const data = (await res.json()) as {
      number: number
      title: string
      html_url: string
      draft?: boolean
      state: string
      merged?: boolean
    }

    return {
      number: data.number,
      title: data.title,
      html_url: data.html_url,
      repositoryName: repo,
      repositoryFullName: `${owner}/${repo}`,
      draft: data.draft ?? false,
      state: data.merged ? 'merged' : data.state
    }
  }

  /**
   * PRのステータスを取得する。
   * 認証・権限エラーは GitHubAuthError を throw する（呼び出し側で通知するため握り潰さない）。
   * それ以外の失敗は null を返す。
   */
  async fetchPRStatus(
    url: string,
    pat: string
  ): Promise<'open' | 'draft' | 'merged' | 'closed' | null> {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!match) return null
    const [, owner, repo, number] = match

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
    const res = await fetch(apiUrl, { headers: authHeaders(pat) })
    if (!res.ok) {
      if (isAuthFailure(res)) {
        const body = await res.text()
        throw new GitHubAuthError(res.status, `${owner}/${repo}`, body)
      }
      return null
    }

    const data = await res.json()
    if (data.merged) return 'merged'
    if (data.draft) return 'draft'
    return data.state as 'open' | 'closed'
  }

  /**
   * トークンの疎通確認。
   * fine-grained token は /user が通っても対象リポジトリの権限があるとは限らないため、
   * スコープ対象への実アクセスまで確認する。
   */
  async verifyToken(scope: string, token: string): Promise<GitHubTokenVerifyResult> {
    const [owner, repo] = scope.split('/')
    if (!owner) {
      return { ok: false, message: 'スコープを owner または owner/repo 形式で入力してください' }
    }

    const headers = authHeaders(token)

    const userRes = await fetch('https://api.github.com/user', { headers })
    const expiresAt = parseExpirationHeader(
      userRes.headers.get('github-authentication-token-expiration')
    )
    if (!userRes.ok) {
      return {
        ok: false,
        expiresAt,
        message: `トークンが無効です（GET /user が ${userRes.status}）`
      }
    }
    const login = ((await userRes.json()) as { login?: string }).login

    // owner/repo スコープは対象リポジトリを直接叩いて確認する
    if (repo) {
      const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers })
      if (!repoRes.ok) {
        return {
          ok: false,
          login,
          expiresAt,
          message: `${scope} にアクセスできません（${repoRes.status}）。トークンの対象リポジトリと権限（Pull requests: Read / Metadata: Read）を確認してください`
        }
      }
      return {
        ok: true,
        login,
        expiresAt,
        repositories: [scope],
        message: `${scope} にアクセスできます`
      }
    }

    // owner スコープはアクセス可能リポジトリを列挙して owner 配下の有無を確認する
    const { repositories, truncated } = await this.listAccessibleRepos(token, owner)
    if (repositories.length === 0) {
      return {
        ok: false,
        login,
        expiresAt,
        message: truncated
          ? `${owner} 配下のリポジトリを確認できませんでした（アクセス可能リポジトリが多いため列挙を打ち切りました）`
          : `${owner} 配下にアクセスできるリポジトリがありません。トークンの対象リポジトリを確認してください`
      }
    }
    return {
      ok: true,
      login,
      expiresAt,
      repositories,
      truncated,
      message: `${owner} 配下の ${repositories.length}${truncated ? '+' : ''} リポジトリにアクセスできます`
    }
  }

  /** トークンでアクセスできる owner 配下のリポジトリを列挙する（最大3ページで打ち切り） */
  private async listAccessibleRepos(
    token: string,
    owner: string
  ): Promise<{ repositories: string[]; truncated: boolean }> {
    const headers = authHeaders(token)
    const prefix = `${owner.toLowerCase()}/`
    const perPage = 100
    const maxPages = 3
    const repositories: string[] = []
    let truncated = false

    for (let page = 1; page <= maxPages; page++) {
      const res = await fetch(
        `https://api.github.com/user/repos?per_page=${perPage}&page=${page}&sort=full_name`,
        { headers }
      )
      if (!res.ok) {
        // 列挙できない場合は「確認できなかった」として扱う
        truncated = true
        break
      }
      const items = (await res.json()) as Array<{ full_name?: string }>
      for (const item of items) {
        if (item.full_name?.toLowerCase().startsWith(prefix)) {
          repositories.push(item.full_name)
        }
      }
      if (items.length < perPage) break
      if (page === maxPages) truncated = true
    }

    return { repositories, truncated }
  }
}
