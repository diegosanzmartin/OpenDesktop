/**
 * Walking a directory tree that is not on this machine.
 *
 * The folder picker needs two things from a target, and they want opposite
 * treatment. Listing one directory is cheap and must be immediate, so it is
 * one call per step. Searching for a directory by name is the opposite: over
 * SSH, asking per keystroke would be unusable, so the whole candidate list is
 * fetched once, cached, and filtered locally — the matching is in
 * `@shared/fuzzy`, which never touches the network.
 */
import { shellQuote, type Runtime } from './runtime'

/**
 * How deep the search looks. Six is enough for `~/w/<client>/<repo>/<module>`
 * and stops well short of the depths where a node_modules that escaped the
 * prune list would make the answer arrive minutes late.
 */
export const SEARCH_DEPTH = 6

/** As many candidates as the picker will hold. Past this, typing is the answer. */
export const SEARCH_LIMIT = 20_000

/** Directories nobody is looking for, which are also the ones with the most of them. */
const PRUNED = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.terraform',
  '.mypy_cache',
  '.pytest_cache',
  'Library',
  '.Trash'
]

export interface Browsed {
  /** Where this listing is of, resolved: `~`, `..` and relative paths are gone. */
  path: string
  /** The home directory of the target, for the breadcrumb's house icon. */
  home: string
  /** The parent, or null at the root. */
  parent: string | null
  /** Subdirectory names, sorted, dotfiles last. */
  dirs: string[]
  /** Set when the path asked for could not be listed; `path` is then the fallback. */
  error?: string
}

/** POSIX path normalisation, done here because the path is the target's, not ours. */
export function normalizePath(path: string, home: string, base: string): string {
  let working = path.trim()
  if (!working) return base
  if (working === '~') working = home
  else if (working.startsWith('~/')) working = `${home}/${working.slice(2)}`
  else if (!working.startsWith('/')) working = `${base}/${working}`

  const parts: string[] = []
  for (const segment of working.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `/${parts.join('/')}`
}

/** One directory, listed. Falls back to home when the path is not one. */
export async function browse(runtime: Runtime, path: string): Promise<Browsed> {
  await runtime.connect()
  const home = (await runtime.homeDir()) || '/'
  const target = normalizePath(path, home, home)

  const shape = (at: string, dirs: string[], error?: string): Browsed => ({
    path: at,
    home,
    parent: at === '/' ? null : normalizePath('..', home, at),
    dirs,
    error
  })

  try {
    if (!(await runtime.isDirectory(target))) {
      return shape(home, await dirsIn(runtime, home), `${target} is not a directory`)
    }
    return shape(target, await dirsIn(runtime, target))
  } catch (err) {
    // A directory that exists but cannot be read is worth saying out loud;
    // falling back silently would look like an empty folder.
    try {
      return shape(home, await dirsIn(runtime, home), (err as Error).message)
    } catch {
      return shape(target, [], (err as Error).message)
    }
  }
}

async function dirsIn(runtime: Runtime, path: string): Promise<string[]> {
  const entries = await runtime.list(path)
  return entries
    .filter((entry) => entry.directory)
    .map((entry) => entry.name)
    .sort((a, b) => {
      const hiddenA = a.startsWith('.')
      const hiddenB = b.startsWith('.')
      if (hiddenA !== hiddenB) return hiddenA ? 1 : -1
      return a.localeCompare(b)
    })
}

export interface DirIndex {
  root: string
  /** Absolute paths, root included, in whatever order the target produced. */
  dirs: string[]
  truncated: boolean
  /** When it was built, so the picker can say how stale it is. */
  builtAt: number
  error?: string
}

const indexes = new Map<string, DirIndex>()

function key(environmentId: string, root: string): string {
  return `${environmentId}:${root}`
}

export function forgetDirIndex(environmentId?: string): void {
  if (!environmentId) {
    indexes.clear()
    return
  }
  for (const existing of [...indexes.keys()]) {
    if (existing.startsWith(`${environmentId}:`)) indexes.delete(existing)
  }
}

/**
 * Every directory under a root, for the quick search.
 *
 * Built by one command on the target and then cached: the second keystroke
 * must not cost a round trip. `fd` when it is there, `find` when it is not —
 * the same choice the grep tool makes, and for the same reason.
 *
 * The cache is not given a lifetime. A directory tree does change, but not
 * while someone is typing into a box, and a picker that silently refetched
 * would be slow at unpredictable moments; there is a refresh instead.
 */
export async function dirIndex(
  environmentId: string,
  runtime: Runtime,
  root: string,
  refresh = false
): Promise<DirIndex> {
  const cached = indexes.get(key(environmentId, root))
  if (cached && !refresh) return cached

  await runtime.connect()
  const quoted = shellQuote(root)
  const fdPrune = PRUNED.flatMap((name) => ['--exclude', shellQuote(name)]).join(' ')
  const findPrune = PRUNED.map((name) => `-name ${shellQuote(name)}`).join(' -o ')

  const command =
    `if command -v fd >/dev/null 2>&1; then ` +
    `fd --type d --max-depth ${SEARCH_DEPTH} ${fdPrune} --absolute-path . ${quoted} 2>/dev/null | head -n ${SEARCH_LIMIT}; ` +
    `else ` +
    `find ${quoted} -maxdepth ${SEARCH_DEPTH} -type d \\( ${findPrune} \\) -prune -o -type d -print 2>/dev/null | head -n ${SEARCH_LIMIT}; ` +
    `fi`

  const built: DirIndex = { root, dirs: [], truncated: false, builtAt: Date.now() }
  try {
    const res = await runtime.exec(command, { cwd: root, timeoutMs: 120_000, maxBytes: 8_000_000 })
    const lines = res.stdout
      .split('\n')
      .map((line) => line.replace(/\/+$/, '').trim())
      .filter(Boolean)
    built.dirs = [...new Set(lines)]
    built.truncated = built.dirs.length >= SEARCH_LIMIT || res.truncated
    if (built.dirs.length === 0 && res.stderr.trim()) built.error = res.stderr.trim()
  } catch (err) {
    built.error = (err as Error).message
  }

  indexes.set(key(environmentId, root), built)
  return built
}

/**
 * Where a search should start from.
 *
 * Home, because that is where a person's work lives and a sibling of the
 * current directory is the commonest thing to be looking for. Unless the
 * current directory is somewhere else entirely, in which case searching from
 * home would not find it.
 */
export function searchRoot(cwd: string, home: string): string {
  if (!home || home === '/') return cwd || '/'
  return cwd === home || cwd.startsWith(`${home}/`) ? home : cwd || home
}
