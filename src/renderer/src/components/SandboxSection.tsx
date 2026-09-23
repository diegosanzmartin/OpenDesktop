import { useEffect, useState, type ReactNode } from 'react'
import { Hammer, ShieldCheck } from 'lucide-react'
import type { SandboxStatus } from '@shared/sandbox'
import { Hint, Row, Section } from './settings-ui'
import { Button } from './ui'

/**
 * The pentesting sandbox, as one row that either offers the build or reports why
 * it cannot. Mirrors the local-model row: a single action, its cost stated
 * before it is pressed, and a live status driven by the bus rather than polling.
 *
 * What it does not do is start containers — those are per session, brought up
 * when a sandbox conversation first runs. This is only about the one shared
 * thing every sandbox session needs: the image.
 */
export function SandboxSection(): ReactNode {
  const [status, setStatus] = useState<SandboxStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.opendesktop.sandbox.status().then(setStatus)
    // The build is minutes long; its progress arrives as events, not a poll.
    return window.opendesktop.onEvent((event) => {
      if (event.type === 'sandbox.status') setStatus(event.status)
    })
  }, [])

  if (!status) return null

  const build = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.opendesktop.sandbox.build())
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title="Pentesting sandbox"
      description={
        <>
          A conversation on a Sandbox environment runs inside a throwaway Docker container: no
          access to your machine, and <strong>no network at all</strong> until you name a target
          and confirm you may test it. The container is built from an image the app makes here —
          a small Debian base with the usual security tools — and is destroyed with the
          conversation.
        </>
      }
    >
      {!status.supported ? (
        <Row label="Docker" description={status.message ?? 'Docker is required.'}>
          <span className="text-warn text-[12px]">not available</span>
        </Row>
      ) : (
        <>
          <Row
            label="Image"
            description={
              status.stage === 'building'
                ? (status.progress?.label ?? 'Building…')
                : status.imageBuilt
                  ? `${status.image} is built and ready.`
                  : status.message ?? `${status.image} is not built yet.`
            }
          >
            {status.stage === 'building' ? (
              <span className="text-info flex items-center gap-1.5 text-[12px]">
                <Hammer className="h-3.5 w-3.5 animate-pulse" />
                building…
              </span>
            ) : status.imageBuilt ? (
              <span className="text-ok flex items-center gap-1.5 text-[12px]">
                <ShieldCheck className="h-3.5 w-3.5" />
                ready
                <Button onClick={() => void build()} disabled={busy} className="ml-2">
                  Rebuild
                </Button>
              </span>
            ) : (
              <Button onClick={() => void build()} disabled={busy}>
                Build image
              </Button>
            )}
          </Row>
          {status.stage === 'failed' && status.message ? (
            <Hint>
              <span className="text-warn">{status.message}</span>
            </Hint>
          ) : null}
          <Row label="Tools" description="What the image ships, ready in every sandbox session.">
            <span className="text-ink-400 text-right text-[11.5px] leading-[1.6]">
              {status.tools.map((t) => t.name).join(' · ')}
            </span>
          </Row>
        </>
      )}
    </Section>
  )
}
