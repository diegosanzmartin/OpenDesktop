import { useState, type ReactNode } from 'react'
import { Row } from './settings-ui'

/**
 * The person's standing instructions, re-read by the model on every step.
 *
 * Rules that only lived in the system prompt were forgotten in long turns
 * (DeepSeek narrated in English and retried refused calls another way); these
 * are put at the end of what the model reads each time, as Goose does.
 */
export function PinnedInstructions({
  value,
  onSave
}: {
  value: string | undefined
  onSave: (next: string | undefined) => void
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Row
      align="start"
      label="Pinned instructions"
      description="Read by the model on every step of every turn, after everything else, so a long turn does not drift from them. Keep them short: they are paid for on each step."
    >
      <textarea
        aria-label="Pinned instructions"
        spellCheck={false}
        placeholder="Answer in Spanish. If a call is refused, do not try it another way."
        value={draft ?? value ?? ''}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft === null) return
          setDraft(null)
          onSave(draft.trim() || undefined)
        }}
        className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-h-[64px] w-[420px] resize-y rounded-lg border px-2.5 py-1.5 text-[12px] leading-[1.5] outline-none"
      />
    </Row>
  )
}
