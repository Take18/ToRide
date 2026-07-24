import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join, extname, resolve, sep } from 'path'
import { randomUUID } from 'crypto'

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.bmp'])

export function isImagePath(path: string): boolean {
  return IMAGE_EXTS.has(extname(path).toLowerCase())
}

export function getImagesDir(): string {
  const dir = join(app.getPath('userData'), 'task-images')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// 元ファイルの削除・移動に影響されないよう task-images 配下へコピーして保存する
export function importImages(sourcePaths: string[]): string[] {
  const dir = getImagesDir()
  const stored: string[] = []
  for (const src of sourcePaths) {
    if (!isImagePath(src)) continue
    const dest = join(dir, `${randomUUID()}${extname(src).toLowerCase()}`)
    try {
      copyFileSync(src, dest)
      stored.push(dest)
    } catch (e) {
      console.error('[ImageStore] import failed:', src, e)
    }
  }
  return stored
}

// task-images 配下のファイルのみ削除を許可する
export function deleteImages(paths: string[]): void {
  const dir = resolve(getImagesDir()) + sep
  for (const p of paths) {
    const abs = resolve(p)
    if (!abs.startsWith(dir)) continue
    try {
      unlinkSync(abs)
    } catch {
      // 既に存在しない場合は無視
    }
  }
}
