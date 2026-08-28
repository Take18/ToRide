import { open, readdir, readFile, stat } from 'fs/promises'
import type { Dirent } from 'fs'
import { homedir } from 'os'
import { join, resolve, sep } from 'path'
import { expandPath } from '../utils/path'
import type { SlashCommandInfo } from '../../../src/types/ipc'

const CACHE_TTL_MS = 30 * 1000
/** frontmatter と冒頭見出しさえ読めればよいので、先頭だけ読んで打ち切る */
const HEAD_BYTES = 4096
/** 壊れた設定などで無限に潜らないためのコマンドディレクトリ探索深さ */
const MAX_COMMAND_DEPTH = 3

type PluginEntry = {
  scope?: string
  projectPath?: string
  installPath?: string
}

type InstalledPlugins = {
  plugins?: Record<string, PluginEntry[]>
}

/** ファイル先頭だけを読む（SKILL.md は数十KBになることがあるため全読みしない） */
async function readHead(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, bytesRead).toString('utf-8')
  } finally {
    await handle.close()
  }
}

/** frontmatter の description / argument-hint を拾い、無ければ冒頭の見出しか本文1行目で代用する */
function parseMeta(head: string): { description: string; argumentHint?: string } {
  let body = head
  let description = ''
  let argumentHint: string | undefined

  const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (fm) {
    body = head.slice(fm[0].length)
    const lines = fm[1].split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(description|argument-hint):\s*(.*)$/)
      if (!m) continue
      let value = m[2].trim()
      if (/^[|>][-+]?\d*$/.test(value)) {
        // ブロックスカラー（`description: |` など）。インデントされた最初の段落だけを説明として使う
        const block: string[] = []
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim() === '') {
            if (block.length > 0) break
            continue
          }
          if (!/^\s/.test(lines[j])) break
          block.push(lines[j].trim())
          i = j
        }
        value = block.join(' ')
      } else {
        value = value.replace(/^["']|["']$/g, '')
      }
      if (m[1] === 'description') description = value
      else argumentHint = value
    }
  }

  if (!description) {
    const firstLine = body.split(/\r?\n/).find((l) => l.trim() !== '')
    description = (firstLine ?? '').replace(/^#+\s*/, '').trim()
  }
  return { description: description.slice(0, 200), argumentHint }
}

/**
 * ディレクトリ直下を列挙する。
 * ~/.claude/skills 配下はシンボリックリンクで貼られていることが多く、Dirent の isDirectory() は
 * リンク自体を見て false を返すため、リンクは stat（リンク先を辿る）で判定し直す。
 */
async function safeReaddir(dir: string): Promise<{ name: string; isDir: boolean }[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return Promise.all(
    entries.map(async (e) => {
      if (!e.isSymbolicLink()) return { name: e.name, isDir: e.isDirectory() }
      try {
        return { name: e.name, isDir: (await stat(join(dir, e.name))).isDirectory() }
      } catch {
        return { name: e.name, isDir: false }
      }
    })
  )
}

/**
 * Claude Code のスラッシュコマンド・スキルを列挙するサービス。
 *
 * 収集元:
 * - ユーザー: `~/.claude/commands/**\/*.md` / `~/.claude/skills/*\/SKILL.md`
 * - プロジェクト: `<workdir>/.claude/commands` / `<workdir>/.claude/skills`
 * - プラグイン: `~/.claude/plugins/installed_plugins.json` の installPath 配下
 */
export class SlashCommandService {
  private cache = new Map<string, { items: SlashCommandInfo[]; fetchedAt: number }>()

  async listCommands(workdir?: string): Promise<SlashCommandInfo[]> {
    const key = workdir ? resolve(expandPath(workdir)) : ''
    const hit = this.cache.get(key)
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit.items

    const userDir = join(homedir(), '.claude')
    const collected: SlashCommandInfo[] = []

    // プロジェクト定義を先に積む（同名はプロジェクト > ユーザー > プラグインの優先で残す）
    if (key) {
      collected.push(...(await this.scanCommands(join(key, '.claude', 'commands'), '', 'project')))
      collected.push(...(await this.scanSkills(join(key, '.claude', 'skills'), '', 'project')))
    }
    collected.push(...(await this.scanCommands(join(userDir, 'commands'), '', 'user')))
    collected.push(...(await this.scanSkills(join(userDir, 'skills'), '', 'user')))
    collected.push(...(await this.scanPlugins(userDir, key)))

    const byName = new Map<string, SlashCommandInfo>()
    for (const item of collected) {
      if (!byName.has(item.name)) byName.set(item.name, item)
    }
    const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
    this.cache.set(key, { items, fetchedAt: Date.now() })
    return items
  }

  /** キャッシュを捨てて次回スキャンし直させる */
  invalidate(): void {
    this.cache.clear()
  }

  private async scanCommands(
    dir: string,
    prefix: string,
    source: SlashCommandInfo['source'],
    depth = 0
  ): Promise<SlashCommandInfo[]> {
    if (depth > MAX_COMMAND_DEPTH) return []
    const entries = await safeReaddir(dir)
    const results: SlashCommandInfo[] = []
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDir) {
        // サブディレクトリは名前空間（例: frontend/build.md → /frontend:build）
        results.push(...(await this.scanCommands(path, `${prefix}${entry.name}:`, source, depth + 1)))
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      const base = entry.name.slice(0, -3)
      const meta = await this.readMeta(path)
      if (!meta) continue
      results.push({ name: `${prefix}${base}`, kind: 'command', source, ...meta })
    }
    return results
  }

  private async scanSkills(
    dir: string,
    prefix: string,
    source: SlashCommandInfo['source']
  ): Promise<SlashCommandInfo[]> {
    const entries = await safeReaddir(dir)
    const results: SlashCommandInfo[] = []
    for (const entry of entries) {
      if (!entry.isDir) continue
      const meta = await this.readMeta(join(dir, entry.name, 'SKILL.md'))
      if (!meta) continue
      results.push({ name: `${prefix}${entry.name}`, kind: 'skill', source, ...meta })
    }
    return results
  }

  private async readMeta(
    path: string
  ): Promise<{ description: string; argumentHint?: string } | null> {
    try {
      return parseMeta(await readHead(path))
    } catch {
      return null
    }
  }

  private async scanPlugins(userDir: string, workdir: string): Promise<SlashCommandInfo[]> {
    let installed: InstalledPlugins
    try {
      installed = JSON.parse(
        await readFile(join(userDir, 'plugins', 'installed_plugins.json'), 'utf-8')
      ) as InstalledPlugins
    } catch {
      return []
    }

    const results: SlashCommandInfo[] = []
    for (const [key, entries] of Object.entries(installed.plugins ?? {})) {
      // "figma@mep-plugins" のマーケットプレイス部分を落として名前空間にする
      const pluginName = key.split('@')[0]
      const entry = (entries ?? []).find((e) => this.isPluginActive(e, workdir))
      if (!entry?.installPath) continue
      const prefix = `${pluginName}:`
      results.push(...(await this.scanCommands(join(entry.installPath, 'commands'), prefix, 'plugin')))
      results.push(...(await this.scanSkills(join(entry.installPath, 'skills'), prefix, 'plugin')))
    }
    return results
  }

  /** user スコープは常に有効。project スコープは workdir がその配下のときだけ有効 */
  private isPluginActive(entry: PluginEntry, workdir: string): boolean {
    if (entry.scope !== 'project') return true
    if (!workdir || !entry.projectPath) return false
    const base = resolve(expandPath(entry.projectPath))
    return workdir === base || workdir.startsWith(base + sep)
  }
}
