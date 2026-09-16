/**
 * Subsequence matching, ranked the way fzf ranks it.
 *
 * The rule is that every character of the query appears in the candidate, in
 * order, not necessarily together — `hgsj` finds
 * `acme--global--core~identity`. That alone matches far too much, so the score
 * is what makes it useful, and the score is mostly about *where* the characters
 * landed: together beats scattered, the start of a word beats the middle of
 * one, and the last segment of a path beats its parents, because that is the
 * part someone is thinking of when they type.
 *
 * Deliberately not a library. The behaviour has to be predictable enough to
 * test, and the whole of it is below.
 */

export interface Match {
  value: string
  score: number
  /** Indices in `value` that the query matched, for highlighting. */
  positions: number[]
}

const START_BONUS = 12
const CONSECUTIVE_BONUS = 10
const WORD_START_BONUS = 8
const CASE_BONUS = 2
const LEAF_BONUS = 6
const GAP_PENALTY = 1
const LEADING_GAP_PENALTY = 2

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1]
  return (
    previous === '/' ||
    previous === '-' ||
    previous === '_' ||
    previous === '.' ||
    previous === '~' ||
    previous === ' ' ||
    (previous === previous.toLowerCase() && text[index] === text[index].toUpperCase())
  )
}

/**
 * Scores one candidate, or null when the query is not a subsequence of it.
 *
 * Greedy from the left, then each matched character is pulled as far right as
 * it can go while staying before the next one. Greedy alone scores
 * `src/main/store.ts` for `store` on the `s` of `src`, which is not what anyone
 * meant; the second pass is what makes the run of five letters in `store` find
 * each other.
 */
export function fuzzyMatch(candidate: string, query: string): Match | null {
  if (!query) return { value: candidate, score: 0, positions: [] }

  const lowerCandidate = candidate.toLowerCase()
  const lowerQuery = query.toLowerCase()

  const positions: number[] = []
  let at = 0
  for (const character of lowerQuery) {
    const found = lowerCandidate.indexOf(character, at)
    if (found === -1) return null
    positions.push(found)
    at = found + 1
  }

  // Pull right: the last character stays put, and each earlier one moves as
  // close to its successor as the candidate allows.
  for (let i = positions.length - 2; i >= 0; i--) {
    const target = lowerQuery[i]
    let best = positions[i]
    for (let candidateIndex = positions[i + 1] - 1; candidateIndex > positions[i]; candidateIndex--) {
      if (lowerCandidate[candidateIndex] === target) {
        best = candidateIndex
        break
      }
    }
    positions[i] = best
  }

  const leafStart = candidate.lastIndexOf('/') + 1
  let score = 0

  positions.forEach((index, i) => {
    if (i === 0) {
      score += index === 0 ? START_BONUS : 0
      score -= Math.min(index, 20) * LEADING_GAP_PENALTY * 0.1
    } else {
      const gap = index - positions[i - 1] - 1
      if (gap === 0) score += CONSECUTIVE_BONUS
      else score -= Math.min(gap, 10) * GAP_PENALTY
    }
    if (isBoundary(candidate, index)) score += WORD_START_BONUS
    if (candidate[index] === query[i]) score += CASE_BONUS
    if (index >= leafStart) score += LEAF_BONUS
  })

  // Among candidates that matched equally well, the shorter one is the one
  // meant: `src/main` over `src/main/agent/runner.ts` for `main`.
  score -= candidate.length * 0.05
  // And the shallower one, for the same reason.
  score -= (candidate.split('/').length - 1) * 0.5

  return { value: candidate, score, positions }
}

/** Every candidate the query matches, best first. */
export function fuzzyFilter(candidates: string[], query: string, limit = 200): Match[] {
  const trimmed = query.trim()
  if (!trimmed) {
    return candidates.slice(0, limit).map((value) => ({ value, score: 0, positions: [] }))
  }

  const matches: Match[] = []
  for (const candidate of candidates) {
    const match = fuzzyMatch(candidate, trimmed)
    if (match) matches.push(match)
  }
  // A stable order: equal scores resolve alphabetically rather than by
  // whatever order the filesystem happened to hand them over in.
  matches.sort((a, b) => b.score - a.score || a.value.localeCompare(b.value))
  return matches.slice(0, limit)
}

/**
 * Splits a string into matched and unmatched runs, for rendering.
 *
 * Runs rather than characters: one span per stretch keeps the markup small,
 * and a highlighted letter next to a highlighted letter should look like one
 * highlight and not two.
 */
export function highlightRuns(
  value: string,
  positions: number[]
): { text: string; hit: boolean }[] {
  if (positions.length === 0) return value ? [{ text: value, hit: false }] : []
  const hits = new Set(positions)
  const runs: { text: string; hit: boolean }[] = []
  for (let i = 0; i < value.length; i++) {
    const hit = hits.has(i)
    const last = runs[runs.length - 1]
    if (last && last.hit === hit) last.text += value[i]
    else runs.push({ text: value[i], hit })
  }
  return runs
}
