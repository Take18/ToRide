import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { parse as parseToml } from 'smol-toml'
import { expandPath } from '../utils/path'
import type { AppSettings, CodexPaneTrust, CodexTrustResult } from '../../../src/types/ipc'

const CODEX_CONFIG_FILE = path.join(homedir(), '.codex', 'config.toml')

type CodexConfig = { projects?: Record<string, { trust_level?: unknown }> }

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.trim()))
  })
}

/**
 * Codex が trust_level を引くときのキーを求める。実測では、git 管理下なら
 * メインリポジトリのルート（worktree でもメイン側）を realpath にしたパスで記録される
 */
async function resolveProjectKey(panePath: string): Promise<string> {
  let dir = expandPath(panePath)
  try {
    dir = fs.realpathSync(dir)
  } catch {
    return dir
  }
  const commonDir = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (commonDir && path.basename(commonDir) === '.git') {
    try {
      return fs.realpathSync(path.dirname(commonDir))
    } catch {
      return path.dirname(commonDir)
    }
  }
  // bare リポジトリの worktree などは作業ツリーのルートで代用する
  const top = await git(dir, ['rev-parse', '--show-toplevel'])
  return top ?? dir
}

export class CodexConfigService {
  constructor(private getSettings: () => AppSettings) {}

  private readRaw(): string {
    try {
      return fs.readFileSync(CODEX_CONFIG_FILE, 'utf-8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw e
    }
  }

  private trustLevels(raw: string): Map<string, string> {
    const config = parseToml(raw) as CodexConfig
    const levels = new Map<string, string>()
    for (const [key, value] of Object.entries(config.projects ?? {})) {
      if (typeof value?.trust_level === 'string') levels.set(key, value.trust_level)
    }
    return levels
  }

  /** 登録済みペインごとの信頼状態 */
  async listPanes(): Promise<CodexPaneTrust[]> {
    let levels = new Map<string, string>()
    try {
      levels = this.trustLevels(this.readRaw())
    } catch (e) {
      console.warn('[CodexConfigService] failed to read config.toml:', e)
    }
    const panes: CodexPaneTrust[] = []
    for (const repo of this.getSettings().repos ?? []) {
      for (const pane of repo.panes ?? []) {
        if (!pane.path) continue
        const projectKey = await resolveProjectKey(pane.path)
        panes.push({
          repoName: repo.name,
          paneId: pane.id,
          path: pane.path,
          projectKey,
          trustLevel: levels.get(projectKey),
        })
      }
    }
    return panes
  }

  /**
   * 登録済みペインを ~/.codex/config.toml で trusted にする。ユーザーが設定画面のボタンを押したときだけ呼ぶ。
   * 既存の設定に触らないよう、パースし直して書き戻すのではなく、無いテーブルを末尾に足すだけにする
   * （書き戻すとコメントや並び順が失われる）
   */
  async trustPanes(): Promise<CodexTrustResult> {
    const result: CodexTrustResult = { added: [], alreadyTrusted: [], skipped: [] }
    try {
      const raw = this.readRaw()
      const levels = this.trustLevels(raw)
      const keys = [...new Set((await this.listPanes()).map((p) => p.projectKey))]

      let appended = ''
      for (const key of keys) {
        const level = levels.get(key)
        if (level === 'trusted') {
          result.alreadyTrusted.push(key)
        } else if (level !== undefined) {
          // Codex の確認で「信頼しない」を選んだ可能性があるので、人の判断を上書きしない
          result.skipped.push({ projectKey: key, trustLevel: level })
        } else {
          appended += `\n[projects.${JSON.stringify(key)}]\ntrust_level = "trusted"\n`
          result.added.push(key)
        }
      }
      if (!appended) return result

      const next = (raw === '' || raw.endsWith('\n') ? raw : `${raw}\n`) + appended
      // 同じキーのテーブルがインライン表などで既にあると壊れたファイルになるため、書く前に確かめる
      const nextLevels = this.trustLevels(next)
      if (result.added.some((key) => nextLevels.get(key) !== 'trusted')) {
        throw new Error('書き込み後の config.toml を検証できませんでした')
      }

      fs.mkdirSync(path.dirname(CODEX_CONFIG_FILE), { recursive: true })
      const tmp = `${CODEX_CONFIG_FILE}.toride-${process.pid}.tmp`
      const mode = fs.existsSync(CODEX_CONFIG_FILE) ? fs.statSync(CODEX_CONFIG_FILE).mode : 0o600
      fs.writeFileSync(tmp, next, { encoding: 'utf-8', mode })
      fs.renameSync(tmp, CODEX_CONFIG_FILE)
      return result
    } catch (e) {
      return { ...result, added: [], error: (e as Error).message }
    }
  }
}
