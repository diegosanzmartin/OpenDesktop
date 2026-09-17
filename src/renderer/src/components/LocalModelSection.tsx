import { useEffect, useState, type ReactNode } from 'react'
import { Download, Play, Square, Trash2 } from 'lucide-react'
import { LOCAL_MODELS, formatBytes, type LocalModelStatus } from '@shared/local-model'
import { Hint, IconButton, Row, RowSelect, Section } from './settings-ui'
import { Button } from './ui'

/**
 * The model that runs on this machine, as one row that does everything.
 *
 * Every other way of offering this ends in instructions: install Ollama, pull a
 * model, find the port, add a provider, type the model id. There is one button
 * here instead, and what it does is stated in gigabytes before it is pressed —
 * which is the only part of it a person can usefully decide.
 */
export function LocalModelSection(): ReactNode {
  const [status, setStatus] = useState<LocalModelStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState(LOCAL_MODELS[0].id)

  useEffect(() => {
    void window.opendesktop.local.status().then((next) => {
      setStatus(next)
      setChoice(next.spec.id)
    })
    // The install is minutes long and the progress cannot be polled into a bar.
    return window.opendesktop.onEvent((event) => {
      if (event.type === 'local.status') setStatus(event.status)
    })
  }, [])

  if (!status) return null

  const { stage, spec, progress } = status
  const act = async (fn: () => Promise<LocalModelStatus>): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await fn())
    } finally {
      setBusy(false)
    }
  }

  const installed = status.runtime.installed && status.model.installed
  // An interrupted download is resumed rather than repeated, so the row says
  // what is left rather than what it started as.
  const partial = status.model.partialBytes ?? 0
  const remaining = Math.max(0, spec.bytes - partial)
  const share = progress && progress.total > 0 ? progress.received / progress.total : 0

  return (
    <Section
      title="On this machine"
      description={
        <>
          A model the app runs itself — no key, no account, and nothing else to install. It is
          downloaded once, declared as a provider for you, and shut down again when nothing has
          asked for it in a quarter of an hour. Because it is already paid for, the router treats
          it as the cheapest thing there is; because it is small, it only wins the work that a
          small model can do.
        </>
      }
    >
      {!status.supported ? (
        <Row
          label={spec.name}
          description="llama.cpp publishes no build for this platform and architecture, so there is nothing the app can install here."
        >
          <Hint tone="warn">unsupported platform</Hint>
        </Row>
      ) : (
        <Row
          label={spec.name}
          description={
            stage === 'installing' && progress ? (
              <>
                {progress.what === 'model' ? 'The weights' : 'The runtime'} —{' '}
                {formatBytes(progress.received)} of {formatBytes(progress.total)}. Checked against
                the checksum this build was made against before anything runs.
              </>
            ) : stage === 'failed' ? (
              <span className="text-bad">{status.message}</span>
            ) : stage === 'running' ? (
              <>
                Answering on 127.0.0.1:{status.port}, with a {(spec.contextWindow / 1024) | 0}k
                window. About {formatBytes(spec.ramBytes)} of memory while it is loaded.
              </>
            ) : installed ? (
              <>
                {spec.blurb} Installed: {formatBytes(status.diskBytes)} on disk. It starts by itself
                the first time something is routed to it.
              </>
            ) : (
              <>
                {spec.blurb}{' '}
                {partial > 0 ? (
                  <>
                    {formatBytes(partial)} of the weights is already here from an interrupted
                    download, so {formatBytes(remaining)} is left.
                  </>
                ) : (
                  <>
                    It needs {formatBytes(spec.bytes)} of weights plus about 30 MB of runtime, and
                    around {formatBytes(spec.ramBytes)} of memory while it answers.
                  </>
                )}
              </>
            )
          }
        >
          {stage === 'installing' ? (
            <div className="flex items-center gap-2">
              <div className="bg-ink-800 h-1.5 w-[120px] overflow-hidden rounded-full">
                <div
                  className="bg-brand h-full rounded-full transition-[width] duration-300"
                  style={{ width: `${Math.round(share * 100)}%` }}
                />
              </div>
              <Hint>{Math.round(share * 100)}%</Hint>
            </div>
          ) : stage === 'starting' ? (
            <Hint>loading the weights…</Hint>
          ) : stage === 'running' ? (
            <>
              <Hint tone="ok">running</Hint>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(() => window.opendesktop.local.stop())}>
                <Square className="h-3 w-3" /> Stop
              </Button>
            </>
          ) : installed ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act(() => window.opendesktop.local.start(spec.id))}
              >
                <Play className="h-3 w-3" /> Start
              </Button>
              <IconButton
                title="Remove the model and the runtime"
                tone="danger"
                onClick={() => void act(() => window.opendesktop.local.remove(spec.id))}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </>
          ) : (
            <>
              {LOCAL_MODELS.length > 1 ? (
                <RowSelect
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                  options={LOCAL_MODELS.map((model) => ({ value: model.id, label: model.name }))}
                />
              ) : null}
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void act(() => window.opendesktop.local.install(choice))}
              >
                <Download className="h-3 w-3" />
                {partial > 0 && choice === spec.id
                  ? `Resume (${formatBytes(remaining)})`
                  : `Install (${formatBytes(LOCAL_MODELS.find((m) => m.id === choice)?.bytes ?? spec.bytes)})`}
              </Button>
            </>
          )}
        </Row>
      )}

      {installed ? (
        <Row
          label="How it is configured"
          description={
            <>
              Declared as <span className="font-mono">local/{spec.id}</span> under a provider called
              &ldquo;On this machine&rdquo;, at a flat rate of nothing. Its address is not written
              down: the server takes a free port each time it starts, and the provider is pointed at
              whichever one that is.
            </>
          }
        >
          <Hint>
            llama.cpp {status.runtime.build}
            {status.runtime.version && status.runtime.version !== status.runtime.build
              ? ` · build ${status.runtime.version}`
              : ''}
          </Hint>
        </Row>
      ) : null}
    </Section>
  )
}
