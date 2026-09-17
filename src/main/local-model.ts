/**
 * A model that runs here, supervised by the app that uses it.
 *
 * The thing people install for this is Ollama: a second application, its own
 * launch agent, its own model directory, its own update cycle — and an app that
 * then has to hope it is running. What is actually wanted is narrower than
 * Ollama and can be owned outright: one `llama-server` child process listening
 * on localhost, speaking the OpenAI shape the rest of this app already speaks,
 * started when a model is asked for and stopped when nothing is.
 *
 * So there is nothing to install by hand. This module fetches the pinned
 * llama.cpp build and one curated GGUF, verifies both against the hashes in
 * `@shared/local-model` before anything is executed, declares the provider in
 * the config itself, and supervises the process. The only manual step left is
 * pressing the button that says how many gigabytes it is about to use.
 *
 * Two parts of this deliberately copy code that already exists here: the
 * verify-then-extract rules come from the rtk installer, and the
 * spawn-and-watch-for-a-port shape comes from the workstation tunnel. Neither
 * is worth a new opinion.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  writeFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  LLAMA_BUILD,
  LOCAL_BASE_URL,
  LOCAL_MODELS,
  LOCAL_PROVIDER_ID,
  formatBytes,
  llamaBinaryFor,
  llamaUrl,
  localModelEntry,
  localSpec,
  modelUrl,
  type LlamaBinary,
  type LocalModelSpec,
  type LocalModelStatus,
  type LocalProgress,
  type LocalStage
} from '@shared/local-model'
import type { ProviderConfig } from '@shared/types'
import { bus } from './bus'
import { loadConfig, saveConfig } from './config'
import { logLine } from './log'
import { toolEnvironment } from './tool-env'

/* ---------------- where it all lives ---------------- */

const ROOT = process.env.OPENDESKTOP_HOME

/**
 * Its own directory, next to the one rtk is provisioned into, and overridable
 * the same way the config root is — a test that exercises the installer must
 * not download onto the home directory of whoever is running it.
 */
export const LOCAL_DIR = ROOT ? join(ROOT, 'local') : join(homedir(), '.opendesktop')
export const RUNTIME_DIR = join(LOCAL_DIR, 'llama')
export const MODELS_DIR = join(LOCAL_DIR, 'models')

const EXE = process.platform === 'win32' ? '.exe' : ''

function buildDir(): string {
  return join(RUNTIME_DIR, LLAMA_BUILD)
}

export function serverBinary(): string {
  return join(buildDir(), `llama-server${EXE}`)
}

export function modelPath(spec: LocalModelSpec): string {
  return join(MODELS_DIR, spec.file)
}

