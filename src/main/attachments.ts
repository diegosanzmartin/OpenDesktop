import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { nanoid } from 'nanoid'
import mime from 'mime'
import type { Attachment, AppConfig } from '@shared/types'
import { DATA_DIR } from './config'
import { parseModelRef } from './providers'

/**
 * Files the user attaches to a message.
 *
 * A copy is kept beside the session rather than a reference to wherever the
 * file came from: the transcript has to still make sense after the original is
 * moved, renamed or deleted.
 */
const ATTACHMENTS_DIR = join(DATA_DIR, 'attachments')

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_TEXT_BYTES = 512 * 1024

/** Extensions that are text even when the system has no media type for them. */
const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.markdown', '.txt', '.csv', '.tsv',
  '.yml', '.yaml', '.toml', '.ini', '.conf', '.cfg', '.env', '.sh', '.bash', '.zsh', '.fish',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.sql', '.html', '.css', '.scss', '.xml', '.tf', '.tfvars', '.hcl', '.gradle',
  '.dockerfile', '.gitignore', '.lock', '.log', '.patch', '.diff'
])

export class AttachmentError extends Error {}

function classify(name: string, mediaType: string, bytes: Buffer): Attachment['kind'] {
  if (mediaType.startsWith('image/')) return 'image'
  if (mediaType.startsWith('text/')) return 'text'
  if (TEXT_EXTENSIONS.has(extname(name).toLowerCase())) return 'text'
  if (/^application\/(json|xml|javascript|x-sh|toml|yaml|x-yaml)/.test(mediaType)) return 'text'
  // No media type worth trusting: a NUL byte is the reliable tell for binary.
  return bytes.subarray(0, 4096).includes(0) ? 'binary' : 'text'
}

function store(sessionId: string, name: string, bytes: Buffer, mediaType: string): Attachment {
  const kind = classify(name, mediaType, bytes)

  if (kind === 'binary') {
    throw new AttachmentError(
      `${name} is a binary file that is not an image. Attach it as text, or paste the part that matters.`
    )
  }
  if (kind === 'image' && bytes.length > MAX_IMAGE_BYTES) {
    throw new AttachmentError(
      `${name} is ${(bytes.length / 1024 / 1024).toFixed(1)} MB; the limit for an image is 12 MB.`
    )
  }
  if (kind === 'text' && bytes.length > MAX_TEXT_BYTES) {
    throw new AttachmentError(
      `${name} is ${(bytes.length / 1024).toFixed(0)} KB; the limit for a text file is 512 KB. Attach the relevant part instead.`
    )
  }

  const dir = join(ATTACHMENTS_DIR, sessionId)
  mkdirSync(dir, { recursive: true })
  const id = nanoid(10)
  const path = join(dir, `${id}${extname(name) || ''}`)
  writeFileSync(path, bytes)

  return {
    id,
    name,
    mediaType: mediaType || 'application/octet-stream',
    size: bytes.length,
    kind,
    path,
    text: kind === 'text' ? bytes.toString('utf8') : undefined
  }
}

export function addFromPaths(sessionId: string, paths: string[]): {
  added: Attachment[]
  errors: string[]
} {
  const added: Attachment[] = []
  const errors: string[] = []

  for (const source of paths) {
    try {
      if (!existsSync(source)) throw new AttachmentError(`${basename(source)} no longer exists.`)
      if (statSync(source).isDirectory()) {
        throw new AttachmentError(`${basename(source)} is a folder; attach the files inside it.`)
      }
      const name = basename(source)
      added.push(store(sessionId, name, readFileSync(source), mime.getType(name) ?? ''))
    } catch (err) {
      errors.push(err instanceof AttachmentError ? err.message : (err as Error).message)
    }
  }

  return { added, errors }
}

/** For a pasted screenshot, which arrives as bytes rather than a path. */
export function addFromBytes(
  sessionId: string,
  name: string,
  mediaType: string,
  bytes: Uint8Array
): { added: Attachment[]; errors: string[] } {
  try {
    return { added: [store(sessionId, name, Buffer.from(bytes), mediaType)], errors: [] }
  } catch (err) {
    return { added: [], errors: [(err as Error).message] }
  }
}

export function removeAttachment(path: string): void {
  // Only ever delete inside our own directory.
  if (!path.startsWith(ATTACHMENTS_DIR)) return
  if (existsSync(path)) rmSync(path)
}

export function dropSessionAttachments(sessionId: string): void {
  const dir = join(ATTACHMENTS_DIR, sessionId)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
}

export function readAttachment(attachment: Attachment): Buffer | null {
  try {
    return readFileSync(attachment.path)
  } catch {
    return null
  }
}

/**
 * Whether the chosen model has been declared able to read images.
 *
 * There is no way to ask an OpenAI-compatible endpoint what it accepts, so this
 * is a property of the model in the config. Sending an image to a model that
 * cannot read one produces a provider error at best and a silently ignored
 * attachment at worst, so the composer refuses up front instead.
 */
export function modelAcceptsImages(config: AppConfig, ref: string): boolean {
  try {
    const { providerId, modelId } = parseModelRef(ref)
    return config.provider[providerId]?.models[modelId]?.vision === true
  } catch {
    return false
  }
}

export function copyForSession(from: string, to: string, attachments: Attachment[]): Attachment[] {
  const dir = join(ATTACHMENTS_DIR, to)
  mkdirSync(dir, { recursive: true })
  return attachments.map((attachment) => {
    const path = join(dir, basename(attachment.path))
    try {
      copyFileSync(attachment.path, path)
    } catch {
      return attachment
    }
    return { ...attachment, path }
  })
}
