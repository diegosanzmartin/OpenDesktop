import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, CheckCircle2, CircleAlert, Plus, Plug, Trash2, Wand2 } from 'lucide-react'
import type { AppConfig, EnvironmentConfig } from '@shared/types'
import { useStore } from '../state/store'
import { Hint, IconButton, Row, RowInput, RowSelect, Section, Toggle } from './settings-ui'
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
    <Row
      label={label}
      description={
        unreadable ? (
          <span className="text-warn">Stored, but not decryptable here — enter it again.</span>
        ) : hint ? (
          <span className="text-ok font-mono">{hint} · in the keychain</span>
        ) : (
          'Kept in the keychain, never in the config file.'
        )
      }
    >
      {secrets.available ? (
        <>
          <input
            type="password"
            value={draft}
            autoComplete="off"
            placeholder={hint ? 'Replace…' : placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void store()
            }}
            className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[220px] rounded-lg border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
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
        </>
      ) : (
        <Hint tone="warn">The keychain is unavailable on this machine.</Hint>
      )}
    </Row>
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

  const field = (
    label: string,
    value: string,
    placeholder: string,
    set: (value: string) => void,
    description?: string
  ): ReactNode => (
    <Row label={label} description={description}>
      <RowInput mono value={value} placeholder={placeholder} onChange={set} />
    </Row>
  )

  return (
    <>
      <Row
        label="Paste a gcloud command"
        description={pasteStatus ?? 'The fields below are filled in from it.'}
        align="start"
      >
        <textarea
          value={paste}
          spellCheck={false}
          rows={2}
          placeholder="gcloud workstations ssh --project=… --region=… NAME"
          onChange={(event) => {
            setPaste(event.target.value)
            setPasteStatus(null)
          }}
          className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[280px] resize-none rounded-lg border px-2.5 py-1.5 font-mono text-[12px] outline-none"
        />
        <IconButton
          title="Fill the fields from this command"
          tone="accent"
          disabled={!paste.trim()}
          onClick={applyPaste}
        >
          <Wand2 className="h-4 w-4" />
        </IconButton>
      </Row>

      {field('Project', w.project, 'my-project', (project) => patch({ project }))}
      {field('Region', w.region, 'europe-west1', (region) => patch({ region }))}
      {field('Cluster', w.cluster, 'workstation-cluster', (cluster) => patch({ cluster }))}
      {field('Config', w.config, 'my-workstation-config', (config) => patch({ config }))}
      {field('Workstation', w.workstation, 'my-workstation', (workstation) =>
        patch({ workstation })
      )}
      {field(
        'Login user',
        w.user ?? '',
        'user',
        (user) => patch({ user }),
        'gcloud defaults to “user”.'
      )}

      <Row
        label="Start it if stopped"
        description="Passes --start-workstation, which costs money."
      >
        <Toggle
          checked={Boolean(w.startWorkstation)}
          onChange={(startWorkstation) => patch({ startWorkstation })}
          title="Start the workstation if it is stopped"
        />
      </Row>

      <Row
        label="How it connects"
        description={
          <>
            The way gcloud does: a local TCP tunnel to port 22, then ordinary SSH over it, so
            commands, files and the terminal share one connection. Uses{' '}
            <span className="font-mono">~/.ssh/google_compute_engine</span>, which gcloud creates
            the first time you run <span className="font-mono">gcloud workstations ssh</span>.
          </>
        }
      />
    </>
  )
}

