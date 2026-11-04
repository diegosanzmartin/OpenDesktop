import { useState, type ReactNode } from 'react'
import type { AutoModePolicy, Rehearsal } from '@shared/types'
import { SUGGESTED_AUTO_MODE } from '@shared/auto-mode'
import { Row } from './settings-ui'

type Kind = 'environment' | 'allow' | 'deny'

const BOXES: { kind: Kind; label: string; description: string }[] = [
  {
    kind: 'environment',
    label: 'Environment',
    description: 'What this machine is and what is trusted, so the judge can tell inside from outside.'
  },
  {
    kind: 'allow',
    label: 'Allow',
    description: 'Exceptions: what is fine even when a deny rule seems to reach it.'
  },
  {
    kind: 'deny',
    label: 'Deny',
    description:
      'Refused, with the rule and the reason given to the agent, unless you asked for it in the conversation. Name each rule ("Git Push: …") so the refusal can cite it.'
  }
]

function TrialResults({ results }: { results: Rehearsal[] }): ReactNode {
  if (results.length === 0) return <p className="text-ink-500 text-[12px]">No recent calls that would have asked.</p>
  const refused = results.filter((r) => !r.allowed)
  return (
    <div className="text-[12px]">
      <p className="text-ink-300">
        Would refuse {refused.length} of {results.length} recent calls.
      </p>
      <ul className="mt-1 space-y-1">
        {refused.map((r, i) => (
          <li key={i} className="text-ink-400">
            <span className="text-ink-200 font-mono">{r.action}</span>
            {r.unanswered
              ? ` — ${r.reason ?? 'no answer from the judge; you would be asked'}`
              : ` — ${r.rule ?? 'a deny rule'}: ${r.reason ?? ''}`}
            {r.title ? <span className="text-ink-600"> ({r.title})</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * The auto-approve rules, in prose, one per line — the way Claude Code's auto
 * mode is configured. Easier to add to than the denylist, and judged by a model
 * rather than matched, so less certain: the denylist still comes first.
 */
export function AutoModeRules({
  policy,
  onSave
}: {
  policy: AutoModePolicy | undefined
  onSave: (next: AutoModePolicy) => void
}): ReactNode {
  const current: AutoModePolicy = policy ?? { environment: [], allow: [], deny: [] }
  const [drafts, setDrafts] = useState<Partial<Record<Kind, string>>>({})
  const [trial, setTrial] = useState<Rehearsal[] | 'running' | null>(null)
  const empty = current.environment.length + current.allow.length + current.deny.length === 0
  // What is in the boxes now, saved or not: trying a rule before keeping it is the point.
  const asWritten = (): AutoModePolicy => ({
    ...current,
    environment: drafts.environment === undefined ? current.environment : lines(drafts.environment),
    allow: drafts.allow === undefined ? current.allow : lines(drafts.allow),
    deny: drafts.deny === undefined ? current.deny : lines(drafts.deny)
  })

  return (
    <>
      {BOXES.map((box) => (
        <Row key={box.kind} align="start" label={box.label} description={box.description}>
          <textarea
            aria-label={box.label}
            spellCheck={false}
            rows={Math.max(3, Math.min(10, current[box.kind].length + 1))}
            value={drafts[box.kind] ?? current[box.kind].join('\n')}
            onChange={(event) => setDrafts({ ...drafts, [box.kind]: event.target.value })}
            onBlur={() => {
              const draft = drafts[box.kind]
              if (draft === undefined) return
              setDrafts({ ...drafts, [box.kind]: undefined })
              onSave({ ...current, [box.kind]: lines(draft) })
            }}
            className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-h-[64px] w-[420px] resize-y rounded-lg border px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.5] outline-none"
          />
        </Row>
      ))}
      {!empty ? (
        <Row
          align="start"
          label="Try them first"
          description="Judges the most recent calls that would have asked you, with what you asked in each conversation, and shows what these rules would refuse. Nothing is run, and the live judge is left alone."
        >
          <div className="flex w-[420px] flex-col gap-1.5">
            <button
              type="button"
              disabled={trial === 'running'}
              onClick={() => {
                setTrial('running')
                void window.opendesktop.policy.rehearse(asWritten()).then((results) => setTrial(results ?? []))
              }}
              className="border-ink-700 text-ink-200 hover:bg-ink-800 self-start rounded-lg border px-2.5 py-1.5 text-[12.5px] disabled:opacity-50"
            >
              {trial === 'running' ? 'Judging recent calls…' : 'Try these rules on recent calls'}
            </button>
            {Array.isArray(trial) ? <TrialResults results={trial} /> : null}
          </div>
        </Row>
      ) : null}
      {empty ? (
        <Row label="No rules yet" description="Without allow or deny rules, auto-approve lifts every prompt.">
          <button
            type="button"
            onClick={() => onSave({ ...SUGGESTED_AUTO_MODE, ...(policy?.model ? { model: policy.model } : {}) })}
            className="border-ink-700 text-ink-200 hover:bg-ink-800 rounded-lg border px-2.5 py-1.5 text-[12.5px]"
          >
            Use the suggested rules
          </button>
        </Row>
      ) : null}
    </>
  )
}
