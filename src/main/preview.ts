import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { posix } from 'node:path'
import mime from 'mime'
import { getRuntime } from './runtime'

/**
 * Serves files from any environment (local or SSH) over loopback so the
 * built-in browser can render whatever the agent just generated.
 * The token makes the port useless to anything that is not this app.
 */
const token = randomBytes(16).toString('hex')
let server: Server | null = null
let port = 0

function notFound(res: import('node:http').ServerResponse, message: string): void {
  res.statusCode = 404
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(message)
}

function directoryPage(envId: string, dir: string, entries: { name: string; directory: boolean; size: number }[]): string {
  const rows = entries
    .map((e) => {
      const href = previewUrl(envId, posix.join(dir, e.name))
      const size = e.directory ? '—' : `${(e.size / 1024).toFixed(1)} KB`
      return `<tr><td><a href="${href}">${e.name}${e.directory ? '/' : ''}</a></td><td>${size}</td></tr>`
    })
    .join('')
  const parent = previewUrl(envId, posix.dirname(dir))
  return `<!doctype html><meta charset="utf-8"><title>${dir}</title>
<style>
  :root { color-scheme: dark }
  body { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; background:#191817; color:#e8e6e3; padding:24px }
  h1 { font-size:13px; font-weight:600; color:#a3a09b; margin:0 0 16px }
  a { color:#d97757; text-decoration:none } a:hover { text-decoration:underline }
  table { border-collapse:collapse; width:100% } td { padding:4px 12px 4px 0; border-bottom:1px solid #2a2826 }
  td:last-child { text-align:right; color:#6e6b66 }
</style>
<h1>${dir}</h1><table><tr><td><a href="${parent}">../</a></td><td>—</td></tr>${rows}</table>`
}

export function startPreviewServer(): Promise<number> {
  if (server) return Promise.resolve(port)
  return new Promise((resolve, reject) => {
    server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.searchParams.get('t') !== token) {
          res.statusCode = 403
          return res.end('forbidden')
        }
        const match = /^\/f\/([^/]+)(\/.*)?$/.exec(url.pathname)
        if (!match) return notFound(res, 'not found')

        const envId = decodeURIComponent(match[1])
        const target = decodeURIComponent(match[2] ?? '/')
        const runtime = getRuntime(envId)
        await runtime.connect()

        if (await runtime.isDirectory(target)) {
          const entries = await runtime.list(target)
          const index = entries.find((e) => e.name === 'index.html')
          if (index) {
            const html = await runtime.readFileBuffer(index.path)
            res.setHeader('content-type', 'text/html; charset=utf-8')
            return res.end(html)
          }
          res.setHeader('content-type', 'text/html; charset=utf-8')
          return res.end(directoryPage(envId, target, entries))
        }

        if (!(await runtime.exists(target))) return notFound(res, `${target} does not exist`)

        const buffer = await runtime.readFileBuffer(target)
        const type = mime.getType(target) ?? 'text/plain'
        // Render code and config as text rather than prompting a download.
        const isText = /^(text\/|application\/(json|javascript|xml|x-sh|toml|yaml))/.test(type)
        res.setHeader('content-type', isText ? `${type}; charset=utf-8` : type)
        res.setHeader('cache-control', 'no-store')
        return res.end(buffer)
      } catch (err) {
        res.statusCode = 500
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end((err as Error).message)
      }
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      port = typeof address === 'object' && address ? address.port : 0
      resolve(port)
    })
  })
}

export function previewUrl(environmentId: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `http://127.0.0.1:${port}/f/${encodeURIComponent(environmentId)}${encoded.startsWith('/') ? '' : '/'}${encoded}?t=${token}`
}

export function previewOrigin(): string {
  return `http://127.0.0.1:${port}`
}

export function stopPreviewServer(): void {
  server?.close()
  server = null
}