/** One host, as rows. Which rows appear depends on how it connects. */
function EnvironmentEditor({
  env,
  aliases,
  onChange
}: {
  env: EnvironmentConfig
  aliases: SshAlias[]
  onChange: (next: EnvironmentConfig) => void
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
    <>
      <Row
        label="Id"
        description={
          env.id === 'local'
            ? 'Built in. Sessions that run on this machine use it.'
            : 'Set when the host is created — sessions and stored secrets refer to it.'
        }
      >
        <RowInput mono disabled value={env.id} onChange={() => undefined} width="w-[160px]" />
      </Row>

      <Row label="Display name">
        <RowInput value={env.name} onChange={(name) => patch({ name })} />
      </Row>

      <Row label="Working directory" description="Where new sessions on this host start.">
        <RowInput
          mono
          value={env.cwd ?? ''}
          placeholder={isLocal ? '/Users/you/project' : '/srv/app'}
          onChange={(cwd) => patch({ cwd })}
        />
      </Row>

      {isSsh ? (
        <>
          <Row
            label="From ~/.ssh/config"
            description={
              aliases.length === 0
                ? 'No hosts found in ~/.ssh/config.'
                : 'Host, user, port and key are taken from that block.'
            }
          >
            <RowSelect
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
              options={[
                { value: '', label: 'Not using an alias' },
                ...aliases.map((a) => ({
                  value: a.alias,
                  label: a.host && a.host !== a.alias ? `${a.alias} → ${a.host}` : a.alias
                }))
              ]}
            />
          </Row>

          <Row label="Host">
            <RowInput
              mono
              value={env.ssh?.host ?? ''}
              placeholder="build.example.com"
              onChange={(host) => patchSsh({ host })}
            />
          </Row>
          <Row label="User">
            <RowInput
              mono
              value={env.ssh?.username ?? ''}
              placeholder="root"
              onChange={(username) => patchSsh({ username })}
            />
          </Row>
          <Row label="Port">
            <RowInput
              mono
              width="w-[100px]"
              value={env.ssh?.port ? String(env.ssh.port) : ''}
              placeholder="22"
              onChange={(value) => patchSsh({ port: Number(value.replace(/\D/g, '')) || undefined })}
            />
          </Row>

          <Row
            label="Authentication"
            description={
              auth === 'agent'
                ? 'Uses SSH_AUTH_SOCK, then ~/.ssh/id_ed25519 or id_rsa.'
                : auth === 'key'
                  ? 'The key stays on disk; only its passphrase is stored.'
                  : 'Stored in the keychain, never in the config file.'
            }
          >
            <RowSelect
              value={auth}
              onChange={(event) => setAuth(event.target.value as AuthMode)}
              options={[
                { value: 'agent', label: 'ssh-agent / default key' },
                { value: 'key', label: 'Private key file' },
                { value: 'password', label: 'Password' }
              ]}
            />
          </Row>

          {auth === 'key' ? (
            <>
              <Row label="Private key path">
                <RowInput
                  mono
                  value={env.ssh?.privateKey ?? ''}
                  placeholder="~/.ssh/id_ed25519"
                  onChange={(privateKey) => patchSsh({ privateKey })}
                />
              </Row>
              <SecretField
                label="Key passphrase"
                secretName={`env.${env.id}.passphrase`}
                placeholder="Only if the key is encrypted"
              />
            </>
          ) : null}

          {auth === 'password' ? (
            <SecretField
              label="Password"
              secretName={`env.${env.id}.password`}
              placeholder="The account password on the host"
            />
          ) : null}
        </>
      ) : null}

      {isWorkstation ? <WorkstationFields env={env} onChange={onChange} /> : null}

      <Row
        label="Connection"
        description={
          result ? (
            <span className={clsx('font-mono', result.ok ? 'text-ok' : 'text-bad')}>
              {result.message}
            </span>
          ) : live ? (
            live.connected ? (
              <span className="text-ok">connected</span>
            ) : (
              (live.message ?? 'disconnected')
            )
          ) : (
            'Tests the saved configuration.'
          )
        }
      >
        <IconButton
          title={testing ? 'Testing…' : 'Test the connection'}
          disabled={testing}
          onClick={() => void test()}
        >
          <Plug className={clsx('h-4 w-4', testing && 'animate-pulse')} />
        </IconButton>
      </Row>
    </>
  )
}

