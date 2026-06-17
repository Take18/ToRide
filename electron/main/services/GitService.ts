import simpleGit from 'simple-git'
import type { GitStatusResult } from '../../../src/types/ipc'

export class GitService {
  async status(workdir: string): Promise<GitStatusResult> {
    try {
      const git = simpleGit(workdir)
      const statusResult = await git.status()

      let ahead = 0
      let behind = 0
      try {
        const branchInfo = await git.branch()
        const current = branchInfo.current
        const tracking = branchInfo.branches[current]?.label
        if (tracking && current) {
          const remote = `origin/${current}`
          try {
            const log = await git.log({ from: remote, to: 'HEAD' })
            ahead = log.total
            const logBehind = await git.log({ from: 'HEAD', to: remote })
            behind = logBehind.total
          } catch {
            // Remote branch may not exist
          }
        }
      } catch {
        // No remote tracking branch
      }

      return {
        branch: statusResult.current || 'HEAD',
        ahead,
        behind,
        modified: statusResult.files.length
      }
    } catch (error) {
      return {
        branch: 'unknown',
        ahead: 0,
        behind: 0,
        modified: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async checkout(workdir: string, branch: string, baseBranch?: string): Promise<void> {
    const git = simpleGit(workdir)
    const branches = await git.branchLocal()
    if (branches.all.includes(branch)) {
      // ローカルに存在 → そのまま切り替え
      await git.checkout(branch)
    } else if (baseBranch) {
      const allBranches = await git.branch(['-a'])
      const hasLocal = baseBranch in allBranches.branches
      const remoteBase = `remotes/origin/${baseBranch}`
      const hasRemote = allBranches.all.includes(remoteBase)
      if (hasLocal) {
        // ローカルのbaseBranchから切る（tracking設定なし）= git sw -c branch base
        await git.raw(['switch', '-c', branch, baseBranch])
      } else if (hasRemote) {
        // リモートのみ存在する場合は --no-track で作成
        await git.raw(['switch', '-c', branch, '--no-track', `origin/${baseBranch}`])
      } else {
        // どちらも存在しない場合はHEADから作成
        await git.checkoutLocalBranch(branch)
      }
    } else {
      // 現在のHEADから新規作成
      await git.checkoutLocalBranch(branch)
    }
  }

  async getRemoteFullName(workdir: string): Promise<string | null> {
    try {
      const git = simpleGit(workdir)
      const remoteUrl = await git.remote(['get-url', 'origin'])
      if (!remoteUrl) return null
      const match = remoteUrl.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)
      return match ? match[1] : null
    } catch {
      return null
    }
  }

  async branches(workdir: string): Promise<string[]> {
    try {
      const git = simpleGit(workdir)
      const result = await git.branch(['-a'])
      const names = new Set<string>()
      for (const name of result.all) {
        // remotes/origin/HEAD などは除外
        if (name.includes('HEAD')) continue
        if (name.startsWith('remotes/origin/')) {
          names.add(name.replace('remotes/origin/', ''))
        } else {
          names.add(name)
        }
      }
      return Array.from(names).sort()
    } catch {
      return []
    }
  }
}
