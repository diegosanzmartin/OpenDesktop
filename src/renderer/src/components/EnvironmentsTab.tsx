import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, CheckCircle2, CircleAlert, Plus, Plug, Trash2, Wand2 } from 'lucide-react'
import type { AppConfig, EnvironmentConfig } from '@shared/types'
import { useStore } from '../state/store'
import { Label, Panel, Select } from './ui'
import { Hint, IconButton, Row, Section } from './settings-ui'
import { parseGcloudCommand } from '@shared/gcloud'

type SshAlias = { alias: string; host?: string; username?: string; port?: number; identityFile?: string }

type Workstation = NonNullable<EnvironmentConfig['workstation']>
/** How the connection is authenticated, derived from what the entry carries. */
type AuthMode = 'agent' | 'key' | 'password'

function authModeOf(env: EnvironmentConfig): AuthMode {
  if (env.ssh?.password) return 'password'
  if (env.ssh?.privateKey) return 'key'
  return 'agent'
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  className,
  type = 'text'
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  hint?: string
  className?: string
  type?: string
}): ReactNode {
  return (
    <label className={clsx('flex flex-col gap-1', className)}>
      <Label>{label}</Label>
      <input
        type={type}
        value={value}
        spellCheck={false}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="border-ink-800 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
      />
      {hint ? <span className="text-ink-600 text-[11px]">{hint}</span> : null}
    </label>
  )
}

/** Password and passphrase go to the keychain, never to the config file. */
function SecretField({
  label,
  secretName,
  placeholder
}: {
  label: string
  secretName: string
  placeholder: string
}): ReactNode {
  const secrets = useStore((s) => s.secrets)
  const refreshSecrets = useStore((s) => s.refreshSecrets)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const hint = secrets.hints[secretName] ?? null
  const unreadable = secrets.failed.includes(secretName)

  const store = async (): Promise<void> => {
    if (!draft.trim()) return
    setBusy(true)
    await window.opendesktop.secrets.set(secretName, draft.trim())
    setDraft('')
    await refreshSecrets()
    setBusy(false)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Label>{label}</Label>
        {hint ? <span className="text-ok font-mono text-[11px]">{hint} · in keychain</span> : null}
        {unreadable ? (
          <span className="text-warn text-[11px]">stored but not decryptable here — re-enter it</span>
        ) : null}
      </div>
      {secrets.available ? (
        <div className="flex items-center gap-1.5">
          <input
            type="password"
            value={draft}
            autoComplete="off"
            placeholder={hint ? 'Replace the stored value…' : placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void store()
            }}
            className="border-ink-800 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-w-0 flex-1 rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
          />
          <IconButton
            title="Store in the keychain"
            tone="accent"
            disabled={!draft.trim() || busy}
            onClick={() => void store()}
          >
            <Check className="h-4 w-4" />
          </IconButton>
          {hint ? (
            <IconButton
              title="Delete the stored value"
              tone="danger"
              disabled={busy}
              onClick={async () => {
                await window.opendesktop.secrets.remove(secretName)
                await refreshSecrets()
              }}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          ) : null}
        </div>
      ) : (
        <span className="text-warn text-[11.5px]">The keychain is unavailable on this machine.</span>
      )}
    </div>
  )
}