export function EnvironmentsTab(): ReactNode {
  const config = useStore((s) => s.config)
  const refreshConfig = useStore((s) => s.refreshConfig)

  const [draft, setDraft] = useState<AppConfig | null>(config)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)
  const [aliases, setAliases] = useState<SshAlias[]>([])
  const [selected, setSelected] = useState<string>('local')

  /**
   * A host being created. Held here until it has an id, because the id is the
   * key it is stored under — committing on each keystroke would create and
   * delete a host per letter typed.
   */
  const [creating, setCreating] = useState<EnvironmentConfig['kind'] | null>(null)
  const [newId, setNewId] = useState('')

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

  const hosts = useMemo(() => Object.values(draft?.environment ?? {}), [draft])

  useEffect(() => {
    if (creating) return
    if (!selected || !draft?.environment[selected]) setSelected(hosts[0]?.id ?? '')
  }, [hosts, selected, draft, creating])

  if (!draft) return null

  const current = creating ? null : draft.environment[selected]

  const commitNew = (): void => {
    if (!creating) return
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (!id) return setStatus({ kind: 'error', message: 'The id is required.' })
    if (draft.environment[id]) {
      return setStatus({ kind: 'error', message: `"${id}" already exists.` })
    }
    setDraft({
      ...draft,
      environment: {
        ...draft.environment,
        [id]: {
          id,
          name: id,
          kind: creating,
          cwd: creating === 'local' ? undefined : creating === 'gcp-workstation' ? '/home/user' : '/root',
          ...(creating === 'ssh' ? { ssh: { host: '' } } : {}),
          ...(creating === 'gcp-workstation'
            ? { workstation: { project: '', region: '', cluster: '', config: '', workstation: '' } }
            : {})
        }
      }
    })
    setCreating(null)
    setNewId('')
    setSelected(id)
    setStatus(null)
  }

  const removeCurrent = (): void => {
    if (creating) {
      setCreating(null)
      return
    }
    if (!current || current.id === 'local') return
    const rest = { ...draft.environment }
    delete rest[current.id]
    setDraft({ ...draft, environment: rest })
    setSelected(Object.keys(rest)[0] ?? '')
  }

  return (
    <>
      <Section
        title="Remote hosts"
        description="Where the tools run. The model is always called from this machine — a host only runs commands and touches files."
        action={
          status ? <Hint tone={status.kind === 'ok' ? 'ok' : 'bad'}>{status.message}</Hint> : null
        }
      >
        <Row label="Host" description="Which one you are editing.">
          <RowSelect
            value={creating ? '__new__' : selected}
            onChange={(event) => {
              if (event.target.value === '__new__') return
              setCreating(null)
              setSelected(event.target.value)
            }}
            options={[
              ...hosts.map((host) => ({ value: host.id, label: host.name || host.id })),
              ...(creating ? [{ value: '__new__', label: 'New host…' }] : [])
            ]}
          />
          <IconButton title="Add a host" tone="accent" onClick={() => setCreating('ssh')}>
            <Plus className="h-4 w-4" />
          </IconButton>
          {creating || (current && current.id !== 'local') ? (
            <IconButton
              title={creating ? 'Discard' : `Remove ${current?.name || current?.id}`}
              tone="danger"
              onClick={removeCurrent}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          ) : null}
        </Row>
      </Section>

      {creating ? (
        <Section
          title="New host"
          description="Passwords and passphrases go to the keychain, never to the config file."
        >
          <Row label="Id" description="Required, lowercase. How sessions refer to this host.">
            <RowInput
              mono
              width="w-[160px]"
              value={newId}
              placeholder="build-box"
              onChange={setNewId}
            />
            <IconButton title="Create" tone="accent" disabled={!newId.trim()} onClick={commitNew}>
              <Check className="h-4 w-4" />
            </IconButton>
          </Row>
          <Row label="Kind">
            <RowSelect
              value={creating}
              onChange={(event) => setCreating(event.target.value as EnvironmentConfig['kind'])}
              options={[
                { value: 'ssh', label: 'SSH host' },
                { value: 'gcp-workstation', label: 'Cloud Workstation' },
                { value: 'local', label: 'Local folder' }
              ]}
            />
          </Row>
        </Section>
      ) : current ? (
        <Section
          title={current.name || current.id}
          description={current.kind === 'gcp-workstation' ? 'Cloud Workstation' : current.kind}
        >
          <EnvironmentEditor
            env={current}
            aliases={aliases}
            onChange={(next) =>
              setDraft({ ...draft, environment: { ...draft.environment, [current.id]: next } })
            }
          />
        </Section>
      ) : null}
    </>
  )
}
