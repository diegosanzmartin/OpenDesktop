import type { ProviderConfig, ProviderModelConfig } from './types'

/**
 * A model that runs on this machine, and the pieces the app fetches to do it.
 *
 * The alternative was Ollama: a second application to install, keep running and
 * keep updated, with its own model store and its own opinions about what is
 * loaded. What is actually needed is one process that speaks the OpenAI shape
 * on localhost — which is exactly what llama.cpp's `llama-server` is. So the
 * app supervises one of those itself, and everything below is what it needs to
 * know to do that without anybody typing a path or a port.
 *
 * Nothing here is looked up at runtime. The build is pinned, every download is
 * named with the size and SHA-256 it must have, and a byte that does not match
 * is deleted rather than executed. A checksum fetched next to a download only
 * proves the two came from the same place; one written down here, in a file
 * that ships signed inside the app, proves it is the thing this version was
 * built against. That is worth an app update to move a version.
 */

/** The llama.cpp build these hashes belong to. */
export const LLAMA_BUILD = 'b11026'

export interface LlamaBinary {
  /** `process.platform` this asset is for. */
  platform: string
  /** `process.arch` this asset is for. */
  arch: string
  asset: string
  bytes: number
  sha256: string
}

/**
 * The release assets, as GitHub publishes them for this build.
 *
 * The plain CPU/Metal builds only: the CUDA, ROCm, SYCL and Vulkan variants are
 * hundreds of megabytes and need a driver stack to match, which is not
 * something an app can install on somebody's behalf. On a Mac the plain build
 * is the fast one anyway — Metal is in it.
 */
export const LLAMA_BINARIES: LlamaBinary[] = [
  {
    platform: 'darwin',
    arch: 'arm64',
    asset: `llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`,
    bytes: 11_156_751,
    sha256: 'dbbfc7bd866a2594fea3bb10b56c5b205fffdaba23695f89da053b76e9a456d2'
  },
  {
    platform: 'darwin',
    arch: 'x64',
    asset: `llama-${LLAMA_BUILD}-bin-macos-x64.tar.gz`,
    bytes: 11_204_942,
    sha256: 'efa554e37e6fe9cb274734cf841fdca55fd92155980c8539bcbd83b77c3dc6cc'
  },
  {
    platform: 'linux',
    arch: 'x64',
    asset: `llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz`,
    bytes: 16_855_810,
    sha256: '219cf1c726bae1da4289b96a6378314d5485c6bc74c43891a4203e30906afb06'
  },
  {
    platform: 'linux',
    arch: 'arm64',
    asset: `llama-${LLAMA_BUILD}-bin-ubuntu-arm64.tar.gz`,
    bytes: 13_480_416,
    sha256: 'b908d7dc8369f04d586ab506a2395592aa2fd3271309e07e26c9b8e0490067b8'
  },
  {
    platform: 'win32',
    arch: 'x64',
    asset: `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`,
    bytes: 18_439_911,
    sha256: '617529171621548ada99e7b4f4f6234aab76129a674d3594dec4cfdfebb3ebec'
  },
  {
    platform: 'win32',
    arch: 'arm64',
    asset: `llama-${LLAMA_BUILD}-bin-win-cpu-arm64.zip`,
    bytes: 12_002_235,
    sha256: '7834edc606c5d2fadcc9224cc33caa7f8b89ccfef27c09a21f2c1e7ea21f400b'
  }
]

export function llamaBinaryFor(platform: string, arch: string): LlamaBinary | undefined {
  return LLAMA_BINARIES.find((entry) => entry.platform === platform && entry.arch === arch)
}

