import { safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR, setSecretResolver } from './config'

/**
 * API keys live here, never in config.json.
 *
 * Electron's safeStorage encrypts with a key held in the macOS Keychain, so the
 * file on disk is useless to anything that is not this app running as this user.
 * Values are decrypted once at startup and kept in memory, because placeholder
 * expansion in the config is synchronous.
 */
const SECRETS_PATH = join(CONFIG_DIR, 'secrets.json')

const cache = new Map<string, string>()
let available = false

function readFile(): Record<string, string> {
  if (!existsSync(SECRETS_PATH)) return {}
  try {
    return JSON.parse(readFileSync(SECRETS_PATH, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function writeFileSecure(data: Record<string, string>): void {
  mkdirSync(dirname(SECRETS_PATH), { recursive: true })
  // 0600: the ciphertext is not a secret, but there is no reason to share it.
  writeFileSync(SECRETS_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/** Must run after app.whenReady(): safeStorage needs the Keychain to be reachable. */
export function loadSecrets(): { available: boolean; names: string[]; error?: string } {
  available = safeStorage.isEncryptionAvailable()
  cache.clear()

  if (!available) {
    setSecretResolver(() => undefined)
    return { available: false, names: [], error: 'the system keychain is not available' }
  }

  const stored = readFile()
  const failed: string[] = []
  for (const [name, encoded] of Object.entries(stored)) {
    try {
      cache.set(name, safeStorage.decryptString(Buffer.from(encoded, 'base64')))
    } catch {
      // A key written by a different machine or a reinstalled Keychain entry.
      failed.push(name)
    }
  }

  setSecretResolver((name) => cache.get(name))
  return {
    available: true,
    names: [...cache.keys()],
    error: failed.length ? `could not decrypt: ${failed.join(', ')}` : undefined
  }
}

export function setSecret(name: string, value: string): void {
  if (!available) throw new Error('The system keychain is not available, so the key cannot be stored.')
  if (!value) return deleteSecret(name)
  const stored = readFile()
  stored[name] = safeStorage.encryptString(value).toString('base64')
  writeFileSecure(stored)
  cache.set(name, value)
}

export function deleteSecret(name: string): void {
  const stored = readFile()
  delete stored[name]
  writeFileSecure(stored)
  cache.delete(name)
}

export function secretStatus(): { available: boolean; names: string[]; path: string } {
  return { available, names: [...cache.keys()], path: SECRETS_PATH }
}

/**
 * Never returns the value — only enough to show the user which key is stored.
 * A stored key is shown as the last four characters, like a card number.
 */
export function secretHint(name: string): string | null {
  const value = cache.get(name)
  if (!value) return null
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`
}