/** Where the running server's key is kept, for as long as it is running. */
function keyFile(): string {
  return join(RUNTIME_DIR, 'session-key')
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function dirSize(path: string): number {
  let total = 0
  let entries: string[]
  try {
    entries = readdirSync(path)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(path, entry)
    try {
      const stat = statSync(full)
      total += stat.isDirectory() ? dirSize(full) : stat.size
    } catch {
      /* a file that vanished mid-walk is not part of the total */
    }
  }
  return total
}

/* ---------------- what the app currently has ---------------- */

interface State {
  stage: LocalStage
  /** The one asked for in this session, if any. */
  chosen?: string
  progress?: LocalProgress
  message?: string
  version?: string
  port?: number
}

const state: State = { stage: 'absent' }

function weightsPresent(spec: LocalModelSpec): boolean {
  return sizeOf(modelPath(spec)) === spec.bytes
}

/**
 * Which model this is about.
 *
 * What was asked for, then what is actually on disk, then the default — in
 * that order, because the state of this module is lost at every restart and
 * what somebody installed is not. Reporting the default as absent while the
 * one they chose sat downloaded next to it was the bug this replaces.
 */
function currentSpec(id?: string): LocalModelSpec {
  if (id) return localSpec(id)
  if (state.chosen) return localSpec(state.chosen)
  return LOCAL_MODELS.find(weightsPresent) ?? LOCAL_MODELS[0]
}

export function localStatus(): LocalModelStatus {
  const spec = currentSpec()
  const binary = llamaBinaryFor(process.platform, process.arch)
  const runtimeInstalled = existsSync(serverBinary())
  const weights = sizeOf(modelPath(spec))
  const modelInstalled = weightsPresent(spec)

  // Nothing has been asked of it, so the stage is whatever is on disk.
  const resting: LocalStage =
    runtimeInstalled && modelInstalled ? 'ready' : 'absent'
  const stage =
    state.stage === 'installing' || state.stage === 'starting' || state.stage === 'running'
      ? state.stage
      : state.stage === 'failed'
        ? 'failed'
        : resting

  return {
    stage,
    supported: Boolean(binary),
    spec: {
      id: spec.id,
      name: spec.name,
      bytes: spec.bytes,
      contextWindow: spec.contextWindow,
      ramBytes: spec.ramBytes,
      blurb: spec.blurb
    },
    runtime: { installed: runtimeInstalled, build: LLAMA_BUILD, version: state.version },
    model: {
      installed: modelInstalled,
      bytes: weights,
      // What an interrupted download left behind, so the row can offer to
      // carry on rather than asking for the whole 2 GB again.
      partialBytes: modelInstalled ? undefined : sizeOf(`${modelPath(spec)}.part`) || undefined
    },
    diskBytes: dirSize(RUNTIME_DIR) + weights,
    progress: state.progress,
    port: state.stage === 'running' ? state.port : undefined,
    message: state.message
  }
}

let lastEmit = 0

function publish(force = true): void {
  const now = Date.now()
  // Progress arrives per chunk; the renderer needs a bar, not a firehose.
  if (!force && now - lastEmit < 250) return
  lastEmit = now
  bus.emit({ type: 'local.status', status: localStatus() })
}

function fail(message: string): LocalModelStatus {
  state.stage = 'failed'
  state.progress = undefined
  state.message = message
  logLine('warn', `local model: ${message}`)
  publish()
  return localStatus()
}

/* ---------------- fetching, and refusing to trust it ---------------- */

async function hashOf(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/**
 * Downloads one file and proves it is the one this build was written against.
 *
 * Resumable, because the weights are gigabytes and a dropped connection should
 * not mean starting again: the partial file keeps its own name until it is
 * whole, and what is already there is re-hashed rather than assumed. A server
 * that ignores the range header is honoured by starting over instead of
 * appending to bytes it did not continue from — which is how a resume produces
 * a file that is the right length and the wrong content.
 *
 * On a mismatch the file is deleted. There is no flag to keep it: the only
 * thing it is good for is being executed, and that is the one thing it must
 * not be.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expect: { bytes: number; sha256: string },
  progress: Omit<LocalProgress, 'received' | 'total'>
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`

  for (let attempt = 0; attempt < 2; attempt++) {
    let have = sizeOf(part)
    if (have > expect.bytes || attempt > 0) {
      rmSync(part, { force: true })
      have = 0
    }

    const hash = createHash('sha256')
    if (have > 0) {
      await pipeline(createReadStream(part), hash, { end: false })
    }

    const response = await fetch(url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      redirect: 'follow'
    })
    if (!response.ok || !response.body) {
      throw new Error(`${url} answered ${response.status} ${response.statusText}`)
    }
    if (have > 0 && response.status !== 206) {
      // The range was ignored, so this body starts at zero: go round again
      // from nothing rather than appending it to what is already there.
      continue
    }

    let received = have
    const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' })
    await pipeline(
      Readable.fromWeb(response.body as never),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          hash.update(chunk)
          received += chunk.length
          state.progress = { ...progress, received, total: expect.bytes }
          publish(false)
          yield chunk
        }
      },
      out
    )

    const digest = hash.digest('hex')
    if (received !== expect.bytes) {
      rmSync(part, { force: true })
      throw new Error(
        `${progress.label} came back as ${formatBytes(received)}, not the ${formatBytes(expect.bytes)} this build expects — nothing was installed`
      )
    }
    if (digest !== expect.sha256) {
      rmSync(part, { force: true })
      throw new Error(
        `${progress.label} does not match the checksum this build was made against — it was deleted rather than used`
      )
    }
    rmSync(dest, { force: true })
    renameSync(part, dest)
    return
  }

  throw new Error(`${progress.label} could not be resumed and could not be restarted`)
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 8_000_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${command} failed: ${stderr || err.message}`))
      else resolve({ stdout, stderr })
    })
  })
}

/** An entry no archive has an honest reason to contain. */
export function unsafeEntry(path: string): boolean {
  return path.startsWith('/') || /(^|[/\\])\.\.([/\\]|$)/.test(path) || /^[A-Za-z]:/.test(path)
}

/**
 * Unpacks the runtime, with the same two rules the rtk installer applies: the
 * hash first, and a listing before an extraction, so an archive that would
 * write outside the directory it was given is refused rather than unpacked and
 * cleaned up afterwards.
 */
export async function unpackRuntime(archive: string, into: string): Promise<string> {
  const zip = archive.endsWith('.zip')
  const listing = await run('tar', zip ? ['-tf', archive] : ['-tzf', archive])
  const entries = listing.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  const offender = entries.find(unsafeEntry)
  if (offender) throw new Error(`the archive wants to write to ${offender} — it was not extracted`)

  rmSync(into, { recursive: true, force: true })
  mkdirSync(into, { recursive: true })
  await run('tar', zip ? ['-xf', archive, '-C', into] : ['-xzf', archive, '-C', into])

  const found = findServer(into)
  if (!found) throw new Error('the archive holds no llama-server, so there is nothing to run')
  return found
}

function findServer(dir: string, depth = 0): string | null {
  if (depth > 3) return null
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (!isDir && entry === `llama-server${EXE}`) return full
    if (isDir) {
      const deeper = findServer(full, depth + 1)
      if (deeper) return deeper
    }
  }
  return null
}

/* ---------------- installing ---------------- */

let installing: Promise<LocalModelStatus> | null = null

/**
 * Puts everything in place and tells the config about it.
 *
 * One call does the lot — binary, weights, provider, model entry — because the
 * alternative is a page of steps whose only reader is the person who wrote it.
 * It is never automatic: this is gigabytes of somebody else's disk, so it
 * happens on a press and nowhere else.
 */
export async function installLocalModel(modelId?: string): Promise<LocalModelStatus> {
  if (installing) return installing
  /*
   * Released when it settles, wherever it settled. Clearing it inside the body
   * missed the one path that returns before the first await — a platform with
   * no published build — and left the install permanently "already running".
   */
  installing = (async () => {
    const spec = currentSpec(modelId)
    state.chosen = spec.id
    const binary = llamaBinaryFor(process.platform, process.arch)
    if (!binary) {
      return fail(`llama.cpp publishes no ${LLAMA_BUILD} build for ${process.platform} ${process.arch}.`)
    }

    state.stage = 'installing'
    state.message = undefined
    publish()

    try {
      if (!existsSync(serverBinary())) {
        const staging = join(RUNTIME_DIR, `${LLAMA_BUILD}.incoming`)
        const archive = join(RUNTIME_DIR, binary.asset)
        mkdirSync(RUNTIME_DIR, { recursive: true })
        await downloadVerified(llamaUrl(binary), archive, binary, {
          what: 'runtime',
          label: `the llama.cpp ${LLAMA_BUILD} runtime`
        })
        const server = await unpackRuntime(archive, staging)
        // The binary needs the libraries beside it, so what is kept is the
        // directory it came out of rather than the one file.
        rmSync(buildDir(), { recursive: true, force: true })
        mkdirSync(RUNTIME_DIR, { recursive: true })
        renameSync(dirname(server), buildDir())
        rmSync(staging, { recursive: true, force: true })
        rmSync(archive, { force: true })
        for (const entry of readdirSync(buildDir())) {
          try {
            chmodSync(join(buildDir(), entry), 0o755)
          } catch {
            /* a file that cannot be marked executable will say so when run */
          }
        }
      }

      // Proof rather than presence: a directory with the right name in it is
      // not a runtime that runs on this machine.
      const version = await run(serverBinary(), ['--version']).catch((err: Error) => {
        throw new Error(`the runtime is installed but will not run here: ${err.message}`)
      })
      state.version = /build[: ]+(\d+)/.exec(`${version.stdout}${version.stderr}`)?.[1] ?? LLAMA_BUILD

      if (!weightsPresent(spec)) {
        mkdirSync(MODELS_DIR, { recursive: true })
        await downloadVerified(modelUrl(spec), modelPath(spec), spec, {
          what: 'model',
          label: spec.name
        })
      }

      declareProvider(spec)
      state.progress = undefined
      state.stage = 'ready'
      state.message = `${spec.name} is installed and configured.`
      logLine('info', `local model: ${spec.name} installed (${formatBytes(localStatus().diskBytes)} on disk)`)
      publish()

      /*
       * And then start it, because this is the moment somebody is watching.
       * An install that ends in "ready" asks them to press a second button to
       * find out whether any of it worked; one that ends answering on a port
       * has already told them. It gives the memory back on its own after
       * fifteen idle minutes.
       */
      return await startLocalModel(spec.id)
    } catch (err) {
      return fail((err as Error).message)
    }
  })().finally(() => {
    installing = null
  })
  return installing
}

/** Frees the disk again, and stops claiming a provider that has no model. */
export function removeLocalModel(modelId?: string): LocalModelStatus {
  const spec = currentSpec(modelId)
  stopLocalModel('the model was removed')
  rmSync(modelPath(spec), { force: true })
  rmSync(`${modelPath(spec)}.part`, { force: true })
  undeclareProvider(spec)
  state.chosen = undefined

  // The runtime is shared, so it only goes when the last model does.
  const orphaned = !LOCAL_MODELS.some(weightsPresent)
  if (orphaned) {
    rmSync(RUNTIME_DIR, { recursive: true, force: true })
    state.version = undefined
  }
  state.stage = orphaned ? 'absent' : 'ready'
  state.message = orphaned
    ? `${spec.name} and the runtime were removed.`
    : `${spec.name} was removed; the runtime is still there for the others.`
  publish()
  return localStatus()
}

/* ---------------- declaring itself ---------------- */

/**
 * Writes the provider into the config, so nothing has to be configured by hand.
 *
 * No `apiKey` key at all, rather than an empty one: an empty key is how the
 * router recognises a provider it must not send work to, and this one needs no
 * key from anybody — the one it does use is generated per start and injected
 * when the model is resolved.
 */
export function localProviderConfig(
  existing: ProviderConfig | undefined,
  spec: LocalModelSpec
): ProviderConfig {
  return {
    ...(existing ?? {}),
    id: LOCAL_PROVIDER_ID,
    npm: '@ai-sdk/openai-compatible',
    name: existing?.name ?? 'On this machine',
    options: { ...(existing?.options ?? {}), baseURL: LOCAL_BASE_URL },
    models: {
      ...(existing?.models ?? {}),
      // What is already there wins, so a slider moved on this model stays
      // moved the next time anything is installed.
      [spec.id]: existing?.models?.[spec.id] ?? localModelEntry(spec)
    }
  }
}

function declareProvider(spec: LocalModelSpec): void {
  const config = loadConfig()
  const next = localProviderConfig(config.provider[LOCAL_PROVIDER_ID], spec)
  saveConfig({ ...config, provider: { ...config.provider, [LOCAL_PROVIDER_ID]: next } })
  bus.emit({ type: 'config.updated', config: loadConfig() })
}

function undeclareProvider(spec: LocalModelSpec): void {
  const config = loadConfig()
  const existing = config.provider[LOCAL_PROVIDER_ID]
  if (!existing) return
  const models = { ...existing.models }
  delete models[spec.id]
  const provider = { ...config.provider }
  // A provider with no model left is not a provider; leaving one behind would
  // put an empty entry in the picker that nobody added.
  if (Object.keys(models).length === 0) delete provider[LOCAL_PROVIDER_ID]
  else provider[LOCAL_PROVIDER_ID] = { ...existing, models }
  saveConfig({ ...config, provider })
  bus.emit({ type: 'config.updated', config: loadConfig() })
}

/* ---------------- running it ---------------- */

interface Live {
  child: ChildProcess
  port: number
  token: string
  specId: string
}

let live: Live | null = null
let starting: Promise<Live> | null = null
let lastUse = 0
let idleTimer: NodeJS.Timeout | null = null
let wanted = false
let crashes = 0
let lastCrash = 0

/**
 * Fifteen minutes of nobody asking, and the memory goes back.
 *
 * A 3B model with its window is three and a half gigabytes resident, which on
 * a 16GB laptop is worth giving back — and the cost of being wrong is one cold
 * start, which is seconds. The clock is touched where the model is resolved,
 * because the requests themselves go straight from the SDK to the port and are
 * not seen here.
 */
const IDLE_MS = 15 * 60 * 1000

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!live) return
    if (Date.now() - lastUse < IDLE_MS) return armIdleTimer()
    stopLocalModel('it had not been used for fifteen minutes')
  }, IDLE_MS)
  idleTimer.unref?.()
}

