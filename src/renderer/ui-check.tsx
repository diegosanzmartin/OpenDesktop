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
import type { ApprovalRequest, Block, Session } from '@shared/types'
import { useStore } from './src/state/store'
import { BlockCard } from './src/components/BlockCard'
import { ApprovalCard } from './src/components/ApprovalCard'
import { Mentions } from './src/components/Markdown'
import { DocumentCard } from './src/components/DocumentCard'
import { Composer } from './src/components/Composer'
import { ContextGauge } from './src/components/ContextGauge'

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
    // screenshot on a wide monitor would reveal.
    const wide = mount(<Composer session={session} />, 900)
    const narrow = mount(<Composer session={session} />, 420)
    await settle()

    const hintIn = (host: HTMLElement): HTMLElement | undefined =>
      [...host.querySelectorAll('span')].find((span) =>
        (span.textContent ?? '').startsWith('type @ to put')
      ) as HTMLElement | undefined

    const wideHint = hintIn(wide)
    const narrowHint = hintIn(narrow)
    check('the hint is in the markup either way', Boolean(wideHint) && Boolean(narrowHint))
    if (wideHint && narrowHint) {
      check(
        'shown when the pane is wide',
        getComputedStyle(wideHint).display !== 'none',
        getComputedStyle(wideHint).display
      )
      check(
        'and hidden when it is narrow',
        getComputedStyle(narrowHint).display === 'none',
        getComputedStyle(narrowHint).display
      )
    }
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed`)
  if (failures.length > 0) {
    console.log(`\nfailed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
  }
  ;(window as unknown as { __uiCheck: number }).__uiCheck = failures.length
}

void run().catch((err: Error) => {
  console.log(`CRASHED: ${err.stack ?? err.message}`)
  ;(window as unknown as { __uiCheck: number }).__uiCheck = 1
})
