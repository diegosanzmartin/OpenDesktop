/**
 * Reading and writing one file for the editor pane.
 *
 * Separate from the agent's own read and write for two reasons. The failure
 * has to come back as a value — a file that is not there, or is a directory,
 * or is a gigabyte of something binary, is a sentence to put in the pane
 * rather than an exception in a promise nobody awaited. And the write does not
 * go through the approval prompts, deliberately: those exist because the
 * *model* asked for something, and asking somebody to approve their own
 * keystrokes in their own editor would be theatre.
 */
import { getRuntime } from './runtime'
import { describeError } from '@shared/errors'
import { logLine } from './log'

/** Past this it is not a file somebody is going to edit in a side pane. */
export const MAX_EDITABLE_BYTES = 2_000_000

export interface Opened {
  text: string
  error?: string
}

export async function readForEditor(
  environmentId: string,
  path: string,
  sessionId?: string
): Promise<Opened> {
  try {
    const runtime = getRuntime(environmentId, sessionId)
    await runtime.connect()

    if (await runtime.isDirectory(path)) return { text: '', error: `${path} is a folder.` }

    const stat = await runtime.stat(path)
    if (!stat) return { text: '', error: `${path} is not there.` }
    if (stat.size > MAX_EDITABLE_BYTES) {
      return {
        text: '',
        error: `${path} is ${Math.round(stat.size / 1_000_000)} MB — too big to edit here. Open it in the viewer instead.`
      }
    }

    const text = await runtime.readFile(path)
    // A NUL byte is the reliable tell, the same one the preview server uses.
    if (text.includes(String.fromCharCode(0))) {
      return { text: '', error: `${path} is binary — nothing to edit.` }
    }
    return { text }
  } catch (err) {
    return { text: '', error: describeError(err) }
  }
}

export async function writeFromEditor(
  environmentId: string,
  path: string,
  text: string,
  sessionId?: string
): Promise<{ error?: string }> {
  try {
    const runtime = getRuntime(environmentId, sessionId)
    await runtime.connect()
    await runtime.writeFile(path, text)
    logLine('info', `editor: saved ${path}`)
    return {}
  } catch (err) {
    return { error: describeError(err) }
  }
}