/** Three minutes: loading gigabytes of weights off a cold disk is most of it. */
const START_MS = 180_000

async function waitForHealth(port: number, token: string, tail: () => string): Promise<void> {
  const deadline = Date.now() + START_MS
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`the local server did not answer within ${START_MS / 1000}s.\n${tail()}`)
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

/**
 * Starts the sidecar and waits until it will actually answer.
 *
 * The port is taken from the OS rather than picked, and handed to the server
 * with a token generated here — it binds to localhost, but localhost is shared
 * with everything else on the machine, and an unauthenticated model server is
 * an open one. Readiness is the server's own `/health`, not a line in its
 * output: loading the weights is most of the wait and the log says nothing
 * useful while it happens.
 */
async function startProcess(spec: LocalModelSpec): Promise<Live> {
  if (!existsSync(serverBinary())) {
    throw new Error('the local runtime is not installed yet')
  }
  if (!weightsPresent(spec)) {
    throw new Error(`${spec.name} is not downloaded yet`)
  }

  const port = await freePort()
  /*
   * A key of its own per start, in a file rather than in the command line:
   * argv is readable by anything that can run `ps`, and while this key only
   * opens a local model server, a token in a process listing is not a habit
   * worth keeping.
   */
  const token = randomBytes(24).toString('hex')
  rmSync(keyFile(), { force: true })
  writeFileSync(keyFile(), `${token}\n`, { mode: 0o600 })

  const args = [
    '--model', modelPath(spec),
    '--alias', spec.id,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--api-key-file', keyFile(),
    '--ctx-size', String(spec.contextWindow),
    // All of it on the GPU where there is one; ignored where there is not.
    '--n-gpu-layers', '999',
    '--flash-attn', 'auto',
    // The local counterpart of prompt caching: a turn that resends the same
    // prefix reuses the KV cache for it instead of prefilling it again.
    '--cache-reuse', '256',
    '--jinja',
    '--no-webui'
  ]

  state.stage = 'starting'
  state.message = `Loading ${spec.name}…`
  publish()

  const child = spawn(serverBinary(), args, {
    cwd: buildDir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // The same environment an agent's commands get: this app's own API keys
    // are stripped out of it. A model server has no use for the key of the
    // provider it is standing in for.
    env: toolEnvironment()
  })

  let output = ''
  const keep = (data: Buffer): void => {
    output = `${output}${data.toString('utf8')}`.slice(-4000)
  }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)

  child.on('error', (err) => {
    output += `\ncould not run the server: ${err.message}`
  })
  child.on('close', (code) => {
    const was = live
    live = null
    rmSync(keyFile(), { force: true })
    if (state.stage === 'running' || state.stage === 'starting') {
      state.stage = 'ready'
      state.port = undefined
    }
    if (was && wanted) {
      /*
       * It died while it was supposed to be up. Restarted a couple of times —
       * a model server that is being killed by the memory pressure of the
       * machine it is on will do it again, and an app that retries forever is
       * worse than one that says so.
       */
      /*
       * Counted within a window rather than for the lifetime of the app: three
       * crashes in ten minutes is a server that cannot run here and saying so
       * is the useful answer, while one crash an hour into a working day is
       * worth restarting. Resetting the count on a successful start instead
       * would have made a server that dies on its first request restart for
       * ever.
       */
      if (Date.now() - lastCrash > 10 * 60 * 1000) crashes = 0
      lastCrash = Date.now()
      crashes++
      const message = `the local server stopped on its own (code ${code ?? 0})`
      if (crashes <= 2) {
        logLine('warn', `local model: ${message}; restarting`)
        void startLocalModel(was.specId).catch(() => undefined)
      } else {
        wanted = false
        fail(`${message} three times, so it was left stopped.\n${output.trim().slice(-400)}`)
      }
      return
    }
    publish()
  })

  /*
   * Whichever happens first: it answers, or it dies. Waiting only on the
   * health check meant a model that could not be loaded at all — a file the
   * machine has no memory for — showed as "loading" for three minutes before
   * saying what the server had already printed in the first second.
   */
  let settled = false
  const died = new Promise<never>((_resolve, reject) => {
    child.once('close', (code) => {
      if (!settled) {
        reject(new Error(`the local server stopped before answering (code ${code ?? 0}).\n${output.trim().slice(-400)}`))
      }
    })
  })
  died.catch(() => undefined)

  try {
    await Promise.race([waitForHealth(port, token, () => output.trim().slice(-400)), died])
  } catch (err) {
    child.kill()
    throw err
  } finally {
    settled = true
  }

  const next: Live = { child, port, token, specId: spec.id }
  live = next
  state.stage = 'running'
  state.port = port
  state.message = `${spec.name} is answering on 127.0.0.1:${port}.`
  lastUse = Date.now()
  armIdleTimer()
  logLine('info', `local model: ${spec.name} listening on 127.0.0.1:${port} (ctx ${spec.contextWindow})`)
  publish()
  return next
}

