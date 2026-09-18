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
import { ContextMeter } from './src/components/ContextMeter'
import { EffortDial } from './src/components/EffortDial'
import { ModelsTab } from './src/components/ModelsTab'
import { RoutingTab } from './src/components/RoutingTab'
import { FolderPicker } from './src/components/FolderPicker'
import { LocalModelSection } from './src/components/LocalModelSection'
import { ChatView } from './src/components/ChatView'

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
      permissions: { bash: 'ask', edit: 'ask', write: 'ask', read: 'allow', fetch: 'ask', allowlist: [], denylist: [] },
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
      target: { value: 'hgsj' }
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
