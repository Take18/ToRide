import http from 'http'
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { parse as parseUrl } from 'url'

const PORT_FILE_DIR = path.join(homedir(), '.toride')
const PORT_FILE = path.join(PORT_FILE_DIR, 'port')

type RouteHandler = (body: string, res: http.ServerResponse) => void
type RawHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void

export class LocalHttpServer {
  private server: http.Server | null = null
  private port = 0
  private routes = new Map<string, RouteHandler>()
  private rawRoutes = new Map<string, RawHandler>()

  addRoute(routePath: string, handler: RouteHandler): void {
    this.routes.set(routePath, handler)
  }

  addRawRoute(routePath: string, handler: RawHandler): void {
    this.rawRoutes.set(routePath, handler)
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const pathname = parseUrl(req.url ?? '').pathname ?? ''

        // rawRoutes: any method, full req/res access
        const rawHandler = this.rawRoutes.get(pathname)
        if (rawHandler) {
          rawHandler(req, res)
          return
        }

        if (req.method !== 'POST') {
          res.writeHead(404)
          res.end('not found')
          return
        }
        const handler = this.routes.get(pathname)
        if (!handler) {
          res.writeHead(404)
          res.end('not found')
          return
        }
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            handler(body, res)
          } catch {
            res.writeHead(500)
            res.end('internal error')
          }
        })
      })

      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server?.address()
        if (!addr || typeof addr === 'string') {
          reject(new Error('Failed to get server address'))
          return
        }
        this.port = addr.port
        try {
          fs.mkdirSync(PORT_FILE_DIR, { recursive: true })
          fs.writeFileSync(PORT_FILE, String(this.port), 'utf-8')
          console.log(`[LocalHttpServer] listening on port ${this.port}`)
          resolve()
        } catch (e) {
          reject(e)
        }
      })

      this.server.on('error', reject)
    })
  }

  getPort(): number {
    return this.port
  }

  stop(): void {
    this.server?.close()
    this.server = null

    // ポートファイルはインスタンス間で共有される1本しかないため、
    // 別プロファイルで並走しているインスタンスが書いたものを消さないよう、
    // 中身が自分のポートと一致するときだけ削除する。
    // （無条件に消すと、2号機を閉じただけで稼働中インスタンスの
    //   stop.sh / statusline.sh が参照先を失い、通知が黙って止まる）
    const ownedPort = this.port
    this.port = 0
    if (!ownedPort) return
    try {
      if (!fs.existsSync(PORT_FILE)) return
      const written = fs.readFileSync(PORT_FILE, 'utf-8').trim()
      if (written !== String(ownedPort)) {
        console.log(
          `[LocalHttpServer] port file holds ${written} (not mine: ${ownedPort}) - left as is`
        )
        return
      }
      fs.unlinkSync(PORT_FILE)
    } catch {
      // ignore
    }
  }
}
