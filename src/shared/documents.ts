/**
 * What counts as a document, and how to describe one.
 *
 * Shared so the transcript and the tests agree: the decision of whether a file
 * the agent wrote is something to open or something to diff is the whole
 * behaviour, and it is one regex away from turning every edited source file
 * into a card.
 */
/**
 * The extensions that get a card. Deliberately not source code: a `.ts` the
 * agent changed belongs in the diff, and turning every edited file into a card
 * would bury the one thing you asked for.
 */
const DOCUMENTS = new Set([
  'pdf',
  'md',
  'markdown',
  'txt',
  'rtf',
  'csv',
  'tsv',
  'docx',
  'doc',
  'xlsx',
  'xls',
  'pptx',
  'odt',
  'ods',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg'
])

export function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function isDocument(path: string): boolean {
  return DOCUMENTS.has(extensionOf(path))
}

/** Bytes as a person reads them, matching the card in the reference. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}
