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
import type { ApprovalRequest, Block, Message, Session } from '@shared/types'
import { useStore } from './src/state/store'
import { BlockCard } from './src/components/BlockCard'
import { ApprovalCard } from './src/components/ApprovalCard'
import { Mentions } from './src/components/Markdown'
import { DocumentCard } from './src/components/DocumentCard'
import { Composer } from './src/components/Composer'
import { ContextGauge } from './src/components/ContextGauge'
import { ModelsTab } from './src/components/ModelsTab'
import { FolderPicker } from './src/components/FolderPicker'
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
  status: { available: true, names: [], failed: [], hints: {} }
}

function stubBridge(): void {
  const node = (name: string): unknown =>
    new Proxy(function stub() {} as unknown as Record<string, unknown>, {
      get: (_target, key) => (key === 'then' ? undefined : node(String(key))),
      apply: () => Promise.resolve(REPLIES[name] ?? null)
    })
  ;(window as unknown as { opendesktop: unknown }).opendesktop = node('root')
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
      mount(<ContextGauge session={{ ...session, contextTokens }} />)

    const half = at(94_000)
    await settle()
    check('shows the share of the usable window', (half.textContent ?? '').includes('50%'), half.textContent)
    check('and is calm well below the threshold', !half.innerHTML.includes('text-warn'))

    const full = at(150_000)
    await settle()
    check('warns once past the point it will summarise', full.innerHTML.includes('text-warn'), full.textContent)

    const silent = at(undefined)
    await settle()
    check('says nothing before a turn has been measured', (silent.textContent ?? '') === '', silent.textContent)

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
      'delegating to the session\u2019s own model says so',
      (same.textContent ?? '').includes('no cheaper model'),
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
    check('the switches have a home of their own', text.includes('Savings'), text.slice(0, 120))
    check(
      'and each model carries the two judgements',
      text.includes('Cost') && text.includes('cheap') && text.includes('strong'),
      text.includes('Cost')
    )
    check(
      'every way of paying is offered',
      text.includes('Pay as you go') && text.includes('Flat rate') && text.includes('Included allowance')
    )
    check(
      'and the routing says what it currently decides',
      /reading and boilerplate → p\/cheap/.test(text) && /plans → p\/brain/.test(text),
      text.slice(text.indexOf('As it stands'), text.indexOf('As it stands') + 200)
    )
    check(
      'with the reason, so the choice is not a mystery',
      text.includes('already paid for'),
      text
    )

    const sliders = host.querySelectorAll('button[aria-label$="of 5"]')
    check('the judgements are coarse on purpose — five steps', sliders.length === 20, sliders.length)

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

  console.log(`\n${checks - failures.length}/${checks} checks passed`)
  if (failures.length > 0) {
    console.log(`\nfailed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  }
  /*
   * A last frame for the eye, when asked for. The assertions above say the
   * dialog contains the right things; they cannot say it looks right, and this
   * one was drawn from a picture.
   */
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