function WorkstationFields({
  env,
  onChange
}: {
  env: EnvironmentConfig
  onChange: (next: EnvironmentConfig) => void
}): ReactNode {
  const [paste, setPaste] = useState('')
  const [pasteStatus, setPasteStatus] = useState<string | null>(null)
  const w = env.workstation ?? {
    project: '',
    region: '',
    cluster: '',
    config: '',
    workstation: ''
  }

  const patch = (next: Partial<Workstation>): void =>
    onChange({ ...env, workstation: { ...w, ...next } })

  const applyPaste = (): void => {
    const parsed = parseGcloudCommand(paste)
    if (!parsed) {
      setPasteStatus('That does not look like a gcloud workstations command.')
      return
    }
    patch(parsed)
    setPaste('')
    setPasteStatus(`Filled in ${Object.keys(parsed).length} field(s).`)
  }

  return (
    <div className="border-ink-800 space-y-2.5 rounded-lg border px-3 py-2.5">
      <div className="flex flex-col gap-1">
        <Label>Paste a gcloud command to fill this in</Label>
        <div className="flex items-start gap-1.5">
          <textarea
            value={paste}
            spellCheck={false}
            rows={2}
            placeholder="gcloud workstations ssh --project=… --region=… --cluster=… --config=… NAME"
            onChange={(event) => {
              setPaste(event.target.value)
              setPasteStatus(null)
            }}
            className="border-ink-800 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-w-0 flex-1 resize-none rounded-md border px-2.5 py-1.5 font-mono text-[12px] outline-none"
          />
          <IconButton
            title="Fill the fields from this command"
            tone="accent"
            disabled={!paste.trim()}
            onClick={applyPaste}
          >
            <Wand2 className="h-4 w-4" />
          </IconButton>
        </div>
        {pasteStatus ? <span className="text-ink-500 text-[11px]">{pasteStatus}</span> : null}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Field
          label="Project"
          value={w.project}
          placeholder="my-project"
          onChange={(project) => patch({ project })}
        />
        <Field
          label="Region"
          value={w.region}
          placeholder="europe-west1"
          onChange={(region) => patch({ region })}
        />
        <Field
          label="Cluster"
          value={w.cluster}
          placeholder="workstation-cluster"
          onChange={(cluster) => patch({ cluster })}
        />
        <Field
          label="Config"
          value={w.config}
          placeholder="my-workstation-config"
          onChange={(config) => patch({ config })}
        />
        <Field
          label="Workstation"
          value={w.workstation}
          placeholder="my-workstation"
          onChange={(workstation) => patch({ workstation })}
        />
        <Field
          label="Login user"
          value={w.user ?? ''}
          placeholder="user"
          hint="gcloud defaults to “user”"
          onChange={(user) => patch({ user })}
        />
      </div>

      <label className="flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={Boolean(w.startWorkstation)}
          onChange={(event) => patch({ startWorkstation: event.target.checked })}
          className="accent-brand h-3.5 w-3.5"
        />
        <span className="text-ink-300 text-[12.5px]">Start the workstation if it is stopped</span>
        <span className="text-ink-600 text-[11px]">— passes --start-workstation, which costs money</span>
      </label>

      <p className="text-ink-600 text-[11px]">
        Connects the way gcloud does: a local TCP tunnel to port 22, then ordinary SSH over it, so
        commands, file access and the terminal all share one connection. Uses{' '}
        <span className="font-mono">~/.ssh/google_compute_engine</span>, which gcloud creates the
        first time you run <span className="font-mono">gcloud workstations ssh</span>.
      </p>
    </div>
  )
}

