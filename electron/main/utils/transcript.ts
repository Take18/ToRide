import fs from 'fs'

// 末尾から読むときの1回の読み込み量
const CHUNK_BYTES = 256 * 1024
// 長いセッションの transcript は数十MBになる。最新の発言は末尾近くにあるので、ここまでで打ち切る
const MAX_SCAN_BYTES = 32 * 1024 * 1024

/**
 * JSONL を末尾の行から順に visit に渡す。visit が true を返したらそこで止める。
 * 改行（0x0a）はマルチバイト文字の途中に現れないので、バイト列のまま行に分けてから文字列にする
 */
export const scanLinesBackward = async (
  filePath: string,
  visit: (line: string) => boolean
): Promise<void> => {
  const fh = await fs.promises.open(filePath, 'r')
  try {
    let pos = (await fh.stat()).size
    const limit = Math.max(0, pos - MAX_SCAN_BYTES)
    let carry = Buffer.alloc(0)
    while (pos > limit) {
      const len = Math.min(CHUNK_BYTES, pos - limit)
      pos -= len
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, pos)
      const data = carry.length ? Buffer.concat([buf, carry]) : buf
      let end = data.length
      for (let i = data.length - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue
        if (i + 1 < end && visit(data.toString('utf8', i + 1, end))) return
        end = i
      }
      carry = data.subarray(0, end)
    }
    // ファイルの先頭行（打ち切った場合は行の途中なので読まない）
    if (pos === 0 && carry.length) visit(carry.toString('utf8'))
  } finally {
    await fh.close()
  }
}

export const parseJsonLine = <T>(line: string): T | null => {
  try {
    return JSON.parse(line) as T
  } catch {
    // 書き込み途中の最終行など
    return null
  }
}
