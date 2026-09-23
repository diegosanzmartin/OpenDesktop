/**
 * Renders real components into a real DOM and asserts what comes out.
 *
 * Every UI regression in this project so far was caught by taking a screenshot
 * and looking at it — slow, and only as reliable as my attention. This runs
 * under Electron because Electron already is a browser: nothing to install, and
 * `getComputedStyle` tells the truth, so a rule that depends on the size of its
 * container can be checked instead of eyeballed.
 *
 * Run with: pnpm ui:check
 */
import './src/styles.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import type { AppEvent, ApprovalRequest, Block, Message, Session } from '@shared/types'
import { useStore } from './src/state/store'
import { BlockCard } from './src/components/BlockCard'
import { ApprovalCard } from './src/components/ApprovalCard'
import { Mentions } from './src/components/Markdown'
import { DocumentCard } from './src/components/DocumentCard'
import { Composer } from './src/components/Composer'
import { EditedFiles } from './src/components/Transcript'
import { ContextMeter } from './src/components/ContextMeter'
import { ToolServerChip } from './src/components/ToolServerChip'
import { ToolServersTab } from './src/components/ToolServersTab'
import { HooksTab } from './src/components/HooksTab'
import { ChangesPane } from './src/components/ChangesPane'
import { FilesPane } from './src/components/FilesPane'
import { EditorPane } from './src/components/EditorPane'
import { opensInViewer } from './src/components/DocumentCard'
import { BrowserPane } from './src/components/BrowserPane'
import { previewTarget, previewTitle } from './src/lib/preview'
import { EffortDial } from './src/components/EffortDial'
import { ModelsTab } from './src/components/ModelsTab'
import { RoutingTab } from './src/components/RoutingTab'
import { FolderPicker } from './src/components/FolderPicker'
import { LocalModelSection } from './src/components/LocalModelSection'
import { ChatView } from './src/components/ChatView'
import { PANE_FRAME } from './src/components/ui'
import { SandboxSection } from './src/components/SandboxSection'
import { ScopeGate, ForensicLine } from './src/components/ScopeGate'
import { NeighbourBar } from './src/components/NeighbourBar'

const failures: string[] = []
let checks = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  checks++
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function section(name: string): void {
  console.log(`\n${name}`)
}

/**
 * Everything the preload bridge would provide, as async no-ops.
 *
 * Callable at every depth: components reach for `files.stat` and
 * `attachments.accepted`, and a stub that is only callable at the top produces
 * a crash in a place that has nothing to do with what is being tested.
 */
const REPLIES: Record<string, unknown> = {
  stat: { size: 9614, modifiedAt: 0 },
  browse: {
    path: '/home/user/w/sec',
    home: '/home/user',
    parent: '/home/user/w',
    dirs: ['acme--global--core', 'docs', 'services']
  },
  findDirs: {
    root: '/home/user',
    truncated: false,
    builtAt: 0,
    dirs: [
      '/home/user/w',
      '/home/user/w/sec',
      '/home/user/w/sec/acme--global--core',
      '/home/user/w/sec/acme--global--core/acme--global--core~identity',
      '/home/user/w/sec/acme--global--core/docs',
      '/home/user/other/identity-notes'
    ]
  },
  changes: { isRepo: false, root: '', branch: '', files: [], added: 0, removed: 0 },
  // Nobody else is in the file unless a section says so, or every composer in
  // every other check would grow a line it is not about.
  'sessions.neighbours': [],
  previewUrl: 'http://127.0.0.1/none',
  accepted: true,
  running: false,
  list: [],
  messages: [],
  blocks: [],
  buffer: '',
  status: { available: true, names: [], failed: [], hints: {} },
  /*
   * Keyed by path, so two bridges that both answer `status()` can answer
   * differently. The local model's row is the reason: it reads a status of its
   * own, and getting the keychain's back made the section render as nothing.
   */
  'mcp.list': [
    {
      id: 'tickets',
      name: 'Tickets',
      state: 'ready',
      tools: [
        { name: 'search', description: 'Search tickets.' },
        { name: 'comment', description: 'Comment on one.' }
      ],
      tokens: 1_900
    },
    { id: 'broken', name: 'Broken', state: 'failed', tools: [], tokens: 0, message: 'no such command' }
  ],
  'meter.get': {
    'helmcode/glm5.3-flash': { day: 412_000, month: 3_140_000, dayCost: 0, monthCost: 0 },
    'anthropic/claude-sonnet-5': { day: 9_400, month: 148_000, dayCost: 0.21, monthCost: 3.42 },
    'local/qwen3-4b': { day: 21_000, month: 64_000, dayCost: 0, monthCost: 0 }
  },
  'local.status': {
    stage: 'absent',
    supported: true,
    spec: {
      id: 'qwen2.5-3b-instruct',
      name: 'Qwen2.5 3B Instruct',
      bytes: 2_104_932_768,
      contextWindow: 32_768,
      ramBytes: 3_400_000_000,
      blurb: 'Answers straight away and calls tools.'
    },
    runtime: { installed: false, build: 'b11026' },
    model: { installed: false, bytes: 0 },
    diskBytes: 0
  },
  'sandbox.status': {
    stage: 'ready',
    supported: true,
    imageBuilt: true,
    image: 'opendesktop/pentest:1',
    tools: [
      { name: 'nmap', blurb: 'Ports' },
      { name: 'ffuf', blurb: 'Fuzzing' }
    ]
  }
}

/** Whatever the page has subscribed to the bus with, so a test can push. */
const listeners: ((event: AppEvent) => void)[] = []

function pushEvent(event: AppEvent): void {
  for (const listener of listeners) listener(event)
}

function stubBridge(): void {
  const node = (path: string): unknown =>
    new Proxy(function stub() {} as unknown as Record<string, unknown>, {
      get: (_target, key) =>
        key === 'then' ? undefined : node(path ? `${path}.${String(key)}` : String(key)),
      // The full path first, then the bare method name, so every reply that
      // was written before paths existed still answers.
      apply: (_target, _this, args: unknown[]) => {
        // The one call that is not a request for a value: a subscription, whose
        // listener has to be kept if anything pushed is to arrive.
        if (path === 'onEvent' && typeof args[0] === 'function') {
          const listener = args[0] as (event: AppEvent) => void
          listeners.push(listener)
          return () => {
            const at = listeners.indexOf(listener)
            if (at >= 0) listeners.splice(at, 1)
          }
        }
        return Promise.resolve(REPLIES[path] ?? REPLIES[path.split('.').pop() ?? ''] ?? null)
      }
    })
  ;(window as unknown as { opendesktop: unknown }).opendesktop = node('')
}

const session: Session = {
  id: 's1',
  title: 'A session',
  cwd: '/tmp/project',
  environmentId: 'local',
  agentId: 'manager',
  model: 'p/m',
  status: 'idle',
  createdAt: 0,
  updatedAt: 0,
  usage: { input: 0, output: 0, cost: 0 }
}

function seedStore(): void {
  useStore.setState({
    ready: true,
    sessions: [session],
    activeSessionId: session.id,
    models: [{ ref: 'p/m', label: 'M', provider: 'P' }],
    skills: [],
    config: {
      $schema: '',
      model: 'p/m',
      provider: {
        p: { id: 'p', npm: '@ai-sdk/openai-compatible', name: 'P', options: {}, models: { m: { id: 'm', name: 'M' } } }
      },
      environment: { local: { id: 'local', name: 'Local', kind: 'local' } },
      agent: {
        infra: { id: 'infra', name: 'Infrastructure', description: 'IaC', mode: 'all', color: '#d3a84c' }
      },
      permissions: { bash: 'ask', edit: 'ask', write: 'ask', read: 'allow', fetch: 'ask', mcp: 'ask', allowlist: [], denylist: [] },
      maxSteps: 60,
      smoothStreamMs: 0,
      theme: 'dark'
    }
  })
}

function mount(element: React.ReactElement, width?: number): HTMLElement {
  const host = document.createElement('div')
  if (width) host.style.width = `${width}px`
  document.body.appendChild(host)
  createRoot(host).render(element)
  return host
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40))

function block(over: Partial<Block>): Block {
  return {
    id: `b${Math.random()}`,
    sessionId: 's1',
    messageId: 'm1',
    tool: 'bash',
    title: 'npx tsc --noEmit',
    subtitle: 'Typecheck the renderer',
    status: 'success',
    input: { command: 'npx tsc --noEmit -p tsconfig.web.json' },
    output: 'no errors',
    cwd: '/tmp/project',
    environmentId: 'local',
    agentId: 'auto',
    createdAt: 0,
    startedAt: 0,
    endedAt: 1200,
    exitCode: 0,
    ...over
  } as Block
}