export function llamaUrl(binary: LlamaBinary): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${binary.asset}`
}

export interface LocalModelSpec {
  /** The model id under the local provider, and the server's `--alias`. */
  id: string
  name: string
  /** Hugging Face repository, which has to be one that needs no account. */
  repo: string
  file: string
  bytes: number
  /** The file's SHA-256, which for a Hugging Face LFS file is its object id. */
  sha256: string
  /**
   * The window the server is started with, and therefore the one the app
   * declares. Not the model's advertised maximum: the KV cache for that window
   * is memory this machine has to find next to the weights, and a window that
   * does not fit is a crash rather than a slow turn.
   */
  contextWindow: number
  /** Roughly what it occupies while loaded, weights plus that window's cache. */
  ramBytes: number
  /**
   * Anything this particular model needs the server told about it.
   *
   * Qwen3 is a hybrid thinking model: asked a question with the default
   * settings it spent its whole output budget inside its reasoning channel and
   * returned an empty answer — 256 tokens, nothing said. `--reasoning off` is
   * how llama.cpp turns that off, and knowing it is the app's job rather than
   * something for anyone to discover twice.
   */
  serverArgs?: string[]
  /** One line for the settings row. */
  blurb: string
}

/**
 * The curated models, best first. Ungated repositories only — a download that
 * stops to ask for an account is not plug-and-play — and published by whoever
 * trained the model, so the weights are not somebody's requantisation of them.
 */
export const LOCAL_MODELS: LocalModelSpec[] = [
  {
    /*
     * The default, on measurement rather than on size. Asked the same question
     * three times through the app's own agent loop it read the file it was
     * pointed at and answered in one sentence three times, identically. The 3B
     * below did that once in three, and spent the other two grepping for the
     * wording of the question or reading a five-line file sixteen times.
     *
     * It costs a third of its speed for that: about 31 tokens a second against
     * the 3B's 43, and a 16k window instead of 32k because its KV cache is
     * larger per token.
     */
    id: 'qwen3-4b',
    name: 'Qwen3 4B',
    repo: 'Qwen/Qwen3-4B-GGUF',
    file: 'Qwen3-4B-Q4_K_M.gguf',
    bytes: 2_497_280_256,
    sha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
    contextWindow: 16_384,
    ramBytes: 5_000_000_000,
    serverArgs: ['--reasoning', 'off'],
    blurb: 'Reads what it is pointed at and answers short. The default: the reliable one.'
  },
  {
    id: 'qwen2.5-3b-instruct',
    name: 'Qwen2.5 3B Instruct',
    repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    bytes: 2_104_932_768,
    sha256: '626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d',
    contextWindow: 32_768,
    ramBytes: 3_400_000_000,
    blurb: 'Half again as fast with twice the window, and it gets the job right about a third of the time.'
  }
]

/** The model ref a local model is declared as, for anything that needs one. */
export function localModelRef(id?: string): string {
  return `${LOCAL_PROVIDER_ID}/${localSpec(id).id}`
}

export function localSpec(id?: string): LocalModelSpec {
  return LOCAL_MODELS.find((spec) => spec.id === id) ?? LOCAL_MODELS[0]
}

export function modelUrl(spec: LocalModelSpec): string {
  return `https://huggingface.co/${spec.repo}/resolve/main/${spec.file}`
}

/** The provider the app declares for itself once something is installed. */
export const LOCAL_PROVIDER_ID = 'local'

/**
 * The base URL the local provider is configured with.
 *
 * Not a port: the sidecar takes a free one each time it starts, so a port
 * written into the config would be wrong by the second launch. This stands for
 * "whatever the supervised server is listening on", and is substituted for the
 * live address when a model is resolved — which is also what starts it.
 */
export const LOCAL_BASE_URL = 'local://llama'

export function isLocalProvider(provider: Pick<ProviderConfig, 'options'>): boolean {
  return typeof provider.options.baseURL === 'string' && provider.options.baseURL.startsWith('local://')
}

/**
 * How a local model is declared to the router.
 *
 * Flat rate and priced at zero, because both are true: it is this machine's
 * electricity, and the next token costs nothing. `iq` 2 clears the floor for
 * delegated reading and nothing more — a 3B model is not who you ask how to do
 * something hard, and the router is told so here rather than finding out.
 */
export function localModelEntry(spec: LocalModelSpec): ProviderModelConfig {
  return {
    id: spec.id,
    name: spec.name,
    contextWindow: spec.contextWindow,
    toolCall: true,
    vision: false,
    price: { input: 0, output: 0 },
    billing: 'flat',
    monthlyCost: 0,
    iq: 2,
    cost: 1
  }
}

export type LocalStage = 'absent' | 'installing' | 'ready' | 'starting' | 'running' | 'failed'

export interface LocalProgress {
  what: 'runtime' | 'model'
  label: string
  received: number
  total: number
}

export interface LocalModelStatus {
  stage: LocalStage
  /** False when there is no published build for this platform at all. */
  supported: boolean
  /** The model this machine is set up for, or would be. */
  spec: { id: string; name: string; bytes: number; contextWindow: number; ramBytes: number; blurb: string }
  runtime: { installed: boolean; build: string; version?: string }
  model: {
    installed: boolean
    bytes: number
    /** What a previous, interrupted download already left on disk. */
    partialBytes?: number
  }
  /** Bytes on disk, runtime and weights together. */
  diskBytes: number
  progress?: LocalProgress
  port?: number
  /** What happened, for the row and for the log. */
  message?: string
}

/** Bytes as a person reads them, for the settings row. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`
  return `${(bytes / 1_000_000_000).toFixed(bytes < 10_000_000_000 ? 1 : 0)} GB`
}