export async function startLocalModel(modelId?: string): Promise<LocalModelStatus> {
  const spec = currentSpec(modelId)
  state.chosen = spec.id
  wanted = true
  if (live && live.specId === spec.id) return localStatus()
  if (live) stopLocalModel('a different local model was asked for')
  if (!starting) {
    starting = startProcess(spec).finally(() => {
      starting = null
    })
  }
  try {
    await starting
    return localStatus()
  } catch (err) {
    wanted = false
    return fail((err as Error).message)
  }
}

export function stopLocalModel(reason?: string): LocalModelStatus {
  wanted = false
  crashes = 0
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const current = live
  live = null
  rmSync(keyFile(), { force: true })
  if (current) {
    current.child.kill()
    logLine('info', `local model: stopped${reason ? ` — ${reason}` : ''}`)
  }
  state.stage = existsSync(serverBinary()) ? 'ready' : 'absent'
  state.port = undefined
  state.message = reason
  publish()
  return localStatus()
}

/**
 * Where the local provider's `local://` URL resolves to, starting the server if
 * it is not up.
 *
 * This is the whole reason the config can hold a fixed address for a process
 * whose port changes: the substitution happens when a model is resolved, which
 * is also the moment it is about to be needed. A cold start costs the first
 * turn a few seconds and every turn after it nothing.
 */
