import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Bot,
  Boxes,
  Route,
  FileJson2,
  FolderOpen,
  Save,
  Search,
  Plug,
  Server,
  Sparkles
} from 'lucide-react'
import { useStore } from '../state/store'
import { ModelsTab } from './ModelsTab'
import { RoutingTab } from './RoutingTab'
import { EnvironmentsTab } from './EnvironmentsTab'
import { AgentsTab } from './AgentsTab'
import { SkillsTab } from './SkillsTab'
import { ToolServersTab } from './ToolServersTab'
import { Hint, IconButton, Row, Section, Toggle } from './settings-ui'

type Page = 'providers' | 'routing' | 'agents' | 'skills' | 'tools' | 'environments' | 'config'

interface NavItem {
  id: Page
  label: string
  icon: ReactNode
  /** Matched by the search box alongside the label. */
  keywords: string
}

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Settings',
    items: [
      {
        id: 'providers',
        label: 'Providers & keys',
        icon: <Boxes className="h-4 w-4" />,
        keywords:
          'provider api key endpoint openai anthropic claude chatgpt gemini helmcode model price vision allowance limit'
      },
      {
        id: 'routing',
        label: 'Routing & limits',
        icon: <Route className="h-4 w-4" />,
        keywords:
          'default model tasks subagents turn ceiling budget savings rtk shunt delegate planner context summarise compact'
      },
      {
        id: 'agents',
        label: 'Agents',
        icon: <Bot className="h-4 w-4" />,
        keywords: 'subagent manager specialist prompt permissions tools'
      },
      {
        id: 'skills',
        label: 'Skills',
        icon: <Sparkles className="h-4 w-4" />,
        keywords: 'slash command import claude'
      },
      {
        id: 'tools',
        label: 'Tool servers',
        icon: <Plug className="h-4 w-4" />,
        keywords: 'mcp server tool external stdio command connector schema tokens'
      }
    ]
  },
  {
    title: 'Execution',
    items: [
      {
        id: 'environments',
        label: 'Remote hosts',
        icon: <Server className="h-4 w-4" />,
        keywords: 'ssh gcp workstation tunnel local cwd folder'
      }
    ]
  },
  {
    title: 'Advanced',
    items: [
      {
        id: 'config',
        label: 'Config file',
        icon: <FileJson2 className="h-4 w-4" />,
        keywords: 'json raw edit secrets placeholder env file'
      }
    ]
  }
]

function ConfigEditor(): ReactNode {
  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [path, setPath] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)
  const refreshConfig = useStore((s) => s.refreshConfig)

  useEffect(() => {
    void window.opendesktop.config.getText().then((value) => {
      setText(value)
      setOriginal(value)
    })
    void window.opendesktop.config.path().then(setPath)
  }, [])

  const save = async (): Promise<void> => {
    try {
      JSON.parse(text)
    } catch (err) {
      setStatus({ kind: 'error', message: `Invalid JSON: ${(err as Error).message}` })
      return
    }
    try {
      await window.opendesktop.config.setText(text)
      await refreshConfig()
      setOriginal(text)
      setStatus({ kind: 'ok', message: 'Saved. Providers and connections were reloaded.' })
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    }
  }

  return (
    <Section
      title="Config file"
      description={
        <>
          Everything the app knows, as JSON. Secrets stay as placeholders —{' '}
          <span className="font-mono">{'{env:MY_VAR}'}</span> or{' '}
          <span className="font-mono">{'{secret:name}'}</span> — resolved when a call is made and
          never written here.
        </>
      }
      action={
        <>
          {status ? <Hint tone={status.kind === 'ok' ? 'ok' : 'bad'}>{status.message}</Hint> : null}
          <IconButton title="Reveal in Finder" onClick={() => void window.opendesktop.config.reveal()}>
            <FolderOpen className="h-4 w-4" />
          </IconButton>
          <IconButton
            title="Save"
            tone="accent"
            disabled={text === original}
            onClick={() => void save()}
          >
            <Save className="h-4 w-4" />
          </IconButton>
        </>
      }
    >
      <Row label={<span className="font-mono text-[12px]">{path}</span>} />
      <Row align="start">
        <textarea
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
          className="border-ink-800 bg-ink-950 text-ink-200 focus:border-ink-600 h-[420px] w-full resize-none rounded-lg border p-3 font-mono text-[11.5px] leading-[1.6] outline-none"
        />
      </Row>
    </Section>
  )
}

