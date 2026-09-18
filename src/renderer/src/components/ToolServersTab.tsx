import { useEffect, useState, type ReactNode } from 'react'
import { Check, Plug, Plus, Trash2 } from 'lucide-react'
import type { McpServerConfig, McpStatus } from '@shared/types'
import { tokens } from '../lib/format'
import { Hint, IconButton, Row, RowInput, RowSelect, Section } from './settings-ui'
import { Button } from './ui'
import { useConfigDraft } from '../lib/settings'

/**
 * Tool servers, and what each one costs to have on the table.
 *
 * A server is a program that offers the agent tools this app did not write.
 * The interesting number is not what it can do, it is what it weighs: every
 * tool is a schema resent in the prefix of every step of every turn, and a
 * schema that changes throws away the provider's cache of everything in front
 * of it. One desktop client's list comes to 130 tools and 57,800 tokens —
 * four times this app's entire prompt.
 *
 * So this page declares them and measures them, and nothing here is switched
 * on for anybody: a session picks the servers it wants from the line under its
 * composer. What is not picked is not started and not paid for.
 */
export function ToolServersTab(): ReactNode {
  const { draft, setDraft, saved, error, setError } = useConfigDraft()
  const [status, setStatus] = useState<Record<string, McpStatus>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState<McpServerConfig | null>(null)

  const refresh = (): void => {
    void window.opendesktop.mcp.list().then((all) => {
      setStatus(Object.fromEntries((all ?? []).map((entry) => [entry.id, entry])))
    })
  }
  useEffect(refresh, [])

  if (!draft) return null

  const servers = Object.values(draft.mcp ?? {})

  const connect = async (id: string): Promise<void> => {
    setBusy(id)
    const next = await window.opendesktop.mcp.connect(id)
    if (next) setStatus((current) => ({ ...current, [id]: next }))
    setBusy(null)
  }

  const remove = (id: string): void => {
    const rest = { ...(draft.mcp ?? {}) }
    delete rest[id]
    setDraft({ ...draft, mcp: rest })
  }

  const commit = (): void => {
    if (!adding) return
    const id = adding.id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (!id) return setError('The id is required.')
    if (draft.mcp?.[id]) return setError(`"${id}" already exists.`)
    if (!adding.command.trim()) return setError('The command is required.')
    setDraft({
      ...draft,
      mcp: { ...(draft.mcp ?? {}), [id]: { ...adding, id, name: adding.name || id } }
    })
    setAdding(null)
    setError(null)
  }

  return (
    <>
      <Section
        title="Tool servers"
        description={
          <>
            A server offers the agent tools this app did not write. None of them is on for
            anybody: a session picks the ones it wants from the line under its composer, because
            every tool is a schema resent on every step — ask one what it offers and this page
            tells you what that costs.
          </>
        }
        action={
          error ? <Hint tone="bad">{error}</Hint> : saved ? <Hint tone="ok">Saved</Hint> : null
        }
      >
        {servers.length === 0 && !adding ? (
          <Row label={<Hint>None declared.</Hint>}>
            <Button size="sm" variant="outline" onClick={() => setAdding({ id: '', name: '', command: '', args: [] })}>
              <Plus className="h-3 w-3" /> Add one
            </Button>
          </Row>
        ) : null}

        {servers.map((server) => {
          const state = status[server.id]
          return (
            <Row
              key={server.id}
              label={server.name || server.id}
              description={
                state?.state === 'ready' ? (
                  <>
                    {state.tools.length} tool{state.tools.length === 1 ? '' : 's'} ·{' '}
                    <span className="text-warn">{tokens(state.tokens)} tokens</span> on every step ·{' '}
                    <span className="font-mono text-[11px]">
                      {server.command} {(server.args ?? []).join(' ')}
                    </span>
                  </>
                ) : state?.state === 'failed' ? (
                  <span className="text-bad">{state.message?.split('\n')[0]}</span>
                ) : (
                  <span className="font-mono text-[11px]">
                    {server.command} {(server.args ?? []).join(' ')}
                  </span>
                )
              }
            >
              {state?.state === 'ready' ? <Hint tone="ok">ready</Hint> : null}
              <Button
                size="sm"
                variant="outline"
                disabled={busy === server.id}
                onClick={() => void connect(server.id)}
              >
                <Plug className="h-3 w-3" />
                {busy === server.id ? 'Asking…' : state?.state === 'ready' ? 'Ask again' : 'Ask what it offers'}
              </Button>
              <IconButton title={`Remove ${server.name || server.id}`} tone="danger" onClick={() => remove(server.id)}>
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </Row>
          )
        })}

        {servers.length > 0 && !adding ? (
          <Row label={<Hint>Another one?</Hint>}>
            <IconButton title="Add a server" tone="accent" onClick={() => setAdding({ id: '', name: '', command: '', args: [] })}>
              <Plus className="h-4 w-4" />
            </IconButton>
          </Row>
        ) : null}
      </Section>

      {adding ? (
        <Section title="New tool server">
          <Row label="Id" description="Lowercase. Its tools are named <id>__<tool>.">
            <RowInput mono width="w-[160px]" value={adding.id} placeholder="tickets" onChange={(id) => setAdding({ ...adding, id })} />
          </Row>
          <Row label="Name" description="What the session picker calls it.">
            <RowInput width="w-[200px]" value={adding.name} placeholder="Tickets" onChange={(name) => setAdding({ ...adding, name })} />
          </Row>
          <Row
            label="Command"
            description="The program that speaks MCP on its stdin and stdout. It runs on this machine, with this app's own keys removed from its environment."
          >
            <RowInput mono width="w-[220px]" value={adding.command} placeholder="npx" onChange={(command) => setAdding({ ...adding, command })} />
          </Row>
          <Row label="Arguments" description="Separated by spaces.">
            <RowInput
              mono
              width="w-[280px]"
              value={(adding.args ?? []).join(' ')}
              placeholder="-y some-mcp-server"
              onChange={(args) => setAdding({ ...adding, args: args.split(/\s+/).filter(Boolean) })}
            />
            <IconButton title="Create" tone="accent" disabled={!adding.id.trim() || !adding.command.trim()} onClick={commit}>
              <Check className="h-4 w-4" />
            </IconButton>
          </Row>
        </Section>
      ) : null}

      <Section
        title="What one asks of you"
        description="A tool from a server is a program this app did not write doing something it did not define, so it asks before each call — per call and not per server, because connecting a ticket tracker is not the same decision as closing a ticket."
      >
        <Row
          label="Calling an external tool"
          description="Applies to every server. The approval card shows the server, the tool and the arguments it was given."
        >
          <RowSelect
            value={draft.permissions.mcp ?? 'ask'}
            onChange={(event) =>
              setDraft({
                ...draft,
                permissions: { ...draft.permissions, mcp: event.target.value as 'ask' | 'allow' | 'deny' }
              })
            }
            options={[
              { value: 'ask', label: 'Ask first' },
              { value: 'allow', label: 'Allow' },
              { value: 'deny', label: 'Refuse' }
            ]}
          />
        </Row>
      </Section>
    </>
  )
}
