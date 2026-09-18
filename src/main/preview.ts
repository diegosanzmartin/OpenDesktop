import { createServer, type Server } from 'node:http'
import { marked } from 'marked'
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

/** Types a browser shows without being asked to download them. */
const RENDERS_INLINE = /^(text\/html|image\/|video\/|audio\/|application\/pdf|image\/svg)/

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096)
  for (const byte of sample) {
    // A NUL byte is the reliable tell; control characters alone are not.
    if (byte === 0) return true
  }
  return false
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const PAGE_STYLE = `
  :root { color-scheme: dark }
  body { margin:0; background:#1a1918; color:#cfccc6;
         font:12.5px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace }
  /* No header rule: nothing has one. A page about one file is titled by the
     pane showing it, and a directory listing carries its own path as an h1,
     which is the place you are in rather than a label for a file. */
  pre { margin:0; padding:14px 16px; white-space:pre-wrap; word-break:break-word }
  .empty { padding:24px 16px; color:#6b6862 }
`

/**
 * A markdown document, rendered.
 *
 * Shown as source it is a wall of pipes and hashes — which is the one thing a
 * report asked for in markdown should not be. The same lexer the transcript
 * uses turns it into a page; the HTML it produces is the model's own text, so
 * it is sanitised the only way that is actually safe here: tags are escaped
 * before the lexer ever sees them, so nothing it emits can be markup the
 * document invented.
 */
function markdownPage(path: string, body: string): string {
  const html = marked.parse(escapeHtml(body), { async: false, gfm: true, breaks: false })
  /*
   * No path across the top.
   *
   * It was there because the pane that shows this used to be titled "Browser",
   * so the page had to say which file it was. The pane is titled with the
   * file's name now, and the address bar is gone for a file, so a header here
   * is the same string a second time above a document that usually opens with
   * its own heading. The title stays: that is what the window and the history
   * read.
   */
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(path)}</title>
<style>${PAGE_STYLE}${PROSE_STYLE}</style>
<article>${html}</article>`
}

function sourcePage(path: string, body: string): string {
  // Same reasoning as the markdown page: the pane names the file.
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(path)}</title>
<style>${PAGE_STYLE}</style>
${body.trim() ? `<pre>${escapeHtml(body)}</pre>` : '<div class="empty">(empty file)</div>'}`
}

const PROSE_STYLE = `
  article { max-width:78ch; margin:0 auto; padding:22px 20px 60px;
            font:14px/1.7 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            color:#cfccc6 }
  article h1 { font-size:24px; margin:1.2em 0 .5em; color:#ecebe8 }
  article h2 { font-size:19px; margin:1.4em 0 .4em; color:#ecebe8 }
  article h3 { font-size:16px; margin:1.3em 0 .3em; color:#ecebe8 }
  article p, article li { margin:.5em 0 }
  article code { font-family:var(--mono, ui-monospace, Menlo, monospace); font-size:.88em;
                 background:rgba(255,255,255,.06); border-radius:4px; padding:.1em .35em }
  article pre { background:#131211; border:1px solid #262523; border-radius:8px;
                padding:12px 14px; overflow:auto; margin:.8em 0 }
  article pre code { background:none; padding:0 }
  article table { border-collapse:collapse; margin:.9em 0; font-size:13px; display:block;
                  overflow-x:auto }
  article th, article td { border:1px solid #2f2d2b; padding:6px 10px; text-align:left }
  article th { background:#1f1e1d; color:#ecebe8 }
  article blockquote { margin:.8em 0; padding:.1em 0 .1em 14px; border-left:2px solid #3d3a37;
                       color:#8d8a84 }
  article a { color:#d97757 }
  article hr { border:none; border-top:1px solid #2f2d2b; margin:1.6em 0 }
`

function binaryPage(path: string, size: number): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(path)}</title>
<style>${PAGE_STYLE}</style>
<div class="empty">Binary file, ${(size / 1024).toFixed(1)} KB — nothing to display.</div>`
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
        res.setHeader('cache-control', 'no-store')

        // Chromium only renders a handful of types inline; everything else it
        // tries to download, which inside a webview just shows a blank page.
        // So anything that is really text gets wrapped in a readable page.
        if (RENDERS_INLINE.test(type)) {
          res.setHeader('content-type', type)
          return res.end(buffer)
        }
        if (looksBinary(buffer)) {
          res.setHeader('content-type', 'text/html; charset=utf-8')
          return res.end(binaryPage(target, buffer.length))
        }
        res.setHeader('content-type', 'text/html; charset=utf-8')
        if (/\.(md|markdown)$/i.test(target)) {
          return res.end(markdownPage(target, buffer.toString('utf8')))
        }
        return res.end(sourcePage(target, buffer.toString('utf8')))
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
