export type GitHubPullRequest = {
  number: number
  title: string
  html_url: string
  repositoryName: string
  repositoryFullName: string
  draft: boolean
  state: string
}

export class GitHubService {
  async fetchReviewRequestedPRs(username: string, pat: string): Promise<GitHubPullRequest[]> {
    const query = `is:pr is:open review-requested:${username} archived:false`
    const headers = {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }

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

  /** PRのURLから単一PRの情報を取得する（PATは任意・publicリポジトリなら省略可） */
  async fetchPullRequest(url: string, pat?: string): Promise<GitHubPullRequest> {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!match) throw new Error('PRのURLを解析できませんでした')
    const [, owner, repo, number] = match

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (pat) headers['Authorization'] = `Bearer ${pat}`

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, {
      headers
    })
    if (!res.ok) {
      if (res.status === 404 && !pat) {
        throw new Error(
          'PRが見つかりませんでした（privateリポジトリの場合は設定でGitHub PATを登録してください）'
        )
      }
      const body = await res.text()
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

  async fetchPRStatus(
    url: string,
    pat: string
  ): Promise<'open' | 'draft' | 'merged' | 'closed' | null> {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
    if (!match) return null
    const [, owner, repo, number] = match

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
    if (!res.ok) return null

    const data = await res.json()
    if (data.merged) return 'merged'
    if (data.draft) return 'draft'
    return data.state as 'open' | 'closed'
  }
}
