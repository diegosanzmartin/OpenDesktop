import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Activity, ShieldAlert, ShieldCheck, X } from 'lucide-react'
import type { Session } from '@shared/types'
import { isValidTarget, normaliseTargets, type ForensicReport } from '@shared/sandbox'
import { useStore } from '../state/store'

/**
 * The flight recorder, said in one line: that it is watching, and the worst
 * thing it has seen so far. The recording is always on while the container is
 * up; this makes that visible without spending a turn on the forensic agent,
 * and the agent is still what writes the actual report.
 */
export function ForensicLine({ session }: { session: Session }): ReactNode {
  const [report, setReport] = useState<ForensicReport | null>(null)

  useEffect(() => {
    let alive = true
    const pull = (): void => {
      void window.opendesktop.sandbox
        .forensics(session.id)
        .then((r) => alive && setReport(r))
        .catch(() => undefined)
    }
    pull()
    const timer = setInterval(pull, 15_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [session.id])

  if (!report || report.samples === 0) return null

  const worst = report.findings.reduce<'info' | 'warn' | 'alert'>(
    (acc, f) => (f.severity === 'alert' ? 'alert' : f.severity === 'warn' && acc !== 'alert' ? 'warn' : acc),
    'info'
  )
  const headline =
    worst === 'alert'
      ? (report.findings.find((f) => f.severity === 'alert')?.what ?? 'A breach signal was recorded.')
      : worst === 'warn'
        ? (report.findings.find((f) => f.severity === 'warn')?.what ?? 'Something worth a look was recorded.')
        : 'Watching — nothing anomalous so far.'

  const tone =
    worst === 'alert'
      ? 'border-bad/30 bg-bad/5 text-bad'
      : worst === 'warn'
        ? 'border-warn/30 bg-warn/5 text-warn'
        : 'border-ink-800 bg-ink-850 text-ink-500'

  return (
    <div className={clsx('mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5', tone)}>
      <Activity className={clsx('h-3.5 w-3.5 shrink-0', worst === 'info' && 'text-ink-500')} />
      <span className="text-ink-300 min-w-0 flex-1 truncate text-[12px]">{headline}</span>
      <span className="text-ink-600 shrink-0 text-[11px]">forensics · {report.samples} samples</span>
    </div>
  )
}

/**
 * The hard gate, above the composer, on a sandbox session.
 *
 * The container is offline until this is answered: the person names the target
 * and states, in writing, that they are authorised to test it. Only then does
 * the app open egress — to exactly that target and nothing else. This is not a
 * form for convenience; it is the authorisation record, and it is the only way
 * a sandbox session gets any network at all.
 */
export function ScopeGate({ session }: { session: Session }): ReactNode {
  const pushToast = useStore((s) => s.pushToast)
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const scope = session.sandbox
  const authorised = scope && scope.targets.length > 0

  const submit = async (): Promise<void> => {
    const list = targets.split(/[\s,]+/).filter(Boolean)
    const clean = normaliseTargets(list)
    if (clean.length === 0) {
      pushToast('warn', 'Give a hostname, an IPv4 address or a CIDR as the target.')
      return
    }
    if (!note.trim()) {
      pushToast('warn', 'Confirm, in writing, that you are authorised to test these targets.')
      return
    }
    setBusy(true)
    try {
      const result = await window.opendesktop.sandbox.openScope(session.id, clean, note.trim())
      if (result.error) {
        pushToast('warn', result.error)
        return
      }
      setOpen(false)
      setTargets('')
      setNote('')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (): Promise<void> => {
    setBusy(true)
    try {
      await window.opendesktop.sandbox.clearScope(session.id)
    } finally {
      setBusy(false)
    }
  }

  if (authorised) {
    return (
      <div className="border-ok/30 bg-ok/5 mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5">
        <ShieldCheck className="text-ok h-3.5 w-3.5 shrink-0" />
        <span className="text-ink-200 min-w-0 flex-1 truncate text-[12px]">
          Authorised to reach{' '}
          <span className="font-mono">{scope!.targets.join(', ')}</span> — everything else is dropped.
        </span>
        <button
          type="button"
          onClick={() => void revoke()}
          disabled={busy}
          title="Go back offline and clear the authorisation"
          className="text-ink-500 hover:text-ink-200 shrink-0 text-[11.5px]"
        >
          Go offline
        </button>
      </div>
    )
  }

  return (
    <div className="border-warn/30 bg-warn/5 mb-2 rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <ShieldAlert className="text-warn h-3.5 w-3.5 shrink-0" />
        <span className="text-ink-200 min-w-0 flex-1 text-[12px]">
          Offline sandbox — no network until you authorise a target
        </span>
        <span className="text-ink-600 shrink-0 text-[11px]">{open ? '▲' : 'Authorise ▾'}</span>
      </button>

      {open ? (
        <div className="border-warn/20 space-y-2 border-t px-3 py-2.5">
          <label className="block">
            <span className="text-ink-400 text-[11.5px]">Target — host, IP or CIDR (space or comma separated)</span>
            <input
              value={targets}
              onChange={(e) => setTargets(e.target.value)}
              placeholder="scanme.example.com  10.0.0.0/24"
              className={clsx(
                'border-ink-700 bg-ink-900 mt-1 w-full rounded-md border px-2 py-1 font-mono text-[12px] outline-none',
                'focus:border-ink-500'
              )}
            />
            {targets.trim() && targets.split(/[\s,]+/).filter(Boolean).some((t) => !isValidTarget(t)) ? (
              <span className="text-warn mt-1 block text-[11px]">
                Some of those are not a valid host, IP or CIDR and will be ignored.
              </span>
            ) : null}
          </label>
          <label className="block">
            <span className="text-ink-400 text-[11.5px]">
              Authorisation — say you may test these (kept with the session and the report)
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="I am authorised to test these targets — engagement / owner / ticket."
              className="border-ink-700 bg-ink-900 mt-1 w-full resize-none rounded-md border px-2 py-1 text-[12px] outline-none focus:border-ink-500"
            />
          </label>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-ink-500 hover:text-ink-200 flex items-center gap-1 text-[11.5px]"
            >
              <X className="h-3 w-3" /> Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy}
              className="bg-warn/20 text-warn hover:bg-warn/30 rounded px-2.5 py-[3px] text-[11.5px] disabled:opacity-50"
            >
              Open egress to target
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
