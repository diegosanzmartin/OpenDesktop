import { useState, type ReactNode } from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import type { HookConfig, HookEvent } from '@shared/types'
import { Hint, IconButton, Row, RowInput, RowSelect, Section, Toggle } from './settings-ui'
import { Button } from './ui'
import { useConfigDraft } from '../lib/settings'

/**
 * Hooks: what the app does when the agent does something.
 *
 * The page exists to make the bargain obvious. Everything else that shapes a
 * turn is text the model reads and pays for on every step; a hook runs on the
 * machine, so it costs nothing and the model never spends attention on it.
 * That is why the examples are here rather than in a document nobody opens —
 * the hard part of a hook is thinking of it.
 */
const WHEN: { value: HookEvent; label: string; blurb: string }[] = [
  {
    value: 'before',
    label: 'Before a tool runs',
    blurb: 'A non-zero exit refuses the call, and what it printed becomes the reason the agent is given.'
  },
  {
    value: 'after',
    label: 'After a tool runs',
    blurb: 'For the side effect. What it prints is kept on the block for you and never sent to the model.'
  },
  { value: 'turn', label: 'When a turn ends', blurb: 'For what is about the whole of it.' }
]

const EXAMPLES: { name: string; event: HookEvent; matcher: string; command: string }[] = [
  {
    name: 'Format what was edited',
    event: 'after',
    matcher: 'write|edit',
    command: 'case "$OPENDESKTOP_PATH" in *.ts|*.tsx) npx prettier --write "$OPENDESKTOP_PATH";; esac'
  },
  {
    name: 'Stage what changed',
    event: 'after',
    matcher: 'write|edit',
    command: 'git add "$OPENDESKTOP_PATH" 2>/dev/null || true'
  },
  {
    name: 'Nothing in vendor',
    event: 'before',
    matcher: 'write|edit',
    command:
      'case "$OPENDESKTOP_PATH" in */vendor/*) echo "vendor/ is generated — change the generator instead"; exit 1;; esac'
  },
  {
    name: 'Tell me when it stops',
    event: 'turn',
    matcher: '',
    command: 'osascript -e \'display notification "A turn finished" with title "OpenDesktop"\''
  }
]

export function HooksTab(): ReactNode {
  const { draft, setDraft, saved, error, setError } = useConfigDraft()
  const [adding, setAdding] = useState<HookConfig | null>(null)

  if (!draft) return null
  const hooks = draft.hooks ?? []

  const put = (next: HookConfig[]): void => setDraft({ ...draft, hooks: next })
  const patch = (id: string, change: Partial<HookConfig>): void =>
    put(hooks.map((hook) => (hook.id === id ? { ...hook, ...change } : hook)))

  const commit = (): void => {
    if (!adding) return
    const id = (adding.id || adding.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (!id) return setError('It needs a name.')
    if (hooks.some((hook) => hook.id === id)) return setError(`"${id}" already exists.`)
    if (!adding.command.trim()) return setError('It needs a command.')
    put([...hooks, { ...adding, id }])
    setAdding(null)
    setError(null)
  }

  return (
    <>
      <Section
        title="Hooks"
        description={
          <>
            A command this app runs when the agent does something — formatting what it edited,
            staging it, refusing a path, telling you a turn ended. It runs on the machine rather
            than in the conversation, so unlike a rule in a prompt it costs no tokens and the
            model spends no attention on it. It runs on the session&apos;s own execution target,
            in its working directory.
          </>
        }
        action={error ? <Hint tone="bad">{error}</Hint> : saved ? <Hint tone="ok">Saved</Hint> : null}
      >
        {hooks.length === 0 && !adding ? (
          <Row label={<Hint>None yet.</Hint>}>
            <Button size="sm" variant="outline" onClick={() => setAdding({ id: '', name: '', event: 'after', matcher: 'write|edit', command: '' })}>
              <Plus className="h-3 w-3" /> Add one
            </Button>
          </Row>
        ) : null}

        {hooks.map((hook) => (
          <Row
            key={hook.id}
            label={hook.name || hook.id}
            description={
              <>
                {WHEN.find((entry) => entry.value === hook.event)?.label ?? hook.event}
                {hook.matcher ? ` · ${hook.matcher}` : ' · every tool'} ·{' '}
                <span className="font-mono text-[11px]">{hook.command}</span>
              </>
            }
          >
            <Toggle
              checked={hook.enabled !== false}
              onChange={(enabled) => patch(hook.id, { enabled })}
              title={hook.enabled === false ? 'Switched off' : 'Runs'}
            />
            <IconButton title={`Remove ${hook.name || hook.id}`} tone="danger" onClick={() => put(hooks.filter((entry) => entry.id !== hook.id))}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </Row>
        ))}

        {hooks.length > 0 && !adding ? (
          <Row label={<Hint>Another one?</Hint>}>
            <IconButton title="Add a hook" tone="accent" onClick={() => setAdding({ id: '', name: '', event: 'after', matcher: 'write|edit', command: '' })}>
              <Plus className="h-4 w-4" />
            </IconButton>
          </Row>
        ) : null}
      </Section>

      {adding ? (
        <Section title="New hook" description={WHEN.find((entry) => entry.value === adding.event)?.blurb}>
          <Row label="Name" description="What it is for, in three words.">
            <RowInput width="w-[220px]" value={adding.name ?? ''} placeholder="Format what was edited" onChange={(name) => setAdding({ ...adding, name })} />
          </Row>
          <Row label="When">
            <RowSelect
              value={adding.event}
              onChange={(event) => setAdding({ ...adding, event: event.target.value as HookEvent })}
              options={WHEN.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
          </Row>
          <Row label="Which tools" description="A regular expression over the tool name. Empty means every one.">
            <RowInput mono width="w-[160px]" value={adding.matcher ?? ''} placeholder="write|edit" onChange={(matcher) => setAdding({ ...adding, matcher })} />
          </Row>
          <Row
            label="Command"
            description={
              <>
                Shell. It is told what happened through <span className="font-mono">$OPENDESKTOP_TOOL</span>,{' '}
                <span className="font-mono">$OPENDESKTOP_PATH</span>,{' '}
                <span className="font-mono">$OPENDESKTOP_COMMAND</span>,{' '}
                <span className="font-mono">$OPENDESKTOP_SESSION</span> and{' '}
                <span className="font-mono">$OPENDESKTOP_OK</span>.
              </>
            }
            align="start"
          >
            <RowInput mono width="w-[300px]" value={adding.command} placeholder="npx prettier --write &quot;$OPENDESKTOP_PATH&quot;" onChange={(command) => setAdding({ ...adding, command })} />
            <IconButton title="Create" tone="accent" disabled={!adding.command.trim()} onClick={commit}>
              <Check className="h-4 w-4" />
            </IconButton>
          </Row>
        </Section>
      ) : null}

      <Section
        title="Ones worth having"
        description="The hard part of a hook is thinking of it. Click one to fill the form in."
      >
        {EXAMPLES.map((example) => (
          <Row
            key={example.name}
            label={example.name}
            description={<span className="font-mono text-[11px]">{example.command}</span>}
          >
            <Button size="sm" variant="outline" onClick={() => setAdding({ ...example, id: '' })}>
              Use this
            </Button>
          </Row>
        ))}
      </Section>
    </>
  )
}
