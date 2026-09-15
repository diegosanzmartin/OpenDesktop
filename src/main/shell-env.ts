import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * An app launched from Finder or the Dock inherits almost nothing: macOS gives it
 * launchd's environment, not the one your shell builds from .zshrc/.zprofile. That
 * means `{env:HELMCODE_API_KEY}` resolves to nothing in a packaged build even
 * though it works fine under `pnpm dev`.
 *
 * So ask the login shell what it thinks the environment is, and merge in anything
 * we are missing. Existing variables are never overwritten — a value the process
 * already has was set deliberately (by a terminal launch, or by the OS).
 *
 * PATH is the exception. launchd always provides one, and it is the bare
 * /usr/bin:/bin:/usr/sbin:/sbin, so the never-overwrite rule would pin the whole
 * app to it: no node, no pnpm, no rg, and a gcloud that finds the system
 * Python 3.9 and refuses to run. The shell's PATH wins, with anything only
 * launchd knew about appended rather than dropped.
 */

/** Shell PATH first, then whatever launchd had that the shell did not mention. */
function mergePath(shellPath: string | null): boolean {
  if (!shellPath) return false
  const shellEntries = shellPath.split(':').filter(Boolean)
  if (shellEntries.length === 0) return false

  const seen = new Set(shellEntries)
  const extra = (process.env.PATH ?? '').split(':').filter((entry) => entry && !seen.has(entry))
  process.env.PATH = [...shellEntries, ...extra].join(':')
  return true
}

export async function loadShellEnvironment(): Promise<{ loaded: string[]; error?: string }> {
  if (process.platform === 'win32') return { loaded: [] }

  const shell = process.env.SHELL || '/bin/zsh'
  // A marker keeps the parse honest: login shells print banners, version
  // notices and whatever else the user's rc files decide to echo.
  const marker = '__opendesktop_env__'

  try {
    const { stdout } = await run(shell, ['-ilc', `printf '%s' ${marker}; env; printf '%s' ${marker}`], {
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TERM: 'dumb' }
    })

    const start = stdout.indexOf(marker)
    const end = stdout.lastIndexOf(marker)
    if (start === -1 || end <= start) return { loaded: [], error: 'could not parse the shell environment' }

    const body = stdout.slice(start + marker.length, end)
    const loaded: string[] = []

    // `env` output is NAME=value per line, but values may themselves contain
    // newlines, so only split where a line actually starts a new assignment.
    let current: string | null = null
    let buffer = ''
    let shellPath: string | null = null
    const commit = (): void => {
      if (!current) return
      if (current === 'PATH') shellPath = buffer
      else if (process.env[current] === undefined) {
        process.env[current] = buffer
        loaded.push(current)
      }
      current = null
      buffer = ''
    }

    for (const line of body.split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (match) {
        commit()
        current = match[1]
        buffer = match[2]
      } else if (current) {
        buffer += `\n${line}`
      }
    }
    commit()

    const merged = mergePath(shellPath)
    if (merged) loaded.push('PATH')

    return { loaded }
  } catch (err) {
    return { loaded: [], error: (err as Error).message }
  }
}
