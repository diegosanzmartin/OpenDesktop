/**
 * Compact line diff used for approval previews and edit summaries.
 * Not a full unified diff: it keeps three lines of context around each hunk,
 * which is what the approval card needs and no more.
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx' | 'gap'
  text: string
  oldLine?: number
  newLine?: number
}

function lcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const table = lcsTable(a, b)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i], oldLine: i + 1, newLine: j + 1 })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: 'del', text: a[i], oldLine: i + 1 })
      i++
    } else {
      out.push({ kind: 'add', text: b[j], newLine: j + 1 })
      j++
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i], oldLine: ++i })
  while (j < b.length) out.push({ kind: 'add', text: b[j], newLine: ++j })
  return out
}

export function collapseContext(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.kind === 'add' || line.kind === 'del') {
      for (let k = index - context; k <= index + context; k++) if (k >= 0 && k < lines.length) keep.add(k)
    }
  })
  const out: DiffLine[] = []
  let gapOpen = false
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      out.push(line)
      gapOpen = false
    } else if (!gapOpen) {
      out.push({ kind: 'gap', text: '⋯' })
      gapOpen = true
    }
  })
  return out
}

export function renderDiff(before: string, after: string, maxLines = 120): string {
  const collapsed = collapseContext(diffLines(before, after))
  const rendered = collapsed
    .slice(0, maxLines)
    .map((line) => {
      if (line.kind === 'gap') return '   ⋯'
      const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
      return `${sign}  ${line.text}`
    })
    .join('\n')
  const extra = collapsed.length - maxLines
  return extra > 0 ? `${rendered}\n   ⋯ ${extra} more lines` : rendered
}

export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diffLines(before, after)) {
    if (line.kind === 'add') added++
    else if (line.kind === 'del') removed++
  }
  return { added, removed }
}