async function run(): Promise<void> {
  stubBridge()
  seedStore()

  section('a command block')
  {
    const host = mount(<BlockCard block={block({})} />)
    await settle()
    const text = host.textContent ?? ''
    check('says what the agent was doing', text.includes('Typecheck the renderer'), text)
    check('shows how long it took', /1\.2s|1s/.test(text), text)
    check('and the exit code beside it', text.includes('exit 0'), text)
    check('does not name the tool', !/COMMAND|\bCommand\b/.test(text), text)
    check('does not repeat the folder', !text.includes('/tmp/project'), text)
    check('keeps the command itself until it is opened', !text.includes('tsconfig.web.json'), text)
  }

  section('a command block that failed')
  {
    const host = mount(<BlockCard block={block({ status: 'error', exitCode: 2 })} />)
    await settle()
    check('shows the failing code', (host.textContent ?? '').includes('exit 2'))
    check('and reads as a failure', host.innerHTML.includes('text-bad'))
  }

  section('a command block still running')
  {
    const host = mount(<BlockCard block={block({ status: 'running', exitCode: undefined })} />)
    await settle()
    const text = host.textContent ?? ''
    check('says so instead of showing a duration', /Running/i.test(text), text)
    check('and shows no exit code', !text.includes('exit'), text)
  }

  section('an approval')
  {
    const request: ApprovalRequest = {
      id: 'a1',
      sessionId: 's1',
      blockId: 'b1',
      tool: 'bash',
      title: 'python3 shuffle.py',
      detail: 'python3 shuffle.py',
      summary: 'Run the shuffle script with two seeds',
      preview: 'python3 shuffle.py "x" --seed 42',
      environmentId: 'local',
      cwd: '/tmp',
      createdAt: 0
    }
    const host = mount(<ApprovalCard request={request} active={false} />)
    await settle()
    const text = host.textContent ?? ''
    check("asks in the agent's own words", text.includes('run the shuffle script with two seeds?'), text)
    check(
      'offers all three ways out',
      text.includes('Deny') && text.includes('Always allow') && text.includes('Allow once')
    )
    check('shows the keys that take them', text.includes('Esc') && text.includes('⌘'))
    check('and exactly what would run', text.includes('--seed 42'))
  }

  section('an agent named with @')
  {
    const known = mount(<Mentions text="ask @Infrastructure to check it" />)
    await settle()
    check(
      'the sentence is unchanged',
      known.textContent === 'ask @Infrastructure to check it',
      known.textContent
    )
    check('and the agent is marked as one', known.querySelectorAll('span[style]').length > 0)

    const unknown = mount(<Mentions text="email @nobody today" />)
    await settle()
    check(
      'an @word that is nobody stays prose',
      unknown.querySelectorAll('span[style]').length === 0,
      unknown.innerHTML
    )
  }

  section('a document')
  {
    const host = mount(<DocumentCard path="/tmp/report.md" environmentId="local" />)
    await settle()
    const text = host.textContent ?? ''
    check('shows its kind', text.includes('MD'), text)
    check('and its name', text.includes('report.md'), text)
    check('and its size once known', /KB|B\b/.test(text), text)
    check('with a way to save it', Boolean(host.querySelector('button[title="Save a copy"]')))
  }

  section('the context gauge')
  {
    // The window is declared on the model, so the gauge has a real denominator:
    // 200k less 8k for the reply and 4k of framing = 188k usable.
    useStore.setState({
      config: {
        ...useStore.getState().config!,
        compactAtFraction: 0.7,
        provider: {
          p: {
            id: 'p',
            npm: '@ai-sdk/openai-compatible',
            name: 'P',
            options: {},
            models: {
              m: { id: 'm', name: 'M', contextWindow: 200_000, maxOutputTokens: 8_000 }
            }
          }
        }
      }
    })

    const at = (contextTokens?: number): HTMLElement =>
      mount(<ContextMeter session={{ ...session, contextTokens }} />)

    // Half the window, and 71% of the way to a summary at 70% of it — the
    // second is the number shown, because that is the thing about to happen.
    const half = at(94_000)
    await settle()
    check('shows how close the summary is', (half.textContent ?? '').includes('71%'), half.textContent)
    check('and is calm below the threshold', !half.innerHTML.includes('text-warn'))

    const full = at(150_000)
    await settle()
    check('warns once past the point it will summarise', full.innerHTML.includes('text-warn'), full.textContent)

    // A session with no measured context still shows the ring at zero: it is
    // the way into the panel, and a control that appears only after the first
    // turn is a control nobody finds.
    const silent = at(undefined)
    await settle()
    check('reads zero before a turn has been measured', (silent.textContent ?? '').includes('0%'), silent.textContent)

    useStore.setState({
      config: {
        ...useStore.getState().config!,
        provider: {
          p: {
            id: 'p',
            npm: '@ai-sdk/openai-compatible',
            name: 'P',
            options: {},
            models: { m: { id: 'm', name: 'M' } }
          }
        }
      }
    })
    const unknown = at(94_000)
    await settle()
    check(
      'and invents no percentage when the model declares no window',
      (unknown.textContent ?? '') === '',
      unknown.textContent
    )
  }

  section('the composer footer, by the width of its pane')
  {
    // A container query, not a media query: what has room is a property of the
    // pane, and a viewport breakpoint here was wrong in exactly the way no
    // screenshot on a wide monitor would reveal. Probed with the one thing in
    // the strip that is allowed to disappear — a named agent's description.
    const named = { ...session, agentId: 'infra' }
    const wide = mount(<Composer session={named} />, 900)
    const narrow = mount(<Composer session={named} />, 420)
    await settle()

    const noteIn = (host: HTMLElement): HTMLElement | undefined =>
      [...host.querySelectorAll('span')].find((span) => span.textContent === 'IaC') as
        | HTMLElement
        | undefined

    const wideNote = noteIn(wide)
    const narrowNote = noteIn(narrow)
    check('the note is in the markup either way', Boolean(wideNote) && Boolean(narrowNote))
    if (wideNote && narrowNote) {
      check(
        'shown when the pane is wide',
        getComputedStyle(wideNote).display !== 'none',
        getComputedStyle(wideNote).display
      )
      check(
        'and hidden when it is narrow',
        getComputedStyle(narrowNote).display === 'none',
        getComputedStyle(narrowNote).display
      )
    }
    check('a named agent says which one it is', (wide.textContent ?? '').includes('Infrastructure'))

    // The manager runs almost every chat, so naming it said nothing.
    const managed = mount(<Composer session={session} />, 900)
    await settle()
    const text = managed.textContent ?? ''
    check('the default agent is not named at all', !text.includes('Manager'), text)
    check('and nor is the way to reach the others', !text.includes('type @'), text)
  }

  section('the savings chip')
  {
    const chipIn = (host: HTMLElement): HTMLElement | undefined =>
      [...host.querySelectorAll('button')].find((button) =>
        (button.getAttribute('title') ?? '').startsWith('What this session does')
      ) as HTMLElement | undefined

    const plain = mount(<Composer session={session} />, 900)
    await settle()
    check('the composer carries the switches', Boolean(chipIn(plain)))
    check(
      'and nothing on reads as Direct',
      (chipIn(plain)?.textContent ?? '').includes('Direct'),
      chipIn(plain)?.textContent
    )

    const one = mount(<Composer session={{ ...session, savings: { shunt: true } }} />, 900)
    await settle()
    check('one on is named', (chipIn(one)?.textContent ?? '').includes('shunt'))

    const two = mount(
      <Composer session={{ ...session, savings: { rtk: true, shunt: true } }} />,
      900
    )
    await settle()
    check(
      'and both on are named together, which a mode picker could not say',
      (chipIn(two)?.textContent ?? '').includes('rtk + shunt'),
      chipIn(two)?.textContent
    )

    // Opening it shows two independent switches, not three exclusive options.
    chipIn(plain)?.click()
    await settle()
    const panel = [...document.body.querySelectorAll('div')].find((node) =>
      (node.textContent ?? '').includes('Neither is Direct')
    )
    check('opening it offers both', Boolean(panel))
    check(
      'described rather than abbreviated',
      (panel?.textContent ?? '').includes('Filter command output') &&
        (panel?.textContent ?? '').includes('Delegate reading and planning'),
      panel?.textContent
    )
    check('and there is no third option to choose', !(panel?.textContent ?? '').includes('Direct mode'))
    // Closed the way a person closes it. Removing the portal by hand left
    // React holding a node that was no longer there, which it then threw over.
    chipIn(plain)?.click()
    await settle()

    const saved = REPLIES.status
    REPLIES.status = { state: 'missing', message: 'not on the PATH' }
    const broken = mount(<Composer session={{ ...session, savings: { rtk: true } }} />, 900)
    await settle()
    check(
      'a missing rtk is admitted to, not hidden',
      (broken.textContent ?? '').includes('rtk not installed here'),
      broken.textContent
    )
    check('and it is a warning, not a note', broken.innerHTML.includes('text-warn'))

    // The offer to put it there, which is the answer to "do I have to install
    // rtk on every host": only shown when the probe says it is missing.
    check(
      'a missing rtk comes with an offer to fetch it',
      (broken.textContent ?? '').includes('Install rtk on') === false,
      'the offer lives in the menu, not the strip'
    )
    const chip = [...broken.querySelectorAll('button')].find((button) =>
      (button.getAttribute('title') ?? '').startsWith('What this session does')
    ) as HTMLButtonElement
    chip.click()
    await settle()
    const menu = [...document.body.querySelectorAll('div')].find((node) =>
      (node.textContent ?? '').includes('Neither is Direct')
    )
    check(
      'the menu offers to install it on that host',
      (menu?.textContent ?? '').includes('Install rtk on'),
      menu?.textContent
    )
    check(
      'and says what that does to the machine',
      (menu?.textContent ?? '').includes('checksum') &&
        (menu?.textContent ?? '').includes('No brew, no sudo'),
      menu?.textContent
    )
    chip.click()
    await settle()

    REPLIES.status = { state: 'ready', version: '0.28.2' }
    const ready = mount(<Composer session={{ ...session, savings: { rtk: true } }} />, 900)
    await settle()
    check(
      'a working rtk shows which one is working',
      (ready.textContent ?? '').includes('rtk 0.28.2'),
      ready.textContent
    )
    REPLIES.status = saved

    // Delegation says where the reading is going, and says so loudly when it
    // is going nowhere cheaper.
    const same = mount(<Composer session={{ ...session, savings: { shunt: true } }} />, 900)
    await settle()
    check(
      'nowhere cheaper to delegate to says so, as a fact rather than a warning',
      (same.textContent ?? '').includes('reading → same model') &&
        !(same.innerHTML ?? '').includes('text-warn'),
      same.textContent
    )

    useStore.setState({ config: { ...useStore.getState().config!, shuntModel: 'p/cheap' } })
    const cheap = mount(<Composer session={{ ...session, savings: { shunt: true } }} />, 900)
    await settle()
    check(
      'and naming the worker once there is one',
      (cheap.textContent ?? '').includes('reading → p/cheap'),
      cheap.textContent
    )
    check('with nothing to warn about', !cheap.innerHTML.includes('text-warn'))
    useStore.setState({ config: { ...useStore.getState().config!, shuntModel: undefined } })
  }

  section('a command a switch rewrote')
  {
    const rewritten: Block = block({
      id: 'b-rtk',
      title: 'git status',
      subtitle: 'check the repo',
      input: { command: 'git status', ranAs: 'rtk git status' },
      output: 'M src/main/rtk.ts'
    })
    const host = mount(<BlockCard block={rewritten} />)
    await settle()
    check(
      'the row says the output was filtered',
      (host.textContent ?? '').includes('rtk'),
      host.textContent
    )
    check(
      'but the heading is still what the agent asked for',
      (host.textContent ?? '').includes('check the repo')
    )

    useStore.setState({ expanded: { 'b-rtk': true } })
    const open = mount(<BlockCard block={rewritten} />)
    await settle()
    check(
      'and opening it shows what actually ran',
      (open.textContent ?? '').includes('# ran as: rtk git status'),
      open.textContent
    )
    useStore.setState({ expanded: {} })
  }

  section('the cost and capability settings')
  {
    // Two models, one obviously better, so the routing has something to say.
    const before = useStore.getState().config!
    useStore.setState({
      config: {
        ...before,
        savings: { rtk: false, shunt: true },
        provider: {
          p: {
            id: 'p',
            npm: '@ai-sdk/openai-compatible',
            name: 'P',
            options: {},
            models: {
              brain: { id: 'brain', name: 'Brain', cost: 5, iq: 5 },
              cheap: { id: 'cheap', name: 'Cheap', cost: 1, iq: 2, billing: 'flat' }
            }
          }
        }
      }
    })

    const host = mount(<ModelsTab />, 900)
    await settle()
    const text = host.textContent ?? ''
    /*
     * The two questions are two pages now: what models exist and what the app
     * does with them. They used to share one, so the provider was picked at the
     * top, its key was three sections below, and a fourth section listed every
     * model of every provider — the one that overflowed.
     */
    check(
      'the providers page is about providers, and says so',
      text.includes('Providers') && text.includes('A provider is a key'),
      text.slice(0, 160)
    )
    check(
      'a model is configured where it lives, prices and all',
      text.includes('Pay as you go') &&
        text.includes('Flat rate') &&
        text.includes('Included allowance') &&
        text.includes('cheap') &&
        text.includes('strong'),
      text.includes('Included allowance')
    )
    check(
      'and the routing settings are not on it',
      !text.includes('Savings') && !text.includes('Summarise at') && !text.includes('Default model'),
      text.slice(0, 200)
    )

    const routing = mount(<RoutingTab />, 900)
    await settle()
    const routingText = routing.textContent ?? ''
    check('the switches have a home of their own', routingText.includes('Savings'))
    check(
      'the routing page says what it currently decides',
      /reading and boilerplate → p\/cheap/.test(routingText) && /plans → p\/brain/.test(routingText),
      routingText.slice(routingText.indexOf('What that decides'), routingText.indexOf('What that decides') + 200)
    )
    check(
      'with the reason, so the choice is not a mystery',
      routingText.includes('already paid for'),
      routingText
    )
    check(
      'and it shows the tier the router uses rather than another set of sliders',
      routingText.includes('flat rate') &&
        /cost \d\/5/.test(routingText) &&
        routing.querySelectorAll('button[aria-label$="of 5"]').length === 0,
      routingText.slice(routingText.indexOf('As it stands'), routingText.indexOf('As it stands') + 220)
    )
    check(
      'the ceilings are there too, since they are what the app may spend',
      routingText.includes('A turn may spend') && routingText.includes('Subagents at once')
    )
    check(
      'neither page runs off the side',
      routing.scrollWidth <= routing.clientWidth + 1,
      { scroll: routing.scrollWidth, client: routing.clientWidth }
    )

    /*
     * Nothing may run off the side.
     *
     * The model rows were a label on the left and their controls on the right,
     * with the control side set not to shrink — so once a model had a billing
     * select, an allowance, a period and two sliders, the row was wider than
     * the panel: the page scrolled sideways and the label column collapsed
     * until "Claude Opus 5" wrapped one word per line. Measured rather than
     * eyeballed, at the width the settings pane actually gets and at a narrow
     * one.
     */
    check(
      'the settings page does not run off the side',
      host.scrollWidth <= host.clientWidth + 1,
      { scroll: host.scrollWidth, client: host.clientWidth }
    )
    const narrow = mount(<ModelsTab />, 620)
    await settle()
    check(
      'nor when the pane is narrow',
      narrow.scrollWidth <= narrow.clientWidth + 1,
      { scroll: narrow.scrollWidth, client: narrow.clientWidth }
    )
    check(
      'and nothing is painted past the right edge of the pane',
      (() => {
        const edge = host.getBoundingClientRect().right
        const spill = [...host.querySelectorAll('*')].filter(
          (el) => el.getBoundingClientRect().right > edge + 1
        )
        return spill.length === 0
      })(),
      [...host.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > host.getBoundingClientRect().right + 1)
        .slice(0, 4)
        .map((el) => `${el.tagName}.${(el.className || '').toString().slice(0, 40)}`)
    )
    check(
      'each model is one block, with its price and its billing together',
      host.querySelectorAll('input[placeholder="model-id"]').length === 2 &&
        host.querySelectorAll('input[placeholder="$ in"]').length === 2 &&
        [...host.querySelectorAll('select')].filter((select) =>
          (select.textContent ?? '').includes('Flat rate')
        ).length === 2,
      {
        ids: host.querySelectorAll('input[placeholder="model-id"]').length,
        prices: host.querySelectorAll('input[placeholder="$ in"]').length
      }
    )

    const sliders = host.querySelectorAll('button[aria-label$="of 5"]')
    check('the judgements are coarse on purpose — five steps', sliders.length === 20, sliders.length)

    /*
     * Adding a provider must be a choice, not a data-entry exercise. The list
     * of providers is what the catalogue says, and picking Anthropic has to bring
     * its models with it — that is the whole difference between "add Anthropic"
     * and "type three model ids and six prices". On its own mount, since
     * clicking it replaces the page with the new-provider form.
     */
    const adder = mount(<ModelsTab />, 900)
    await settle()
    const addButton = [...adder.querySelectorAll('button')].find(
      (button) => button.getAttribute('title') === 'Add a provider'
    ) as HTMLElement | undefined
    check('there is a way to add a provider', Boolean(addButton))
    addButton?.click()
    await settle()
    const adding = adder.textContent ?? ''
    check(
      'the providers it knows are offered by name, not by npm package',
      adding.includes('Anthropic · Claude') && adding.includes('OpenAI · ChatGPT models'),
      adding.slice(adding.indexOf('Which provider'), adding.indexOf('Which provider') + 160)
    )
    check(
      'and picking one says how many models come with it',
      /\d+ models come with it/.test(adding),
      adding.slice(adding.indexOf('models come with it') - 60, adding.indexOf('models come with it') + 40)
    )

    useStore.setState({ config: before })
  }

  section('asking, or not')
  {
    const chipIn = (host: HTMLElement): HTMLElement | undefined =>
      [...host.querySelectorAll('button')].find((button) =>
        /^(Asks first|Auto-approve)$/.test(button.textContent ?? '')
      ) as HTMLElement | undefined

    const asks = mount(<Composer session={session} />, 900)
    await settle()
    check(
      'a session says that it asks first',
      chipIn(asks)?.textContent === 'Asks first',
      chipIn(asks)?.textContent
    )
    check('calmly', !asks.innerHTML.includes('text-warn'))

    const auto = mount(<Composer session={{ ...session, autoApprove: true }} />, 900)
    await settle()
    check(
      'and one that does not says that instead',
      chipIn(auto)?.textContent === 'Auto-approve',
      chipIn(auto)?.textContent
    )
    check(
      'in the colour of something worth noticing',
(chipIn(auto)?.className ?? '').includes('text-warn'),
      chipIn(auto)?.className
    )
    check(
      'and says what it still will not do',
      (chipIn(auto)?.getAttribute('title') ?? '').includes('denylist'),
      chipIn(auto)?.getAttribute('title')
    )

    // The app-wide default carries when the session has no say of its own.
    const before = useStore.getState().config!
    useStore.setState({ config: { ...before, autoApprove: true } })
    const inherited = mount(<Composer session={session} />, 900)
    await settle()
    check(
      'a session with no preference follows the default',
      chipIn(inherited)?.textContent === 'Auto-approve'
    )
    useStore.setState({ config: before })
  }

  section('the remote folder picker')
  {
    const remote = { ...session, id: 's-remote', environmentId: 'wk', cwd: '/home/user/w/sec' }
    useStore.setState({
      sessions: [remote],
      activeSessionId: remote.id,
      folderPicker: { sessionId: remote.id, mode: 'browse' }
    })

    const host = mount(<FolderPicker />, 900)
    await settle()
    const text = host.textContent ?? ''
    check('it says what it is picking, and where', text.includes('Select remote folder'), text.slice(0, 80))
    check('the path is in a box you can type into', (host.querySelector('input') as HTMLInputElement)?.value === '/home/user/w/sec')
    check(
      'the breadcrumb is the path, split up',
      ['home', 'user', 'w', 'sec'].every((part) => text.includes(part)),
      text
    )
    check('there is a way up', text.includes('..'))
    check(
      'and the folders below are listed',
      text.includes('acme--global--core') && text.includes('services'),
      text
    )
    check('with both ways out', text.includes('Cancel') && text.includes('Select folder'))
    check(
      'and no OS dialog offered for a machine it cannot see',
      !text.includes('Browse…'),
      text
    )

    // The other half: fzf over every directory under home.
    const searchTab = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Search'
    ) as HTMLButtonElement
    check('the two halves are offered as such', Boolean(searchTab))
    searchTab.click()
    await settle()

    const box = host.querySelector('input') as HTMLInputElement
    check('search puts the cursor in a query box', Boolean(box))
    check('and says what it is searching under', (host.textContent ?? '').includes('under /home/user'))

    // Typing four letters, the way the deep folder would actually be found.
    const react = Object.keys(box).find((key) => key.startsWith('__reactProps')) as string
    ;(box as unknown as Record<string, { onChange: (e: unknown) => void }>)[react].onChange({
      target: { value: 'agci' }
    })
    await settle()
    const results = host.textContent ?? ''
    check(
      'four initials find the folder six levels down',
      results.includes('acme--global--core~identity'),
      results
    )
    check(
      'and what matched is marked in it',
      host.innerHTML.includes('text-brand'),
      host.innerHTML.slice(0, 200)
    )
    check('the keys are written down rather than guessed at', results.includes('↑↓ move'))
    check('and it says how much of the tree matched', /\bof 6\b/.test(results), results)

    // Back to browsing, and ⌘R forward again.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    check('escape steps back to browsing before it closes', (host.textContent ?? '').includes('Go'))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', metaKey: true }))
    await settle()
    check('and ⌘R goes straight to the search', (host.textContent ?? '').includes('↑↓ move'))

    useStore.setState({ folderPicker: null, sessions: [session], activeSessionId: session.id })
  }

  section('a notice too long for one line')
  {
    // The regression: the label was shrink-0, so a notice of more than a few
    // words made the row wider than the chat and ran off the side of the
    // window. Measured rather than eyeballed.
    // The notice that actually ran off the window, first paragraph and all:
    // one long sentence is the case the old markup could not hold.
    const long =
      'This session is set to filter command output through rtk, but rtk cannot be used on ' +
      'wkstation: rtk is not on the PATH of this execution target. Install it with ' +
      '`brew install rtk`, then reopen this session.\n\n' +
      'Commands are running unfiltered.'
    useStore.setState({
      messages: {
        [session.id]: [
          {
            id: 'm-notice',
            sessionId: session.id,
            role: 'system',
            parts: [{ type: 'text', text: long }],
            createdAt: Date.now()
          }
        ]
      },
      activeSessionId: session.id
    })

    const host = mount(<ChatView session={session} />, 900)
    await settle()
    /*
     * Measured on the transcript's own scroller, not on the host: the scroller
     * clips what overflows it, so the page around it stays the right width
     * while the message itself sits off the side. scrollWidth > clientWidth
     * there is exactly the symptom — a horizontal scrollbar in the chat.
     */
    const scroller = (): HTMLElement =>
      [...host.querySelectorAll('div')].find((node) =>
        getComputedStyle(node).overflowY === 'auto'
      ) as HTMLElement
    check(
      'the notice stays inside the chat',
      scroller().scrollWidth <= scroller().clientWidth + 1,
      { scroll: scroller().scrollWidth, client: scroller().clientWidth }
    )
    check(
      'and the rest is held back rather than shown in full',
      !(host.textContent ?? '').includes('Commands are running unfiltered'),
      host.textContent
    )

    const opener = [...host.querySelectorAll('button')].find((button) =>
      (button.getAttribute('title') ?? '').startsWith('Read all of it')
    ) as HTMLButtonElement | undefined
    check('with a way to read all of it', Boolean(opener))
    opener?.click()
    await settle()
    const shown = host.textContent ?? ''
    check(
      'which shows the whole thing, first line included',
      shown.includes('Commands are running unfiltered') &&
        shown.includes('is set to filter command output')
    )
    check(
      'and says the first line once, not twice',
      shown.split('is set to filter command output').length - 1 === 1,
      shown.split('is set to filter command output').length - 1
    )
    check(
      'and still does not overflow when open',
      scroller().scrollWidth <= scroller().clientWidth + 1,
      { scroll: scroller().scrollWidth, client: scroller().clientWidth }
    )

    useStore.setState({ messages: {} })
  }

  section('what a message offers once it is said')
  {
    const said: Message[] = [
      {
        id: 'm-user',
        sessionId: session.id,
        role: 'user',
        parts: [{ type: 'text', text: 'quita este texto del chat' }],
        createdAt: Date.now()
      },
      {
        id: 'm-answer',
        sessionId: session.id,
        role: 'assistant',
        parts: [{ type: 'text', text: 'Done.' }],
        createdAt: Date.now(),
        completedAt: Date.now()
      }
    ]
    useStore.setState({ messages: { [session.id]: said }, activeSessionId: session.id })

    const idle = mount(<ChatView session={session} />, 900)
    await settle()
    check(
      'a finished answer from the manager names nobody',
      !(idle.textContent ?? '').includes('Manager'),
      idle.textContent
    )
    const buttons = (host: HTMLElement): HTMLButtonElement[] =>
      [...host.querySelectorAll('button')].filter((button) =>
        /^(Copy|Rewind|Fork)/.test(button.getAttribute('title') ?? '')
      ) as HTMLButtonElement[]

    const offered = buttons(idle)
    check('every message offers the three', offered.length === 6, offered.length)
    check(
      'and they are named for what they do',
      offered.slice(0, 3).map((button) => (button.getAttribute('title') ?? '').split(/[ :—]/)[0]).join() ===
        'Copy,Rewind,Fork',
      offered.slice(0, 3).map((b) => b.getAttribute('title'))
    )
    check('when the session is idle, rewind is available', !offered[1].disabled)
    check(
      'and says what it will do',
      (offered[1].getAttribute('title') ?? '').includes('back in the box'),
      offered[1].getAttribute('title')
    )
    check('the time it was said is there too', (idle.textContent ?? '').includes('just now'))
    check(
      'and the row is out of the way until the message is hovered',
      (offered[0].parentElement?.className ?? '').includes('opacity-0'),
      offered[0].parentElement?.className
    )

    const working = mount(<ChatView session={{ ...session, status: 'running' }} />, 900)
    await settle()
    const busy = buttons(working)
    check('while the model works, rewind is not offered', busy[1].disabled)
    check(
      'and the tooltip is the reason rather than the action',
      (busy[1].getAttribute('title') ?? '').includes('while the model is working'),
      busy[1].getAttribute('title')
    )
    check('copying is still fine', !busy[0].disabled)
    check('and so is forking', !busy[2].disabled)

    useStore.setState({ messages: {} })
  }


  section('the model that runs on this machine')
  {
    /*
     * The row is the whole feature as far as anyone using it is concerned:
     * what it will cost in gigabytes before it is pressed, how far it has got
     * while it downloads, and where it is answering once it is up. Each of
     * those is a different branch, so each one is mounted.
     */
    const host = mount(<LocalModelSection />, 900)
    await settle()
    const offered = host.textContent ?? ''
    check(
      'it says what it is and that nothing else has to be installed',
      offered.includes('On this machine') && offered.includes('no key, no account'),
      offered.slice(0, 120)
    )
    check(
      'the size is on the button, before anything is downloaded',
      offered.includes('Install (2.1 GB)'),
      offered.slice(-160)
    )
    check(
      'and the memory it wants while it answers is said too',
      offered.includes('3.4 GB'),
      offered
    )
    check(
      'nothing is configured yet, so there is nothing to say about it',
      !offered.includes('How it is configured')
    )

    // An interrupted download is the common case for two gigabytes on a
    // laptop, and it is resumed: the row offers what is left, not the lot.
    pushEvent({
      type: 'local.status',
      status: {
        ...(REPLIES['local.status'] as object),
        model: { installed: false, bytes: 0, partialBytes: 1_500_000_000 }
      }
    } as AppEvent)
    await settle()
    const resumable = host.textContent ?? ''
    check(
      'a download that was interrupted is offered as what is left of it',
      resumable.includes('Resume (605 MB)') && resumable.includes('1.5 GB of the weights'),
      resumable.slice(-220)
    )

    const downloading = mount(<LocalModelSection />, 900)
    await settle()
    // The bar comes from the event the main process pushes, not from a poll.
    const push = (status: unknown): void =>
      pushEvent({ type: 'local.status', status } as AppEvent)
    push({
      stage: 'installing',
      supported: true,
      spec: (REPLIES['local.status'] as { spec: unknown }).spec,
      runtime: { installed: true, build: 'b11026' },
      model: { installed: false, bytes: 1_000_000_000 },
      diskBytes: 1_011_000_000,
      progress: {
        what: 'model',
        label: 'Qwen2.5 3B Instruct',
        received: 1_052_466_384,
        total: 2_104_932_768
      }
    })
    await settle()
    const mid = downloading.textContent ?? ''
    check(
      'a download reports how far it has got, in both halves of the row',
      mid.includes('The weights — 1.1 GB of 2.1 GB') && mid.includes('50%'),
      mid
    )
    check(
      'and says the bytes are checked before anything runs',
      mid.includes('checksum'),
      mid
    )

    push({
      stage: 'running',
      supported: true,
      spec: (REPLIES['local.status'] as { spec: unknown }).spec,
      runtime: { installed: true, build: 'b11026', version: '11026' },
      model: { installed: true, bytes: 2_104_932_768 },
      diskBytes: 2_140_000_000,
      port: 51763
    })
    await settle()
    const up = downloading.textContent ?? ''
    check(
      'once it is up the row says where, and offers to stop it',
      up.includes('127.0.0.1:51763') && up.includes('Stop'),
      up
    )
    check(
      'and explains what the app configured, rather than asking for it',
      up.includes('How it is configured') && up.includes('local/qwen2.5-3b-instruct'),
      up
    )
    check('with the build it is running', up.includes('llama.cpp b11026'), up)
  }


  section('the context ring, and what it opens')
  {
    /*
     * A percentage is enough to know a summary is coming and not enough to do
     * anything about it: a conversation that is nine tenths tool schemas needs
     * fewer tools and one that is nine tenths transcript needs a summary, and
     * they look identical from the outside. So the ring is the glance and the
     * panel is the answer.
     */
    useStore.setState({
      config: {
        ...useStore.getState().config!,
        compactAtFraction: 0.7,
        keepRecentMessages: 8,
        provider: {
          p: {
            id: 'p',
            npm: '@ai-sdk/openai-compatible',
            name: 'P',
            options: {},
            models: { m: { id: 'm', name: 'M', contextWindow: 200_000, maxOutputTokens: 8_000 } }
          }
        }
      }
    })

    const measured = {
      ...session,
      contextTokens: 94_000,
      contextParts: { total: 96_000, messages: 78_000, system: 4_200, skills: 1_100 }
    } as Session
    const host = mount(<ContextMeter session={measured} />, 200)
    await settle()
    check(
      'the ring counts down to the summary rather than up to the window',
      (host.textContent ?? '').includes('71%'),
      host.textContent
    )
    check('and nothing else is shown until it is asked', !(host.textContent ?? '').includes('Messages'))

    const ring = host.querySelector('button')
    ring?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    const panel = host.textContent ?? ''
    check(
      'clicking it says what the window is made of',
      panel.includes('Context window') &&
        panel.includes('Messages') &&
        panel.includes('Tools and framing') &&
        panel.includes('System prompt'),
      panel.slice(0, 200)
    )
    check(
      'with the part that is skills, when any were named',
      panel.includes('Skills'),
      panel
    )
    check(
      'and how much room is left before it summarises, with the threshold',
      panel.includes('Room until a summary') && panel.includes('at 70%'),
      panel
    )
    /*
     * The panels are three sentences shorter than they were. What they said is
     * still there — a total the provider charged for against parts this app
     * estimated, and where the usage figures come from — but as tooltips: the
     * same explanation on every open is noise the second time.
     */
    check(
      'the estimate is admitted, without a paragraph about it',
      host.innerHTML.includes("app's estimate of it") &&
        !panel.includes('estimate of a total the provider charged'),
      panel
    )
    check(
      'usage is its own section, not mixed into the window',
      panel.includes('Usage this month'),
      panel
    )
    check(
      'and it lists every model that has been paid, this session’s or not',
      panel.includes('helmcode/glm5.3-flash') &&
        panel.includes('anthropic/claude-sonnet-5') &&
        panel.includes('local/qwen3-4b'),
      panel
    )
    check(
      'a model that costs nothing says so rather than showing $0.00',
      panel.includes('free'),
      panel
    )
    check('and one that costs something shows what', panel.includes('$3.42'), panel)

    // A session that has not run a turn yet: the ring is still there, because a
    // control that appears later is a control nobody finds.
    const fresh = mount(<ContextMeter session={{ ...session, contextTokens: 0 }} />, 200)
    await settle()
    fresh.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    check(
      'before a turn it says so in three words',
      (fresh.textContent ?? '').includes('Not measured yet'),
      fresh.textContent
    )
  }

  section('how hard to try')
  {
    const dial = mount(<EffortDial session={{ ...session, effort: 4 }} />, 200)
    await settle()
    check('the level is the whole label', (dial.textContent ?? '').trim() === 'High', dial.textContent)

    dial.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    const open = dial.textContent ?? ''
    check('the ends of the dial are named', open.includes('Faster') && open.includes('Smarter'), open)
    check(
      'there is one stop per level',
      dial.querySelectorAll('button').length === 1 + 5,
      dial.querySelectorAll('button').length
    )
    check(
      'a model with no reasoning setting shows the one thing that does change',
      /60 steps/.test(open) && /no thinking to set/.test(open),
      open
    )
    check(
      'and why, on hover rather than on screen',
      (dial.innerHTML ?? '').includes('declares no reasoning setting'),
      dial.innerHTML.slice(0, 400)
    )

    // The same dial on a model that does reason: now it says what it will ask for.
    const before = useStore.getState().config!
    useStore.setState({
      config: {
        ...before,
        provider: {
          p: {
            id: 'p',
            npm: '@ai-sdk/anthropic',
            name: 'P',
            options: {},
            models: { m: { id: 'm', name: 'M', contextWindow: 200_000, reasoning: true } }
          }
        }
      }
    })
    const thinking = mount(<EffortDial session={{ ...session, effort: 5 }} />, 200)
    await settle()
    thinking.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    const smart = thinking.textContent ?? ''
    check('at the top of the scale it is Max', smart.includes('Max'), smart)
    check(
      'and it says what it will ask the model for, in two numbers',
      /Thinking high/.test(smart) && /32k/.test(smart) && /60 steps/.test(smart),
      smart
    )
    useStore.setState({ config: before })
  }


  section('the footer with everything switched on')
  {
    /*
     * Reported from a real window: both savings switches on, auto-approve on,
     * and the right-hand end — model, effort, ring — dropped onto a second
     * line. The row is what it is on a 780px pane; what was wrong is that it
     * was allowed to wrap at all.
     */
    useStore.setState({
      config: {
        ...useStore.getState().config!,
        provider: {
          helmcode: {
            id: 'helmcode',
            npm: '@ai-sdk/openai-compatible',
            name: 'Helmcode',
            options: {},
            models: {
              'glm5.3-flash': {
                id: 'glm5.3-flash',
                name: 'GLM 5.3 Flash',
                contextWindow: 200_000,
                maxOutputTokens: 8_000,
                billing: 'flat',
                iq: 3,
                cost: 1
              }
            }
          }
        }
      },
      models: [{ ref: 'helmcode/glm5.3-flash', label: 'GLM 5.3 Flash', provider: 'Helmcode' }]
    })

    const loaded = {
      ...session,
      model: 'helmcode/glm5.3-flash',
      cwd: '/home/user/w',
      environmentId: 'local',
      contextTokens: 90_000,
      savings: { rtk: true, shunt: true },
      autoApprove: true
    } as Session

    for (const width of [560, 640, 780, 900]) {
      const host = mount(<Composer session={loaded} />, width)
      await settle()
      const row = host.querySelector('[data-footer]') as HTMLElement | null
      const right = host.querySelector('[data-footer-right]') as HTMLElement | null
      const rowBox = row?.getBoundingClientRect()
      const rightBox = right?.getBoundingClientRect()
      check(
        `at ${width}px the line does not wrap`,
        Boolean(rowBox && rightBox) && Math.abs(rightBox!.top - rowBox!.top) < 6,
        {
          drop: Math.round((rightBox?.top ?? 0) - (rowBox?.top ?? 0)),
          height: Math.round(rowBox?.height ?? 0),
          needs: row?.scrollWidth,
          has: row?.clientWidth
        }
      )
      check(
        `and it is one row tall at ${width}px`,
        (rowBox?.height ?? 99) < 30,
        Math.round(rowBox?.height ?? 0)
      )
      check(
        `with the model, the effort and the ring still on it at ${width}px`,
        /GLM 5.3 Flash/.test(right?.textContent ?? '') &&
          /Medium/.test(right?.textContent ?? '') &&
          /%/.test(right?.textContent ?? ''),
        right?.textContent
      )
    }

    // The path is what gives way, because it is the one thing here that is
    // long, repetitive and already in the title bar.
    const narrow = mount(
      <Composer session={{ ...loaded, cwd: '/home/user/w/sec/acme--global--core/services/quote' }} />,
      560
    )
    await settle()
    const row = narrow.querySelector('[data-footer]') as HTMLElement | null
    const right = narrow.querySelector('[data-footer-right]') as HTMLElement | null
    check(
      'a long path gives way rather than pushing the line into two',
      Math.abs(
        (right?.getBoundingClientRect().top ?? 0) - (row?.getBoundingClientRect().top ?? 0)
      ) < 6 && (row?.getBoundingClientRect().height ?? 99) < 30,
      {
        drop: Math.round(
          (right?.getBoundingClientRect().top ?? 0) - (row?.getBoundingClientRect().top ?? 0)
        ),
        height: Math.round(row?.getBoundingClientRect().height ?? 0)
      }
    )
    /*
     * What gave way, checked the way the older test does it: the words are
     * still in the markup, so textContent sees them — it is the computed
     * display that says whether anybody does.
     */
    const words = [...narrow.querySelectorAll('span')].find(
      (span) => span.textContent === 'Auto-approve'
    ) as HTMLElement | undefined
    check(
      'the words on the chips are what gave way',
      Boolean(words) && getComputedStyle(words!).display === 'none',
      words ? getComputedStyle(words).display : 'not in the markup'
    )
    check(
      'and the ring did not',
      /%/.test(narrow.querySelector('[data-footer-right]')?.textContent ?? ''),
      narrow.querySelector('[data-footer-right]')?.textContent
    )
  }


  section('a file handed over')
  {
    /*
     * What the person actually sees when a turn produces something: a card,
     * not a line saying "Ran 4 commands". The call itself is not drawn — it
     * would say the same thing twice, in the smaller of the two ways.
     */
    const handed = block({
      tool: 'deliver',
      title: 'the triage export and its chart',
      subtitle: '2 files',
      input: { paths: ['/home/user/w/report.csv', '/home/user/w/chart.png'] },
      output: 'report.csv — 91.5 KB\nchart.png — 45.3 KB'
    })
    const host = mount(<EditedFiles blocks={[handed]} />, 620)
    await settle()
    const text = host.textContent ?? ''
    check('both files get a card', text.includes('report.csv') && text.includes('chart.png'), text)
    check(
      'each said by its kind, which is what you look for',
      text.includes('CSV') && text.includes('PNG'),
      text
    )
    check(
      'and there is no diff row for them — a report is not a diff',
      !text.includes('+') || !/\+\d/.test(text),
      text
    )

    // A file that was written by the write tool and also handed over is one
    // card, not a card and a row.
    const both = mount(
      <EditedFiles
        blocks={[
          handed,
          block({ tool: 'write', input: { path: '/home/user/w/report.csv' }, added: 12 })
        ]}
      />,
      620
    )
    await settle()
    const twice = (both.textContent ?? '').split('report.csv').length - 1
    check('a file written and handed over is shown once', twice === 1, twice)

    // And a source file it edited on the way is still a diff row.
    const mixed = mount(
      <EditedFiles
        blocks={[handed, block({ tool: 'edit', input: { path: '/home/user/w/src/runner.ts' }, added: 8, removed: 2 })]}
      />,
      620
    )
    await settle()
    check(
      'while a source file it touched is still a diff',
      (mixed.textContent ?? '').includes('runner.ts') && /\+8/.test(mixed.textContent ?? ''),
      mixed.textContent
    )
  }


  section('tool servers, per session')
  {
    /*
     * The reason this is a per-session choice and not a setting: a tool is a
     * schema in the prefix of every step of every turn. So the chip is absent
     * when nothing is declared, and when something is, it says what carrying
     * it costs.
     */
    const withNone = mount(<ToolServerChip session={session} />, 300)
    await settle()
    check(
      'no chip at all when no server is declared',
      (withNone.textContent ?? '') === '',
      withNone.textContent
    )

    const before = useStore.getState().config!
    useStore.setState({
      config: {
        ...before,
        mcp: {
          tickets: { id: 'tickets', name: 'Tickets', command: 'npx', args: ['-y', 'x'] },
          broken: { id: 'broken', name: 'Broken', command: 'nope' }
        }
      }
    })

    const off = mount(<ToolServerChip session={session} />, 300)
    await settle()
    check('with servers declared it says none are on', (off.textContent ?? '').includes('No tools'), off.textContent)

    off.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    const panel = off.textContent ?? ''
    check('the panel lists them', panel.includes('Tickets') && panel.includes('Broken'), panel)
    check(
      'with what each one weighs, which is the whole point',
      panel.includes('2 tools · 1.9k tokens'),
      panel
    )
    check(
      'and says plainly when one would not start',
      panel.includes('would not start'),
      panel
    )
    check('and that off costs nothing', panel.includes('Off is free'), panel)

    const on = mount(<ToolServerChip session={{ ...session, mcp: ['tickets'] }} />, 300)
    await settle()
    check('a session carrying one says so', (on.textContent ?? '').includes('1 server'), on.textContent)
    on.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    check(
      'and the total it adds to every step is on the header',
      /\+1\.9k \/ step/.test(on.textContent ?? ''),
      on.textContent
    )

    useStore.setState({ config: before })
  }


  section('a file is not a website')
  {
    /*
     * The pane was showing the path twice — once in its address bar and once
     * in the header of the page the preview server renders — plus back,
     * forward, reload and home, which a file has no use for. So a file gets no
     * bar unless it is asked for, and a website still does.
     */
    const fileUrl =
      'http://127.0.0.1:61051/f/local/Users/diego.sanz/.opendesktop/check-output/report.md?t=abc'
    check(
      'a preview URL is recognised, and its file named',
      previewTitle(fileUrl) === 'report.md',
      previewTitle(fileUrl)
    )
    check('and a website is not', previewTitle('https://example.com/f/local/x') === null)
    check(
      'the path comes back decoded, not as %20',
      previewTarget('http://127.0.0.1:1/f/local/a%20b/c.md')?.path === '/a b/c.md',
      previewTarget('http://127.0.0.1:1/f/local/a%20b/c.md')?.path
    )

    useStore.setState({ browserUrl: fileUrl, browserChrome: null })
    const file = mount(<BrowserPane />, 420)
    await settle()
    check(
      'a file gets no address bar',
      file.querySelectorAll('input').length === 0,
      file.querySelectorAll('input').length
    )

    useStore.setState({ browserUrl: 'https://example.com', browserChrome: null })
    const site = mount(<BrowserPane />, 420)
    await settle()
    check('a website still gets one', site.querySelectorAll('input').length === 1)

    useStore.setState({ browserUrl: fileUrl, browserChrome: true })
    const asked = mount(<BrowserPane />, 420)
    await settle()
    check('and a file gets one when it is asked for', asked.querySelectorAll('input').length === 1)

    /*
     * The choice belongs to the kind of thing being looked at: going from a
     * file to a website brings the bar back on its own.
     */
    useStore.setState({ browserUrl: fileUrl, browserChrome: false })
    useStore.getState().setBrowserUrl('https://example.com')
    check(
      'and it resets when the kind changes',
      useStore.getState().browserChrome === null,
      useStore.getState().browserChrome
    )
    useStore.getState().setBrowserUrl(fileUrl)
    useStore.setState({ browserChrome: true })
    useStore.getState().setBrowserUrl(fileUrl.replace('report.md', 'report.pdf'))
    check(
      'but not when one file follows another',
      useStore.getState().browserChrome === true,
      useStore.getState().browserChrome
    )

    useStore.setState({ browserUrl: '', browserChrome: null })
  }


  section('hooks, as a page')
  {
    const before = useStore.getState().config!
    useStore.setState({
      config: {
        ...before,
        hooks: [
          {
            id: 'fmt',
            name: 'Format what was edited',
            event: 'after',
            matcher: 'write|edit',
            command: 'npx prettier --write "$OPENDESKTOP_PATH"'
          },
          { id: 'off', name: 'Stage it', event: 'after', command: 'git add .', enabled: false }
        ]
      }
    })
    const host = mount(<HooksTab />, 760)
    await settle()
    const text = host.textContent ?? ''
    check(
      'it says the bargain: no tokens, no attention',
      /costs no tokens/.test(text),
      text.slice(0, 200)
    )
    check(
      'each hook says when it fires and over which tools',
      text.includes('After a tool runs') && text.includes('write|edit'),
      text
    )
    check('and shows the command itself', text.includes('prettier'), text)
    check(
      'one that is switched off is still listed',
      text.includes('Stage it'),
      text
    )
    check(
      'and the examples are there, because thinking of one is the hard part',
      text.includes('Ones worth having') && text.includes('vendor/ is generated'),
      text.slice(-300)
    )
    useStore.setState({ config: before })
  }


  section('everything a conversation made is something to open')
  {
    /*
     * In a folder of its own there is no project to diff against: the file
     * exists because this conversation made it, so a .mobileconfig or a .sh is
     * exactly as much the point as a PDF would be. In somebody's repository
     * the old rule holds — a document opens, a source file diffs.
     */
    const root = '/Users/x/.opendesktop/workspaces'
    useStore.setState({ workspacesRoot: root })

    const inWorkspace = mount(
      <EditedFiles
        blocks={[
          block({ tool: 'write', input: { path: `${root}/abc/profile.mobileconfig` }, added: 40 }),
          block({ tool: 'write', input: { path: `${root}/abc/notes.md` }, added: 8 })
        ]}
      />,
      620
    )
    await settle()
    const workspaceText = inWorkspace.textContent ?? ''
    check(
      'a file with an extension nobody cards gets a card here',
      workspaceText.includes('profile.mobileconfig') && workspaceText.includes('MOBILECONFIG'),
      workspaceText
    )
    check('and so does the markdown', workspaceText.includes('notes.md'), workspaceText)
    check(
      'with no diff row for either, because there is nothing to diff against',
      !/\+40/.test(workspaceText),
      workspaceText
    )

    const inProject = mount(
      <EditedFiles
        blocks={[
          block({ tool: 'write', input: { path: '/Users/x/Dev/app/src/runner.ts' }, added: 40 }),
          block({ tool: 'write', input: { path: '/Users/x/Dev/app/REPORT.md' }, added: 8 })
        ]}
      />,
      620
    )
    await settle()
    const projectText = inProject.textContent ?? ''
    check(
      'in a project a source file is still a diff',
      projectText.includes('runner.ts') && /\+40/.test(projectText),
      projectText
    )
    check('while a document there is still a card', projectText.includes('REPORT.md'), projectText)

    useStore.setState({ workspacesRoot: '' })
  }


  section('the folder, said only when it is worth saying')
  {
    /*
     * `…/workspaces/94adVYh3JLDa` is an id nobody typed and nobody can use: it
     * says "somewhere" in twenty-six characters. Pointed at a repository, the
     * path is the most useful thing on the line.
     */
    const root = '/Users/x/.opendesktop/workspaces'
    useStore.setState({ workspacesRoot: root })

    const own = mount(<Composer session={{ ...session, cwd: `${root}/94adVYh3JLDa` }} />, 900)
    await settle()
    check(
      'its own folder shows the icon and no path',
      !(own.textContent ?? '').includes('94adVYh3JLDa') &&
        !(own.textContent ?? '').includes('workspaces'),
      own.textContent?.slice(0, 80)
    )
    const ownButton = [...own.querySelectorAll('button')].find((node) =>
      (node.getAttribute('title') ?? '').includes("conversation's own folder")
    )
    check('and says what it is on hover', Boolean(ownButton), ownButton?.getAttribute('title'))
    check(
      'while still being the way to point it somewhere else',
      (ownButton?.getAttribute('title') ?? '').includes('point it at a repository'),
      ownButton?.getAttribute('title')
    )

    const chosen = mount(<Composer session={{ ...session, cwd: '/home/user/w/sec' }} />, 900)
    await settle()
    check(
      'a chosen folder still shows its path',
      (chosen.textContent ?? '').includes('/sec'),
      chosen.textContent?.slice(0, 80)
    )

    useStore.setState({ workspacesRoot: '' })
  }


  section('what happened before now')
  {
    /*
     * The pane answered one question — what is different from the last commit —
     * which is only useful while you are the one making the difference. The
     * other half is the history, and in a conversation's own folder that *is*
     * the conversation: one commit per turn, subject the thing that was asked.
     */
    REPLIES['history.log'] = [
      {
        hash: 'a'.repeat(40),
        short: 'a1b2c3d',
        author: 'OpenDesktop',
        at: Date.now() - 60_000,
        parents: ['b'.repeat(40)],
        subject: 'Now say it differently'
      },
      {
        hash: 'b'.repeat(40),
        short: 'b4e5f6a',
        author: 'OpenDesktop',
        at: Date.now() - 600_000,
        parents: ['c'.repeat(40), 'd'.repeat(40)],
        subject: 'Write me a report about the thing'
      }
    ]
    REPLIES['history.commit'] = {
      commit: {
        hash: 'a'.repeat(40),
        short: 'a1b2c3d',
        author: 'OpenDesktop',
        at: Date.now() - 60_000,
        parents: ['b'.repeat(40)],
        subject: 'Now say it differently'
      },
      files: [{ path: 'report.md', status: 'M', added: 4, removed: 2, staged: false, untracked: false }],
      diff: 'diff --git a/report.md b/report.md\n@@ -1 +1 @@\n-# First\n+# Second\n'
    }
    REPLIES.changes = {
      isRepo: true,
      root: '/w',
      branch: 'main',
      files: [{ path: 'notes.md', status: 'M', added: 1, removed: 0, staged: false, untracked: false }],
      added: 1,
      removed: 0
    }
    useStore.setState({
      changes: REPLIES.changes as never,
      sessions: [session],
      activeSessionId: session.id
    })

    const host = mount(<ChangesPane />, 460)
    await settle()
    check(
      'it offers both halves, and starts on the working tree',
      (host.textContent ?? '').includes('working tree') && (host.textContent ?? '').includes('history'),
      host.textContent?.slice(0, 120)
    )
    check('with the working tree showing', (host.textContent ?? '').includes('notes.md'), host.textContent)

    const historyTab = [...host.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === 'history'
    )
    historyTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    const log = host.textContent ?? ''
    check(
      'the log reads as the conversation, one entry per turn',
      log.includes('Write me a report about the thing') && log.includes('Now say it differently'),
      log
    )
    check('with the short hash of each', log.includes('a1b2c3d'), log)

    const commit = [...host.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('Now say it differently')
    )
    commit?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    const detail = host.textContent ?? ''
    check(
      'picking one says who, when and what it touched',
      detail.includes('OpenDesktop') && detail.includes('report.md'),
      detail
    )
    check('with its counts', detail.includes('+4') && detail.includes('-2'), detail)

    const fileRow = [...host.querySelectorAll('button')].find((node) =>
      node.textContent?.includes('report.md')
    )
    fileRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
    const withDiff = host.textContent ?? ''
    check(
      'and opening the file shows that commit’s own diff, not the working tree’s',
      withDiff.includes('# Second'),
      withDiff.slice(-200)
    )
    check(
      'beside the two questions a diff cannot answer',
      withDiff.includes('history') && withDiff.includes('who wrote it'),
      withDiff.slice(-200)
    )

    delete REPLIES['history.log']
    delete REPLIES['history.commit']
    useStore.setState({ changes: null })
  }


  section('a folder that is not there, and one that is')
  {
    /*
     * Reported: opening the Files pane on a conversation whose folder had not
     * been made yet put `ENOENT: scandir` in front of the user. The folder is
     * made with the conversation now, and a folder that is missing anyway —
     * deleted, or on a host that went away — is a sentence in the pane.
     */
    const saved = REPLIES.list
    REPLIES.list = { path: '/w/gone', entries: [], error: 'no such file or directory' }
    const missing = mount(<FilesPane />, 420)
    await settle()
    check(
      'the pane says what happened instead of throwing',
      (missing.textContent ?? '').includes('no such file or directory'),
      missing.textContent?.slice(0, 120)
    )
    REPLIES.list = saved
  }

  section('read it or change it')
  {
    /*
     * A PDF is something to look at and a .ts is something to change, so the
     * click does the right one of the two — and the other is always on the
     * card, so the rule never has to be right.
     */
    check('a document opens in the viewer', opensInViewer('/w/report.pdf') && opensInViewer('/w/notes.md'))
    check(
      'and code opens in the editor',
      !opensInViewer('/w/runner.ts') && !opensInViewer('/w/main.tf') && !opensInViewer('/w/deploy.sh')
    )
    check('an extension nobody knows is treated as text', !opensInViewer('/w/profile.mobileconfig'))

    const card = mount(<DocumentCard path="/w/runner.ts" environmentId="local" />, 240)
    await settle()
    const actions = [...card.querySelectorAll('button')].map((node) => node.getAttribute('title') ?? '')
    check(
      'a code card opens the editor on its face and offers the viewer beside it',
      actions.some((title) => title === 'Open runner.ts in the editor') &&
        actions.some((title) => title === 'View runner.ts'),
      actions
    )

    const doc = mount(<DocumentCard path="/w/report.pdf" environmentId="local" />, 240)
    await settle()
    const docActions = [...doc.querySelectorAll('button')].map((node) => node.getAttribute('title') ?? '')
    check(
      'and a document the other way round',
      docActions.some((title) => title === 'Open report.pdf in the viewer') &&
        docActions.some((title) => title === 'Edit report.pdf'),
      docActions
    )
    check('with saving a copy still there', docActions.includes('Save a copy'), docActions)
  }

  section('the editor pane')
  {
    REPLIES.open = { text: 'const a = 1\n// and a comment\n' }
    useStore.setState({ editorFile: null })
    const empty = mount(<EditorPane />, 520)
    await settle()
    check(
      'with nothing open it says how to open something',
      (empty.textContent ?? '').includes('Nothing open'),
      empty.textContent?.slice(0, 80)
    )

    useStore.setState({ editorFile: { environmentId: 'local', path: '/w/app.ts' } })
    const host = mount(<EditorPane />, 520)
    await settle()
    const text = host.textContent ?? ''
    check('it shows the file it was given', text.includes('/w/app.ts'), text.slice(0, 120))
    check('and its contents', text.includes('const a = 1'), text)
    check('numbered, like an editor', text.includes('1') && text.includes('2'), text)
    check(
      'with the same colours the transcript uses for code',
      host.innerHTML.includes('text-violet') || host.innerHTML.includes('text-ok'),
      host.innerHTML.slice(0, 200)
    )
    const area = host.querySelector('textarea')
    check('and it is editable', Boolean(area) && !area?.readOnly)
    check(
      'saving is offered but disabled until something changes',
      Boolean(
        [...host.querySelectorAll('button')].find(
          (node) => (node.getAttribute('title') ?? '').startsWith('Save') && (node as HTMLButtonElement).disabled
        )
      ),
      [...host.querySelectorAll('button')].map((n) => n.getAttribute('title'))
    )

    delete REPLIES.open
    useStore.setState({ editorFile: null })
  }

  section('who else is in this file')
  {
    const bare = mount(<NeighbourBar session={session} />, 760)
    await settle()
    check(
      'nothing at all when no other chat has touched these files',
      (bare.textContent ?? '').trim() === '',
      bare.textContent
    )

    REPLIES['sessions.neighbours'] = [
      {
        sessionId: 's-other',
        title: 'Rename the export',
        status: 'running',
        live: true,
        shared: ['/tmp/project/src/shared.ts', '/tmp/project/src/index.ts']
      }
    ]
    const one = mount(<NeighbourBar session={session} />, 760)
    await settle()
    const line = one.textContent ?? ''
    check('one neighbour is named in the line itself', /Rename the export/.test(line), line)
    check('and said to be running now, which is the urgent case', /running now/.test(line), line)
    check('but the files are not, until it is opened', !/shared\.ts/.test(line), line)

    one.querySelector('button')?.click()
    await settle()
    const open = one.textContent ?? ''
    check('opening it lists the files both have changed', /shared\.ts/.test(open) && /index\.ts/.test(open), open)
    check(
      'by name, not by path: the point is to recognise one',
      !/tmp\/project/.test(open),
      open
    )

    REPLIES['sessions.neighbours'] = [
      { sessionId: 's-a', title: 'One', status: 'idle', live: false, shared: ['/tmp/project/a.ts'] },
      { sessionId: 's-b', title: 'Two', status: 'running', live: true, shared: ['/tmp/project/b.ts'] },
      {
        sessionId: 's-c',
        title: 'Three',
        status: 'running',
        live: true,
        shared: [],
        why: 'the coordinator thinks these are about the same thing'
      }
    ]
    const many = mount(<NeighbourBar session={session} />, 760)
    await settle()
    const counted = many.textContent ?? ''
    check('several are counted rather than listed', /3 other chats/.test(counted), counted)
    check('with how many of them are working now', /2 running/.test(counted), counted)

    many.querySelector('button')?.click()
    await settle()
    const all = many.textContent ?? ''
    check('and all three are there once opened', /One/.test(all) && /Two/.test(all) && /Three/.test(all))
    check(
      'a guessed one says why instead of naming a file it does not share',
      /about the same thing/.test(all),
      all
    )

    // A write anywhere is a reason to ask again: the answer is a fact about
    // the disk, and the disk just changed.
    REPLIES['sessions.neighbours'] = []
    pushEvent({ type: 'claims.updated', sessionId: 's-other' } as AppEvent)
    await settle()
    check(
      'and the line goes away by itself when the claim does',
      (many.textContent ?? '').trim() === '',
      many.textContent
    )
  }

  section('a branch of its own')
  {
    const onBranch: Session = {
      ...session,
      id: 's-wt',
      cwd: '/home/user/.opendesktop/worktrees/s-wt',
      worktree: {
        repoRoot: '/home/user/w/quotes',
        branch: 'opendesktop/rename-the-export-a1b2c3',
        base: 'deadbeef',
        createdAt: 0
      }
    }
    useStore.setState({ sessions: [session, onBranch] })
    const host = mount(<Composer session={onBranch} />, 900)
    await settle()
    const footer = (host.querySelector('[data-footer]') as HTMLElement | null)?.textContent ?? ''
    check(
      'the footer says the branch, not the path of the checkout',
      /rename-the-export/.test(footer) && !/worktrees/.test(footer),
      footer
    )

    REPLIES.changes = {
      isRepo: true,
      root: '/home/user/.opendesktop/worktrees/s-wt',
      branch: 'opendesktop/rename-the-export-a1b2c3',
      files: [],
      added: 0,
      removed: 0
    }
    REPLIES['sessions.worktree.status'] = { ahead: 3, dirty: 0 }
    const withCommits = mount(<Composer session={onBranch} />, 900)
    await settle()
    await settle()
    const bar = withCommits.textContent ?? ''
    check(
      'the bar stays on a branch of its own even with nothing uncommitted',
      /opendesktop\/rename-the-export/.test(bar),
      bar.slice(0, 160)
    )
    check(
      'and says how much of the branch this conversation wrote',
      /3 commits here/.test(bar),
      bar.slice(0, 160)
    )
    check(
      'named after the repository it was cut from, not the checkout',
      /quotes/.test(bar),
      bar.slice(0, 160)
    )
    REPLIES.changes = { isRepo: false, root: '', branch: '', files: [], added: 0, removed: 0 }
    delete REPLIES['sessions.worktree.status']

    // The offer belongs where the collision is, which is the only place
    // anybody is thinking about it.
    REPLIES['sessions.neighbours'] = [
      { sessionId: 's-x', title: 'Another chat', status: 'running', live: true, shared: ['/a/b.ts'] }
    ]
    useStore.setState({ workspacesRoot: '/home/user/.opendesktop/workspaces' })
    const clash = mount(<NeighbourBar session={{ ...session, cwd: '/home/user/w/quotes' }} />, 760)
    await settle()
    clash.querySelector('button')?.click()
    await settle()
    check(
      'a conversation in a repository is offered one where the clash is',
      /branch of its own/.test(clash.textContent ?? ''),
      clash.textContent
    )

    const already = mount(<NeighbourBar session={onBranch} />, 760)
    await settle()
    already.querySelector('button')?.click()
    await settle()
    check(
      'and one that already has a branch is not offered another',
      !/branch of its own/.test(already.textContent ?? ''),
      already.textContent
    )

    const own = mount(
      <NeighbourBar session={{ ...session, cwd: '/home/user/.opendesktop/workspaces/s1' }} />,
      760
    )
    await settle()
    own.querySelector('button')?.click()
    await settle()
    check(
      'nor is a conversation in its own folder, where there is nobody to avoid',
      !/branch of its own/.test(own.textContent ?? ''),
      own.textContent
    )

    REPLIES['sessions.neighbours'] = []
    useStore.setState({ sessions: [session] })
  }

  section('the two panes of the window')
  {
    /*
     * The chat and the dock sit side by side, so their edges are read
     * together — and they were written apart, which is how the dock's rounded
     * corner ended up eight pixels below the chat's. Measured rather than
     * compared as strings: the point is where they land, not what they say.
     */
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;width:900px;height:300px'
    row.innerHTML = `<div class="${PANE_FRAME}" style="flex:1"></div><div class="${PANE_FRAME}" style="width:300px"></div>`
    document.body.appendChild(row)
    await settle()
    const [left, right] = [...row.children].map((el) => el.getBoundingClientRect())
    check('the chat and the dock start at the same height', left.top === right.top, {
      chat: left.top,
      dock: right.top
    })
    check('and end at the same one', left.bottom === right.bottom, {
      chat: left.bottom,
      dock: right.bottom
    })
    check(
      'with the same gutter to the window on the outside of each',
      Math.round(left.left - row.getBoundingClientRect().left) ===
        Math.round(row.getBoundingClientRect().right - right.right),
      { before: left.left - row.getBoundingClientRect().left, after: row.getBoundingClientRect().right - right.right }
    )
    const source = PANE_FRAME
    check(
      'and neither is free to drift, because there is one of them',
      /\bmb-2\b/.test(source) && !/\bm-2\b/.test(source.replace(/mb-2|mr-2|ml-2|mt-2/g, '')),
      source
    )
  }

  section('reading back through a long answer')
  {
    /*
     * The bug this is here for: expand a command, scroll up a little to read,
     * and the view walks itself back to the bottom in small hops. Every step
     * below is one the user actually performs, in order, against a real
     * scroller with real layout.
     */
    const long: Message[] = []
    for (let i = 0; i < 24; i++) {
      long.push({
        id: `m${i}`,
        sessionId: session.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `Paragraph ${i}. ${'word '.repeat(60)}` }],
        createdAt: i * 1000,
        completedAt: i * 1000 + 500
      } as Message)
    }
    useStore.setState({ messages: { [session.id]: long } })

    const host = document.createElement('div')
    host.style.cssText = 'width:900px;height:420px;display:flex'
    document.body.appendChild(host)
    createRoot(host).render(<ChatView session={session} />)
    await settle()

    const el = host.querySelector('.overflow-y-auto') as HTMLElement
    const distance = (): number => el.scrollHeight - el.scrollTop - el.clientHeight
    check('it opens at the end, which is where the answer is', distance() <= 4, distance())

    // One gentle push of the wheel upwards. A trackpad gives a few pixels at
    // a time, which is exactly what the old 80px latch swallowed.
    el.scrollTop -= 30
    el.dispatchEvent(new Event('scroll'))
    const readingAt = el.scrollTop

    const grow = (id: string, text: string): void => {
      const list = useStore.getState().messages[session.id]
      useStore.setState({
        messages: {
          [session.id]: list.map((m) =>
            m.id === id ? { ...m, parts: [{ type: 'text', text: (m.parts[0].text ?? '') + text }] } : m
          )
        }
      })
    }

    grow('m23', ' and more output arrives')
    await settle()
    check('a token arriving does not drag you back down', el.scrollTop === readingAt, {
      was: readingAt,
      now: el.scrollTop
    })

    for (let i = 0; i < 4; i++) {
      grow('m23', ' still going')
      await settle()
    }
    check('nor do four of them, one hop at a time', el.scrollTop === readingAt, {
      was: readingAt,
      now: el.scrollTop
    })

    /*
     * Expanding a command grows the transcript without any scroll event: the
     * old latch never heard about it and still believed you were at the end.
     */
    el.scrollTop = el.scrollHeight
    await settle()
    check('back at the end, it follows again', distance() <= 4, distance())

    const filler = document.createElement('div')
    filler.style.height = '600px'
    ;(el.firstElementChild as HTMLElement).appendChild(filler)
    const afterExpanding = el.scrollTop
    grow('m23', ' one more line')
    await settle()
    check(
      'and something opening below you is not a reason to jump to the end',
      el.scrollTop === afterExpanding,
      { was: afterExpanding, now: el.scrollTop, distance: distance() }
    )

    filler.remove()
    el.scrollTop = el.scrollHeight
    await settle()
    const before = el.scrollTop
    useStore.setState({
      messages: {
        [session.id]: [
          ...useStore.getState().messages[session.id],
          {
            id: 'm-own',
            sessionId: session.id,
            role: 'user',
            parts: [{ type: 'text', text: 'And what about this?' }],
            createdAt: 99_000
          } as Message
        ]
      }
    })
    await settle()
    check('but your own message always takes you to the end', el.scrollTop > before && distance() <= 4, {
      before,
      now: el.scrollTop,
      distance: distance()
    })

    useStore.setState({ messages: {} })
  }

  section('the pentesting sandbox')
  {
    const built = mount(<SandboxSection />, 900)
    await settle()
    const shown = built.textContent ?? ''
    check('the sandbox section says the image is ready', /ready/.test(shown), shown.slice(0, 120))
    check('and lists the tools it ships', /nmap/.test(shown), shown.slice(0, 200))
    check('and warns there is no network until a target is named', /no network/i.test(shown), shown.slice(0, 200))

    // Docker missing: the row says so rather than offering a build.
    REPLIES['sandbox.status'] = {
      stage: 'absent',
      supported: false,
      imageBuilt: false,
      image: 'opendesktop/pentest:1',
      tools: [],
      message: 'Docker is not installed.'
    }
    const noDocker = mount(<SandboxSection />, 900)
    await settle()
    check('with Docker absent it says not available', /not available/.test(noDocker.textContent ?? ''), noDocker.textContent?.slice(0, 120))
    REPLIES['sandbox.status'] = {
      stage: 'ready',
      supported: true,
      imageBuilt: true,
      image: 'opendesktop/pentest:1',
      tools: [{ name: 'nmap', blurb: 'Ports' }]
    }

    // The hard gate: offline until authorised, then it names the target.
    const offline = mount(<ScopeGate session={{ ...session, environmentId: 'sandbox' }} />, 760)
    await settle()
    check('an unauthorised sandbox session shows it is offline', /Offline sandbox/.test(offline.textContent ?? ''), offline.textContent?.slice(0, 120))
    check('and offers to authorise a target', /Authorise/.test(offline.textContent ?? ''))

    const authorised = mount(
      <ScopeGate
        session={{
          ...session,
          environmentId: 'sandbox',
          sandbox: { targets: ['scanme.example.com'], authorizedAt: 1, authorizedNote: 'mine' }
        }}
      />,
      760
    )
    await settle()
    const auth = authorised.textContent ?? ''
    check('an authorised session names exactly what it may reach', /scanme\.example\.com/.test(auth), auth.slice(0, 160))
    check('and everything else is dropped', /everything else is dropped/.test(auth), auth.slice(0, 200))

    // The flight recorder line: it says it is watching, and surfaces the worst
    // thing recorded so far.
    REPLIES['sandbox.forensics'] = {
      sessionId: 's1',
      samples: 12,
      window: { from: 1, to: 2 },
      findings: [{ severity: 'info', what: 'Nothing anomalous in the recording.' }]
    }
    const watching = mount(<ForensicLine session={{ ...session, environmentId: 'sandbox' }} />, 760)
    await settle()
    const w = watching.textContent ?? ''
    check('the forensics line says it is watching and counts samples', /Watching/.test(w) && /12 samples/.test(w), w)

    REPLIES['sandbox.forensics'] = {
      sessionId: 's1',
      samples: 5,
      findings: [
        { severity: 'alert', what: 'Traffic was dropped while no scope was authorised.' },
        { severity: 'info', what: 'noise' }
      ]
    }
    const breach = mount(<ForensicLine session={{ ...session, environmentId: 'sandbox' }} />, 760)
    await settle()
    check(
      'and it surfaces the worst finding when there is one',
      /no scope was authorised/.test(breach.textContent ?? ''),
      breach.textContent?.slice(0, 160)
    )
    REPLIES['sandbox.forensics'] = { sessionId: 's1', samples: 0, findings: [] }
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`)
  if (failures.length > 0) {
    console.log(`\nfailed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  }
  /*
   * A last frame for the eye, when asked for. The assertions above say the
   * dialog contains the right things; they cannot say it looks right, and this
   * one was drawn from a picture.
   */
  if (new URLSearchParams(location.search).get('shot') === 'models') {
    // Everything mounted above is still in the page, so the shot would be of
    // whatever happened to be at the top of it.
    document.body.innerHTML = ''
    useStore.setState({
      config: {
        ...useStore.getState().config!,
        provider: {
          anthropic: {
            id: 'anthropic',
            npm: '@ai-sdk/anthropic',
            name: 'Anthropic',
            options: { apiKey: '{secret:anthropic}' },
            allowance: { usd: 400, period: 'month' },
            models: {
              'claude-opus-5': {
                id: 'claude-opus-5',
                name: 'Claude Opus 5',
                price: { input: 5, output: 25 },
                billing: 'allowance',
                iq: 5,
                cost: 4
              },
              'claude-sonnet-5': {
                id: 'claude-sonnet-5',
                name: 'Claude Sonnet 5',
                price: { input: 2, output: 10 },
                billing: 'allowance',
                iq: 4,
                cost: 3
              },
              'claude-haiku-4-5': {
                id: 'claude-haiku-4-5',
                name: 'Claude Haiku 4.5',
                price: { input: 1, output: 5 },
                billing: 'allowance',
                iq: 3,
                cost: 2
              }
            }
          },
          helmcode: {
            id: 'helmcode',
            npm: '@ai-sdk/openai-compatible',
            name: 'Helmcode',
            options: { baseURL: 'https://api.helmcode.com/v1', apiKey: '{secret:helmcode}' },
            models: {
              'glm5.3-flash': {
                id: 'glm5.3-flash',
                name: 'GLM 5.3 Flash',
                billing: 'flat',
                iq: 3,
                cost: 1
              }
            }
          }
        }
      }
    })
    mount(<ModelsTab />, 900)
    await settle()
    // The local row in the state worth looking at: installed and answering.
    pushEvent({
      type: 'local.status',
      status: {
        stage: 'running',
        supported: true,
        spec: (REPLIES['local.status'] as { spec: never }).spec,
        runtime: { installed: true, build: 'b11026', version: '11026' },
        model: { installed: true, bytes: 2_104_932_768 },
        diskBytes: 2_140_000_000,
        port: 51763
      }
    } as AppEvent)
    await settle()
  }

  // The footer as it actually sits under the composer, with both panels open.
  if (new URLSearchParams(location.search).get('shot') === 'footer') {
    document.body.innerHTML = ''
    useStore.setState({
      config: {
        ...useStore.getState().config!,
        compactAtFraction: 0.7,
        keepRecentMessages: 8,
        maxSteps: 60,
        provider: {
          helmcode: {
            id: 'helmcode',
            npm: '@ai-sdk/openai-compatible',
            name: 'Helmcode',
            options: {},
            models: {
              'glm5.3-flash': {
                id: 'glm5.3-flash',
                name: 'GLM 5.3 Flash',
                contextWindow: 200_000,
                maxOutputTokens: 8_000
              }
            }
          }
        }
      },
      models: [{ ref: 'helmcode/glm5.3-flash', label: 'GLM 5.3 Flash', provider: 'Helmcode' }]
    })
    const shot = {
      ...session,
      model: 'helmcode/glm5.3-flash',
      cwd: '/home/user/w/sec/acme--global--core',
      contextTokens: 94_000,
      effort: 4,
      contextParts: { total: 96_400, messages: 78_000, system: 4_200 }
    } as Session
    // The composer where it lives — at the bottom — so the panels have the room
    // above them that they have in the app.
    const host = mount(
      <div className="flex h-[620px] w-[820px] flex-col justify-end p-6">
        <Composer session={shot} />
      </div>
    )
    await settle()
    // Both panels, so the shot shows what a click gets you.
    for (const button of Array.from(host.querySelectorAll('button')).slice(-3)) {
      const label = button.textContent ?? ''
      if (label.includes('High') || label.includes('%')) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await settle()
      }
    }
  }

  // The line with both switches, auto-approve and a workstation on it, at the
  // width where it used to wrap.
  if (new URLSearchParams(location.search).get('shot') === 'loaded') {
    document.body.innerHTML = ''
    useStore.setState({
      config: {
        ...useStore.getState().config!,
        environment: {
          local: { id: 'local', name: 'Local', kind: 'local' },
          wk: { id: 'wk', name: 'wkstation', kind: 'gcp-workstation' }
        },
        provider: {
          helmcode: {
            id: 'helmcode',
            npm: '@ai-sdk/openai-compatible',
            name: 'Helmcode',
            options: {},
            models: {
              'glm5.3-flash': {
                id: 'glm5.3-flash',
                name: 'GLM 5.3 Flash',
                contextWindow: 200_000,
                maxOutputTokens: 8_000,
                billing: 'flat',
                iq: 3,
                cost: 1
              }
            }
          }
        }
      },
      models: [{ ref: 'helmcode/glm5.3-flash', label: 'GLM 5.3 Flash', provider: 'Helmcode' }]
    })
    mount(
      <div className="w-[780px] p-5">
        <Composer
          session={
            {
              ...session,
              model: 'helmcode/glm5.3-flash',
              environmentId: 'wk',
              cwd: '/home/user/w',
              contextTokens: 90_000,
              savings: { rtk: true, shunt: true },
              autoApprove: true
            } as Session
          }
        />
      </div>
    )
    await settle()
  }

  // The editor, with a file in it.
  if (new URLSearchParams(location.search).get('shot') === 'editor') {
    document.body.innerHTML = ''
    REPLIES.open = {
      text: [
        'export function workspacePath(sessionId: string): string {',
        '  // Beside the models and the runtime.',
        "  return join(WORKSPACES_DIR, sessionId)",
        '}',
        '',
        'const KEEP = 3',
        ''
      ].join('\n')
    }
    useStore.setState({ editorFile: { environmentId: 'local', path: '/Users/x/Dev/app/src/workspace.ts' } })
    mount(
      <div className="border-ink-800 bg-ink-850 m-2 flex h-[300px] w-[560px] flex-col overflow-hidden rounded-lg border">
        <div className="border-ink-800 flex h-10 shrink-0 items-center gap-2 border-b px-3">
          <span className="text-ink-200 text-[12.5px]">workspace.ts</span>
        </div>
        <EditorPane />
      </div>
    )
    await settle()
  }

  // The pane showing a file, with and without its address bar.
  if (new URLSearchParams(location.search).get('shot') === 'viewer') {
    document.body.innerHTML = ''
    const fileUrl =
      'http://127.0.0.1:61051/f/local/Users/diego.sanz/.opendesktop/check-output/report.md?t=abc'
    useStore.setState({
      browserUrl: fileUrl,
      browserChrome: null,
      dock: { ...useStore.getState().dock, open: true, tab: 'browser', width: 460 }
    })
    mount(
      <div className="flex h-[280px] w-[460px] flex-col">
        <div className="border-ink-800 bg-ink-850 m-2 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border">
          <div className="border-ink-800 flex h-10 shrink-0 items-center gap-2 border-b px-3">
            <span className="text-ink-200 min-w-0 truncate text-[12.5px]">
              {previewTitle(fileUrl)}
            </span>
          </div>
          <BrowserPane />
        </div>
      </div>
    )
    await settle()
  }

  // The tool servers page, with one that answered and one that would not start.
  if (new URLSearchParams(location.search).get('shot') === 'tools') {
    document.body.innerHTML = ''
    useStore.setState({
      config: {
        ...useStore.getState().config!,
        mcp: {
          tickets: { id: 'tickets', name: 'Tickets', command: 'npx', args: ['-y', 'tickets-mcp'] },
          broken: { id: 'broken', name: 'Broken', command: 'nope', args: [] }
        }
      }
    })
    mount(
      <div className="w-[760px] p-6">
        <ToolServersTab />
      </div>
    )
    await settle()
  }

  // The box on its own, to check that the line of text sits in the middle of it.
  if (new URLSearchParams(location.search).get('shot') === 'input') {
    document.body.innerHTML = ''
    mount(
      <div className="w-[560px] p-5">
        <Composer session={{ ...session, model: 'p/m' }} />
      </div>
    )
    await settle()
  }

  // The effort dial open, which is the other thing that line does.
  if (new URLSearchParams(location.search).get('shot') === 'effort') {
    document.body.innerHTML = ''
    useStore.setState({
      config: {
        ...useStore.getState().config!,
        maxSteps: 60,
        provider: {
          anthropic: {
            id: 'anthropic',
            npm: '@ai-sdk/anthropic',
            name: 'Anthropic',
            options: {},
            models: {
              'claude-sonnet-5': {
                id: 'claude-sonnet-5',
                name: 'Claude Sonnet 5',
                contextWindow: 1_000_000,
                maxOutputTokens: 128_000,
                reasoning: true
              }
            }
          }
        }
      },
      models: [{ ref: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'Anthropic' }]
    })
    const shot = {
      ...session,
      model: 'anthropic/claude-sonnet-5',
      cwd: '/home/user/w/sec/acme--global--core',
      contextTokens: 210_000,
      effort: 4
    } as Session
    const host = mount(
      <div className="flex h-[420px] w-[820px] flex-col justify-end p-6">
        <Composer session={shot} />
      </div>
    )
    await settle()
    for (const button of Array.from(host.querySelectorAll('button'))) {
      if ((button.textContent ?? '').trim() === 'High') {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await settle()
        break
      }
    }
  }

  // The local row on its own, in the state that has the most to say.
  if (new URLSearchParams(location.search).get('shot') === 'local') {
    document.body.innerHTML = ''
    mount(<LocalModelSection />, 900)
    await settle()
    pushEvent({
      type: 'local.status',
      status: {
        stage: 'installing',
        supported: true,
        spec: (REPLIES['local.status'] as { spec: never }).spec,
        runtime: { installed: true, build: 'b11026' },
        model: { installed: false, bytes: 1_262_959_660 },
        diskBytes: 1_298_000_000,
        progress: {
          what: 'model',
          label: 'Qwen2.5 3B Instruct',
          received: 1_262_959_660,
          total: 2_104_932_768
        }
      }
    } as AppEvent)
    await settle()
  }

  if (new URLSearchParams(location.search).get('shot') === 'neighbours') {
    document.body.innerHTML = ''
    REPLIES['sessions.neighbours'] = [
      {
        sessionId: 's-a',
        title: 'Rename the export in shared.ts',
        status: 'running',
        live: true,
        shared: ['/tmp/project/src/shared.ts', '/tmp/project/src/index.ts']
      },
      {
        sessionId: 's-b',
        title: 'Document the new flags',
        status: 'idle',
        live: false,
        shared: ['/tmp/project/README.md']
      }
    ]
    const host = mount(<div className="bg-ink-900 p-4" />, 760)
    await settle()
    createRoot(host.firstElementChild as HTMLElement).render(<NeighbourBar session={session} />)
    await settle()
    host.querySelector('button')?.click()
    await settle()
  }

  if (new URLSearchParams(location.search).get('shot') === 'routing') {
    document.body.innerHTML = ''
    mount(<RoutingTab />, 900)
    await settle()
  }

  if (new URLSearchParams(location.search).get('shot') === 'picker') {
    const shot = { ...session, id: 's-shot', environmentId: 'wk', cwd: '/home/user/w/sec' }
    useStore.setState({
      sessions: [shot],
      activeSessionId: shot.id,
      folderPicker: { sessionId: shot.id, mode: 'browse' }
    })
    mount(<FolderPicker />)
    await settle()
  }

  // Anything the page threw counts too, even when every assertion held: an
  // uncaught error is a broken render that happened to miss what was checked.
  const thrown = (window as unknown as { __pageErrors?: number }).__pageErrors ?? 0
  if (thrown > 0) console.log(`\nand ${thrown} error${thrown === 1 ? '' : 's'} reached the page`)
  ;(window as unknown as { __uiCheck: number }).__uiCheck = failures.length + thrown
}

void run().catch((err: Error) => {
  console.log(`CRASHED: ${err.stack ?? err.message}`)
  ;(window as unknown as { __uiCheck: number }).__uiCheck = 1
})
