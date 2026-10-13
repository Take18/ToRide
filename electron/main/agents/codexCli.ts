import { execFile } from 'child_process'

// GUI から起動した Electron の PATH には asdf / nvm などのシムが入っていない。
// PTY ではログインシェルが PATH を通すので、起動前チェックも同じ PATH で codex を探す
let loginShellPath: Promise<string> | null = null

const PATH_MARKER = '__TORIDE_PATH__'

function resolveLoginShellPath(): Promise<string> {
  if (loginShellPath) return loginShellPath
  const shell = process.env.SHELL || '/bin/bash'
  loginShellPath = new Promise((resolve) => {
    // rc ファイルが何か出力しても拾えるよう、マーカーで挟んで取り出す
    execFile(
      shell,
      ['-ilc', `printf '${PATH_MARKER}%s${PATH_MARKER}' "$PATH"`],
      { timeout: 10_000 },
      (err, stdout) => {
        const match = stdout?.match(new RegExp(`${PATH_MARKER}(.*)${PATH_MARKER}`))
        if (err || !match) {
          // 失敗は覚えずに次回また試す（一時的な失敗で以後ずっと見つからなくなるのを防ぐ）
          loginShellPath = null
          resolve(process.env.PATH ?? '')
          return
        }
        resolve(match[1])
      }
    )
  })
  return loginShellPath
}

export type CodexRunResult =
  | { ok: true; stdout: string }
  | { ok: false; notFound: boolean; stdout: string; message: string }

/** codex をログインシェルと同じ PATH で実行する。終了コードが 0 以外でも stdout は返す */
export async function runCodex(args: string[], timeoutMs: number): Promise<CodexRunResult> {
  const PATH = await resolveLoginShellPath()
  return new Promise((resolve) => {
    execFile(
      'codex',
      args,
      { env: { ...process.env, PATH }, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, stdout })
          return
        }
        const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT'
        resolve({ ok: false, notFound, stdout: stdout ?? '', message: (stderr || err.message).trim() })
      }
    )
  })
}

/** 前後に余計な出力が混ざっても JSON 部分だけ取り出す */
export function parseJsonOutput<T>(stdout: string): T | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as T
  } catch {
    return null
  }
}