/**
 * Whether a new session asks before it acts.
 *
 * One setting, because this is a default and not a policy: the per-session
 * switch is in the composer, where the session is. Here so that someone who
 * works this way every day does not have to turn it on every time.
 */
function Approvals(): ReactNode {
  const config = useStore((s) => s.config)
  const refreshConfig = useStore((s) => s.refreshConfig)
  if (!config) return null

  return (
    <Section
      title="Approvals"
      description="Running a command, editing a file or writing one asks first unless the session says otherwise."
    >
      <Row
        label="New sessions run without asking"
        description="Lifts every “ask” to “allow” for the session. Nothing else changes: a tool set to deny stays denied, and the denylist is checked before any of this, so what it cannot run it still cannot run. Each session can be switched either way from the composer."
      >
        <Toggle
          checked={config.autoApprove === true}
          onChange={(next) => {
            void window.opendesktop.config
              .save({ ...config, autoApprove: next })
              .then(() => refreshConfig())
          }}
        />
      </Row>
    </Section>
  )
}

/**
 * Where the failures are written down.
 *
 * Here rather than anywhere cleverer because this is the page about what this
 * installation keeps on disk, and because the first thing anyone wants after
 * something breaks is the file that says what broke.
 */
function LogFile(): ReactNode {
  const [path, setPath] = useState('')
  useEffect(() => {
    void window.opendesktop.host.logPath().then((value) => setPath(value ?? ''))
  }, [])

  return (
    <Section
      title="Log"
      description="Failures, with the whole cause chain, and what a turn had spent when it broke. Appended to, rotated once at 2MB, and never containing anything shaped like a key."
      action={
        <IconButton title="Reveal in Finder" onClick={() => void window.opendesktop.host.revealLog()}>
          <FolderOpen className="h-4 w-4" />
        </IconButton>
      }
    >
      <Row label={<span className="font-mono text-[12px]">{path}</span>} />
    </Section>
  )
}

export function SettingsPane(): ReactNode {
  const [page, setPage] = useState<Page>('providers')
  const [search, setSearch] = useState('')

  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return GROUPS
    return GROUPS.map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.label.toLowerCase().includes(needle) || item.keywords.includes(needle)
      )
    })).filter((group) => group.items.length > 0)
  }, [search])

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="border-ink-800 bg-ink-900/40 flex w-[220px] shrink-0 flex-col border-r px-2.5 py-3">
        <div className="relative mb-4">
          <Search className="text-ink-600 pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-full rounded-lg border py-1.5 pl-8 pr-2 text-[12.5px] outline-none"
          />
        </div>

        {groups.map((group) => (
          <div key={group.title} className="mb-4">
            <div className="text-ink-600 px-2 pb-1.5 text-[11px]">{group.title}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPage(item.id)}
                className={clsx(
                  'mb-[2px] flex w-full items-center gap-2.5 rounded-lg px-2 py-[7px] text-[13.5px] transition-colors',
                  page === item.id
                    ? 'bg-ink-800 text-ink-100'
                    : 'text-ink-400 hover:bg-ink-850 hover:text-ink-100'
                )}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        ))}

        {groups.length === 0 ? (
          <div className="text-ink-600 px-2 text-[12px]">Nothing matches “{search}”.</div>
        ) : null}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-[760px]">
          {page === 'config' ? (
            <>
              <Approvals />
              <ConfigEditor />
              <LogFile />
            </>
          ) : null}
          {page === 'agents' ? <AgentsTab /> : null}
          {page === 'skills' ? <SkillsTab /> : null}
          {page === 'tools' ? <ToolServersTab /> : null}
          {page === 'environments' ? <EnvironmentsTab /> : null}
          {page === 'providers' ? <ModelsTab /> : null}
          {page === 'routing' ? <RoutingTab /> : null}
        </div>
      </div>
    </div>
  )
}
