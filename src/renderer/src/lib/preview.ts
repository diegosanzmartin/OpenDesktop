/**
 * Whether the browser pane is looking at a file or at the web.
 *
 * The preview server's URLs are `…/f/<environment>/<path>?t=<token>` on
 * loopback, so the shape is the tell. It matters because the two want
 * different furniture: a website needs an address bar, and a file already
 * knows its own name — the pane was showing the path twice, once in the bar
 * and once in the page's own header.
 */
export interface PreviewTarget {
  environmentId: string
  path: string
}

export function previewTarget(url: string): PreviewTarget | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return null
  const match = /^\/f\/([^/]+)(\/.*)?$/.exec(parsed.pathname)
  if (!match) return null
  return {
    environmentId: decodeURIComponent(match[1]),
    path: (match[2] ?? '/')
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  }
}

/** What to call the pane: the file's name, or nothing when it is the web. */
export function previewTitle(url: string): string | null {
  const target = previewTarget(url)
  if (!target) return null
  const name = target.path.replace(/\/+$/, '').split('/').pop()
  return name || target.path
}