function EnvironmentCard({
  env,
  aliases,
  onChange,
  onRemove
}: {
  env: EnvironmentConfig
  aliases: SshAlias[]
  onChange: (next: EnvironmentConfig) => void
  onRemove: () => void
}): ReactNode {
  const envStatus = useStore((s) => s.envStatus)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [testing, setTesting] = useState(false)

  const patch = (next: Partial<EnvironmentConfig>): void => onChange({ ...env, ...next })
  const patchSsh = (next: Partial<NonNullable<EnvironmentConfig['ssh']>>): void =>
    onChange({ ...env, ssh: { host: '', ...env.ssh, ...next } })

  const auth = authModeOf(env)
  const live = envStatus[env.id]
  const isLocal = env.kind === 'local'
  const isWorkstation = env.kind === 'gcp-workstation'
  const isSsh = env.kind === 'ssh'

  const setAuth = (mode: AuthMode): void => {
    const ssh = { host: '', ...env.ssh }
    delete ssh.privateKey
    delete ssh.passphrase
    delete ssh.password
    if (mode === 'key') {
      ssh.privateKey = '~/.ssh/id_ed25519'
      ssh.passphrase = `{secret:env.${env.id}.passphrase}`
    }
    if (mode === 'password') ssh.password = `{secret:env.${env.id}.password}`
    onChange({ ...env, ssh })
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    setResult(await window.opendesktop.env.test(env.id))
    setTesting(false)
  }

  return (
    <Panel className="px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-ink-100 text-[13.5px] font-medium">{env.name || env.id}</span>
        <span className="border-ink-700 text-ink-500 rounded-md border px-1.5 font-mono text-[11px]">
          {env.id}
        </span>
        <span
          className={clsx(
            'rounded-full border px-1.5 text-[11px]',
            env.kind === 'local' ? 'border-ink-700 text-ink-500' : 'border-info/50 text-info'
          )}
        >
          {env.kind === 'gcp-workstation' ? 'cloud workstation' : env.kind}
        </span>
        {live ? (
          <span className={live.connected ? 'text-ok text-[11px]' : 'text-ink-600 text-[11px]'}>
            {live.connected ? 'connected' : (live.message ?? 'disconnected')}
          </span>
        ) : null}
        {env.id !== 'local' ? (
          <span className="ml-auto">
            <IconButton title={`Remove ${env.name || env.id}`} tone="danger" onClick={onRemove}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </span>
        ) : (
          <span className="text-ink-600 ml-auto text-[11px]">built in</span>
        )}
      </div>

      <div className="mb-2 grid grid-cols-2 gap-2">
        <Field label="Display name" value={env.name} onChange={(name) => patch({ name })} />
        <Field
          label="Working directory"
          value={env.cwd ?? ''}
          placeholder={isLocal ? '/Users/you/project' : '/srv/app'}
          hint="Where new sessions on this environment start"
          onChange={(cwd) => patch({ cwd })}
        />
      </div>

      {isSsh ? (
        <div className="border-ink-800 space-y-2 rounded-lg border px-2.5 py-2">
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <Label>From ~/.ssh/config</Label>
              <select
                value={env.ssh?.alias ?? ''}
                onChange={(event) => {
                  const alias = event.target.value
                  if (!alias) return patchSsh({ alias: undefined })
                  const found = aliases.find((a) => a.alias === alias)
                  // Copy the resolved values in so the form shows what will be used.
                  patchSsh({
                    alias,
                    host: found?.host ?? alias,
                    username: found?.username,
                    port: found?.port
                  })
                }}
                className="border-ink-800 bg-ink-900 text-ink-200 focus:border-ink-600 w-56 cursor-pointer rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
              >
                <option value="">Not using an alias</option>
                {aliases.map((a) => (
                  <option key={a.alias} value={a.alias}>
                    {a.alias}
                    {a.host && a.host !== a.alias ? ` → ${a.host}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-ink-600 pb-1 text-[11px]">
              {aliases.length === 0
                ? 'No hosts found in ~/.ssh/config'
                : 'Host, user, port and key are taken from that block'}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <Field
              label="Host"
              value={env.ssh?.host ?? ''}
              placeholder="build.example.com"
              onChange={(host) => patchSsh({ host })}
            />
            <Field
              label="User"
              value={env.ssh?.username ?? ''}
              placeholder="root"
              onChange={(username) => patchSsh({ username })}
            />
            <Field
              label="Port"
              value={env.ssh?.port ? String(env.ssh.port) : ''}
              placeholder="22"
              onChange={(value) => patchSsh({ port: Number(value.replace(/\D/g, '')) || undefined })}
            />
          </div>

          <div className="flex items-center gap-2">
            <Select
              label="Authentication"
              value={auth}
              onChange={(event) => setAuth(event.target.value as AuthMode)}
              options={[
                { value: 'agent', label: 'ssh-agent / default key' },
                { value: 'key', label: 'Private key file' },
                { value: 'password', label: 'Password' }
              ]}
            />
            <span className="text-ink-600 text-[11px]">
              {auth === 'agent'
                ? 'Uses SSH_AUTH_SOCK, then ~/.ssh/id_ed25519 or id_rsa'
                : auth === 'key'
                  ? 'The key stays on disk; only its passphrase is stored'
                  : 'Stored in the keychain, never in the config file'}
            </span>
          </div>

          {auth === 'key' ? (
            <div className="space-y-2">
              <Field
                label="Private key path"
                value={env.ssh?.privateKey ?? ''}
                placeholder="~/.ssh/id_ed25519"
                onChange={(privateKey) => patchSsh({ privateKey })}
              />
              <SecretField
                label="Key passphrase (optional)"
                secretName={`env.${env.id}.passphrase`}
                placeholder="Only if the key is encrypted"
              />
            </div>
          ) : null}

          {auth === 'password' ? (
            <SecretField
              label="Password"
              secretName={`env.${env.id}.password`}
              placeholder="The account password on the remote host"
            />
          ) : null}
        </div>
      ) : null}

      {isWorkstation ? <WorkstationFields env={env} onChange={onChange} /> : null}

      <div className="mt-2 flex items-center gap-2">
        <IconButton
          title={testing ? 'Testing…' : 'Test the connection'}
          disabled={testing}
          onClick={() => void test()}
        >
          <Plug className={clsx('h-4 w-4', testing && 'animate-pulse')} />
        </IconButton>
        <Hint>Tests the saved configuration.</Hint>
      </div>

      {result ? (
        <div
          className={clsx(
            'mt-1.5 flex items-start gap-1.5 rounded-md border px-2 py-1 font-mono text-[11.5px]',
            result.ok ? 'border-ok/40 bg-ok/10 text-ok' : 'border-bad/40 bg-bad/10 text-bad'
          )}
        >
          {result.ok ? (
            <CheckCircle2 className="mt-[1px] h-3 w-3 shrink-0" />
          ) : (
            <CircleAlert className="mt-[1px] h-3 w-3 shrink-0" />
          )}
          <span className="whitespace-pre-wrap">{result.message}</span>
        </div>
      ) : null}
    </Panel>
  )
}

export function EnvironmentsTab(): ReactNode {
  const config = useStore((s) => s.config)
  const refreshConfig = useStore((s) => s.refreshConfig)

  const [draft, setDraft] = useState<AppConfig | null>(config)
  const [aliases, setAliases] = useState<SshAlias[]>([])
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)
  const [newId, setNewId] = useState('')
  const [newKind, setNewKind] = useState<'ssh' | 'gcp-workstation' | 'local'>('ssh')

  /** What we last wrote, so the echo from the store cannot undo live typing. */
  const lastSaved = useRef<string | null>(null)

  useEffect(() => {
    if (!config) return
    if (lastSaved.current === JSON.stringify(config)) return
    setDraft(config)
  }, [config])

  useEffect(() => {
    void window.opendesktop.env.sshAliases().then(setAliases)
  }, [])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config])

  // Saved as you type, like the rest of settings. A connection test reads the
  // saved config, so a host you had only half-applied used to test as broken.
  useEffect(() => {
    if (!draft || !dirty) return
    const timer = setTimeout(() => {
      const payload = JSON.stringify(draft)
      void window.opendesktop.config
        .save(draft)
        .then(() => {
          lastSaved.current = payload
          setStatus({ kind: 'ok', message: 'Saved' })
          setTimeout(() => setStatus(null), 1600)
          return refreshConfig()
        })
        .catch((err: Error) => setStatus({ kind: 'error', message: err.message }))
    }, 700)
    return () => clearTimeout(timer)
  }, [draft, dirty, refreshConfig])

  if (!draft) return null

  const add = (kind: 'ssh' | 'local' | 'gcp-workstation'): void => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (!id) return setStatus({ kind: 'error', message: 'Give the environment an id first.' })
    if (draft.environment[id]) return setStatus({ kind: 'error', message: `"${id}" already exists.` })
    setDraft({
      ...draft,
      environment: {
        ...draft.environment,
        [id]: {
          id,
          name: id,
          kind,
          cwd: kind === 'local' ? undefined : kind === 'gcp-workstation' ? '/home/user' : '/root',
          ...(kind === 'ssh' ? { ssh: { host: '' } } : {}),
          ...(kind === 'gcp-workstation'
            ? { workstation: { project: '', region: '', cluster: '', config: '', workstation: '' } }
            : {})
        }
      }
    })
    setNewId('')
    setStatus(null)
  }

  return (
    <>
      <Section
        title="Remote hosts"
        description="Where the tools run. The model is always called from this machine — a remote host only runs commands and touches files."
        action={status ? <Hint tone={status.kind === 'ok' ? 'ok' : 'bad'}>{status.message}</Hint> : null}
      >
        {Object.values(draft.environment).map((env) => (
          <EnvironmentCard
            key={env.id}
            env={env}
            aliases={aliases}
            onChange={(next) =>
              setDraft({ ...draft, environment: { ...draft.environment, [env.id]: next } })
            }
            onRemove={() => {
              const rest = { ...draft.environment }
              delete rest[env.id]
              setDraft({ ...draft, environment: rest })
            }}
          />
        ))}

      </Section>

      <Section
        title="Add a host"
        description="Passwords and passphrases go to the keychain, never to the config file."
      >
        <Row label="Environment id" description="Lowercase; how sessions refer to this host.">
          <input
            value={newId}
            spellCheck={false}
            placeholder="build-box"
            onChange={(event) => setNewId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add(newKind)
            }}
            className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[160px] rounded-lg border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
          />
          <Select
            value={newKind}
            onChange={(event) => setNewKind(event.target.value as typeof newKind)}
            options={[
              { value: 'ssh', label: 'SSH host' },
              { value: 'gcp-workstation', label: 'Cloud Workstation' },
              { value: 'local', label: 'Local folder' }
            ]}
          />
          <IconButton title="Add host" tone="accent" onClick={() => add(newKind)}>
            <Plus className="h-4 w-4" />
          </IconButton>
        </Row>
      </Section>
    </>
  )
}