export interface LocalEndpoint {
  baseURL: string
  apiKey: string
  /**
   * The provider's fetch, wrapped so that using the model counts as using it.
   *
   * Without this the idle clock was only touched when a model was resolved,
   * which is once a turn: a turn that spent twenty minutes reading files would
   * have had the server shut down underneath it. Requests are what keep it
   * alive, and this is the only place they can be seen — they go from the SDK
   * straight to the port.
   */
  fetch: typeof globalThis.fetch
}

export async function ensureLocalModel(modelId?: string): Promise<LocalEndpoint> {
  const spec = currentSpec(modelId)
  lastUse = Date.now()
  if (live && live.specId === spec.id) {
    armIdleTimer()
    return endpointFor(live)
  }
  wanted = true
  if (live) stopLocalModel('a different local model was asked for')
  if (!starting) {
    starting = startProcess(spec).finally(() => {
      starting = null
    })
  }
  // A start that fails leaves the row saying what went wrong rather than
  // "loading" for ever — the turn that asked for it gets the same message.
  const started = await starting.catch((err: Error) => {
    wanted = false
    fail(err.message)
    throw err
  })
  return endpointFor(started)
}

function endpointFor(instance: Live): LocalEndpoint {
  return {
    baseURL: `http://127.0.0.1:${instance.port}/v1`,
    apiKey: instance.token,
    fetch: (input, init) => {
      lastUse = Date.now()
      armIdleTimer()
      return globalThis.fetch(input as never, init)
    }
  }
}

/** Called from `before-quit`: the child is ours, so it goes when we do. */
export function disposeLocalModel(): void {
  stopLocalModel('the app is quitting')
}
