import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import type { LanguageModel } from 'ai'
import { beforeAll, describe, expect, test } from 'vitest'
import { askAside } from '../src/main/aside'
import { runTurn } from '../src/main/agent/runner'
import { DATA_DIR, loadConfig, saveConfig } from '../src/main/config'
import { setModelResolverOverride } from '../src/main/providers'
import * as store from '../src/main/store'
import { boot, newSession, scriptedModel, tempDir, useModel, type Captured } from './helpers'

beforeAll(boot)

const said = (step: Captured): string => JSON.stringify(step.prompt)
const historyOf = (id: string): string => readFileSync(join(DATA_DIR, 'history', `${id}.json`), 'utf8')

/** One model for the turn, another for the side question, told apart by what they are asked. */
function routing(turn: LanguageModel, aside: LanguageModel, marker: string): LanguageModel {
  type Streaming = { doStream: (params: unknown) => Promise<unknown> }
  return new MockLanguageModelV4({
    doStream: async (params: Record<string, unknown>) =>
      (JSON.stringify(params.prompt).includes(marker) ? (aside as unknown as Streaming) : (turn as unknown as Streaming)).doStream(
        params
      ) as never
  }) as unknown as LanguageModel
}

describe('a side question (/btw)', () => {
  // After Claude Code's /btw: it sees the conversation, and the conversation never sees it.
  test('is answered from the conversation, with no tools, and leaves no trace in it', async () => {
    const session = newSession({ autoApprove: true })
    useModel(scriptedModel([{ text: 'The port is 4317.' }]))
    await runTurn({ sessionId: session.id, userText: 'which port does the server use?' })
    const messagesBefore = store.listMessages(session.id).length
    const historyBefore = historyOf(session.id)

    const seen: Captured[] = []
    useModel(scriptedModel([{ text: 'It said 4317.' }], seen))
    const answer = await askAside(session.id, 'what port did you say?')

    expect(answer).toEqual({ text: 'It said 4317.' })
    expect(seen).toHaveLength(1)
    expect(said(seen[0])).toContain('The port is 4317.')
    expect(said(seen[0])).toContain('what port did you say?')
    expect(seen[0].tools ?? []).toHaveLength(0)
    expect(store.listMessages(session.id)).toHaveLength(messagesBefore)
    expect(historyOf(session.id)).toBe(historyBefore)
  })

  test('asked while a turn works, it sees that turn so far, and the turn never sees it', async () => {
    const session = newSession({ autoApprove: true })
    const turnSaw: Captured[] = []
    const asideSaw: Captured[] = []
    const marker = 'how far along are you?'
    useModel(
      routing(
        scriptedModel(
          [
            { calls: [{ tool: 'bash', input: { command: 'echo step-one', description: 'one' } }] },
            { calls: [{ tool: 'bash', input: { command: 'sleep 0.6', description: 'wait' } }] },
            { text: 'All done.' }
          ],
          turnSaw
        ),
        scriptedModel([{ text: 'Step one ran; now waiting.' }], asideSaw),
        marker
      )
    )
    const turn = runTurn({ sessionId: session.id, userText: 'do the steps' })
    // Asked once the second call is under way, whatever the machine's load.
    for (let i = 0; i < 100 && !store.listBlocks(session.id).some((b) => b.title.includes('sleep')); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const answer = await askAside(session.id, marker)
    await turn

    expect(answer).toEqual({ text: 'Step one ran; now waiting.' })
    expect(said(asideSaw[0])).toContain('step-one')
    expect(turnSaw.some((step) => said(step).includes(marker))).toBe(false)
    expect(historyOf(session.id)).not.toContain(marker)
    expect(store.getSession(session.id)?.status).toBe('idle')
  })

  // Found live: asked during a long command, it answered that nothing was running.
  test('knows what is running right now, not only what has finished', async () => {
    const session = newSession({ autoApprove: true })
    const asideSaw: Captured[] = []
    const marker = 'what are you running?'
    useModel(
      routing(
        scriptedModel([{ calls: [{ tool: 'bash', input: { command: 'sleep 0.6 && echo mark-41', description: 'wait' } }] }, { text: 'ok' }]),
        scriptedModel([{ text: 'A sleep.' }], asideSaw),
        marker
      )
    )
    const turn = runTurn({ sessionId: session.id, userText: 'wait a bit' })
    for (let i = 0; i < 100 && !store.listBlocks(session.id).some((b) => b.status === 'running'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await askAside(session.id, marker)
    await turn
    expect(said(asideSaw[0])).toContain('sleep 0.6 && echo mark-41')
  })

  // Found live: the raw config went to the provider, so a `{file:…}` key was sent as written.
  test('reaches the provider with its key read from where the config points', async () => {
    const seenKeys: string[] = []
    const chunk = (delta: Record<string, unknown>, finish: string | null) =>
      `data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const server = createServer((req, res) => {
      seenKeys.push(String(req.headers.authorization))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(chunk({ role: 'assistant', content: 'from the provider' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const keyFile = join(tempDir('od-key-'), 'key')
    writeFileSync(keyFile, 'sk-side-123\n')
    const original = loadConfig()
    saveConfig({
      ...original,
      provider: {
        ...original.provider,
        fake: {
          id: 'fake',
          npm: '@ai-sdk/openai-compatible',
          name: 'Fake',
          options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: `{file:${keyFile}}` },
          models: { m: { id: 'm', name: 'M' } }
        }
      }
    })
    setModelResolverOverride(null)
    try {
      const session = newSession({ model: 'fake/m' })
      const answer = await askAside(session.id, 'anything?')
      expect(answer).toEqual({ text: 'from the provider' })
      expect(seenKeys).toEqual(['Bearer sk-side-123'])
    } finally {
      saveConfig(original)
      server.close()
    }
  })

  test('a failure comes back as an error to show, not a thrown one', async () => {
    const session = newSession({ autoApprove: true })
    useModel(
      new MockLanguageModelV4({
        doStream: async () => {
          throw new Error('provider down')
        }
      }) as unknown as LanguageModel
    )
    const answer = await askAside(session.id, 'anything?')
    expect('error' in answer && answer.error).toMatch(/provider down/)
  })
})
