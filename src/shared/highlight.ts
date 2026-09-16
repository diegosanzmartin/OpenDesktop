/**
 * A small syntax highlighter and a guess at whether a block is a shell command.
 *
 * Hand-written rather than pulled in: a real highlighter is megabytes for a few
 * kinds of token, and everything that appears in this transcript is one of five
 * languages. It colours strings, comments, numbers, keywords and call names —
 * the distinctions that make code scannable — and deliberately stops there
 * rather than half-parsing a grammar it cannot finish.
 */

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'call'

export interface Span {
  text: string
  kind: TokenKind
}

type Family = 'python' | 'js' | 'shell' | 'json' | 'plain'

const KEYWORDS: Record<Family, Set<string>> = {
  python: new Set([
    'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or',
    'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'yield', 'lambda',
    'pass', 'break', 'continue', 'global', 'nonlocal', 'assert', 'del', 'is', 'async', 'await',
    'True', 'False', 'None', 'self'
  ]),
  js: new Set([
    'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
    'case', 'break', 'continue', 'new', 'class', 'extends', 'import', 'export', 'from', 'default',
    'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in', 'of',
    'this', 'null', 'undefined', 'true', 'false', 'interface', 'type', 'enum', 'implements',
    'public', 'private', 'protected', 'readonly', 'as', 'void', 'never', 'yield'
  ]),
  shell: new Set([
    'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'in',
    'function', 'return', 'export', 'local', 'source', 'echo', 'cd', 'set', 'unset'
  ]),
  json: new Set(['true', 'false', 'null']),
  plain: new Set()
}

export function familyOf(lang: string | undefined): Family {
  const name = (lang ?? '').toLowerCase().trim()
  if (['py', 'python', 'python3'].includes(name)) return 'python'
  if (['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'mjs', 'cjs'].includes(name)) return 'js'
  if (['sh', 'bash', 'zsh', 'shell', 'console', 'terminal', 'fish'].includes(name)) return 'shell'
  if (['json', 'jsonc'].includes(name)) return 'json'
  return 'plain'
}

/** Built per family: `#` only starts a comment where it actually does. */
function patternFor(family: Family): RegExp {
  const parts: string[] = []
  if (family === 'js') parts.push('/\\*[\\s\\S]*?\\*/', '//[^\\n]*')
  if (family === 'python' || family === 'shell') parts.push('#[^\\n]*')
  if (family === 'python') parts.push('"""[\\s\\S]*?"""', "'''[\\s\\S]*?'''")
  parts.push('"(?:\\\\.|[^"\\\\])*"', "'(?:\\\\.|[^'\\\\])*'")
  if (family === 'js') parts.push('`(?:\\\\.|[^`\\\\])*`')
  parts.push('\\b\\d[\\d_]*(?:\\.\\d+)?\\b')
  parts.push('[A-Za-z_$][\\w$]*')
  return new RegExp(parts.map((part) => `(${part})`).join('|'), 'g')
}

function kindOf(match: string, family: Family, after: string): TokenKind {
  const first = match[0]
  if (first === '#' || match.startsWith('//') || match.startsWith('/*')) return 'comment'
  if (first === '"' || first === "'" || first === '`') return 'string'
  if (first >= '0' && first <= '9') return 'number'
  if (KEYWORDS[family].has(match)) return 'keyword'
  // A name immediately followed by "(" is being called; in shell, a bare first
  // word is the command, which is the same idea.
  if (after.startsWith('(')) return 'call'
  return 'plain'
}

export function highlight(code: string, lang?: string): Span[] {
  const family = familyOf(lang)
  if (family === 'plain') return code ? [{ text: code, kind: 'plain' }] : []

  const pattern = patternFor(family)
  const spans: Span[] = []
  let last = 0

  for (const match of code.matchAll(pattern)) {
    const start = match.index ?? 0
    const text = match[0]
    if (start > last) spans.push({ text: code.slice(last, start), kind: 'plain' })

    const kind = kindOf(text, family, code.slice(start + text.length))
    // Merging runs of plain text keeps the DOM small on a long block.
    const previous = spans[spans.length - 1]
    if (kind === 'plain' && previous?.kind === 'plain') previous.text += text
    else spans.push({ text, kind })

    last = start + text.length
  }

  if (last < code.length) {
    const rest = code.slice(last)
    const previous = spans[spans.length - 1]
    if (previous?.kind === 'plain') previous.text += rest
    else spans.push({ text: rest, kind: 'plain' })
  }
  return spans
}

/* ---------------- is this something I can run? ---------------- */

const COMMANDS = new Set([
  'cd', 'ls', 'cat', 'echo', 'python', 'python3', 'pip', 'pip3', 'node', 'npm', 'pnpm', 'yarn',
  'npx', 'git', 'curl', 'wget', 'mkdir', 'rm', 'cp', 'mv', 'chmod', 'chown', 'grep', 'rg', 'sed',
  'awk', 'find', 'docker', 'kubectl', 'helm', 'terraform', 'gcloud', 'aws', 'az', 'ssh', 'scp',
  'make', 'go', 'cargo', 'java', 'ruby', 'php', 'brew', 'apt', 'yum', 'systemctl', 'tail', 'head',
  'wc', 'sort', 'uniq', 'export', 'source', 'bash', 'sh', 'zsh', 'pytest', 'jest', 'tsc', 'open',
  'touch', 'which', 'man', 'ps', 'kill', 'df', 'du', 'tar', 'unzip', 'jq', 'sudo', 'env', 'set'
])

/** Constructs that mean this is a program, not a command line. */
const NOT_A_COMMAND = /(^|\s)(def|class|function|import|from|return|const|let|var|interface)\s|=>|;\s*$|^\s*[{[]/

/**
 * Whether to offer to run a block.
 *
 * A declared shell language is taken at its word. Without one the test is
 * deliberately strict — every line has to start with something recognisable as
 * a command — because offering to run a block that is not a command is worse
 * than not offering at all.
 */
export function isShell(code: string, lang?: string): boolean {
  if (familyOf(lang) === 'shell') return true
  if (lang && lang.trim()) return false

  const lines = code.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0 || lines.length > 12) return false

  return lines.every((line) => {
    if (NOT_A_COMMAND.test(line)) return false
    const head = line.replace(/^\$\s*/, '').split(/[\s|&;]/)[0]
    return COMMANDS.has(head)
  })
}

/**
 * Bytes to write to a PTY so a block arrives as typed text rather than as a
 * series of commands.
 *
 * A newline written to a shell is the return key, so pasting two lines runs the
 * first one — "put this in the terminal without running it" did exactly the
 * thing it promised not to. Bracketed paste is how a terminal emulator solves
 * this for a real paste: the shell is told the bytes between the markers are
 * text, and it holds them at the prompt instead of executing each line.
 *
 * Only used when it is needed. A single-line command has no newline to
 * misinterpret, and a shell with the mode off would show the markers as
 * literal characters, so there is no reason to take that risk when there is
 * nothing to protect.
 */
export function terminalPayload(text: string, run: boolean): string {
  const body = text.replace(/\r\n/g, '\n').trimEnd()
  const multiline = body.includes('\n')
  const wrapped = multiline ? `\u001b[200~${body}\u001b[201~` : body
  return run ? `${wrapped}\r` : wrapped
}
