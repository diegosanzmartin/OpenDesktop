import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import type { AppConfig } from '@shared/types'
import { bus } from './bus'
import {
  CONFIG_PATH,
  rawConfig,
  readConfigText,
  resolvedConfig,
  saveConfig,
  writeConfigText
} from './config'
import { invalidateProviderCache, listModels } from './providers'
import { getRuntime, resetRuntimes, testEnvironment } from './runtime'
import * as store from './store'
import * as history from './history'
import { isRunning, runTurn, stop } from './agent/runner'
import { listPending, resolveApproval, type ApprovalAnswer } from './approvals'
import { previewOrigin, previewUrl } from './preview'
import { deleteSecret, secretHint, secretStatus, setSecret } from './secrets'
import { createTerminal, killTerminal, resizeTerminal, terminalBuffer, writeTerminal } from './terminal'
import { readChanges, readFileDiff } from './git'

function broadcast(): void {
  bus.subscribe((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('app:event', event)
    }
  })
}

async function reloadConfigDependents(config: AppConfig): Promise<void> {
  invalidateProviderCache()
  await resetRuntimes()
  bus.emit({ type: 'config.updated', config })
}

export function registerIpc(): void {
  broadcast()

  /* ---------- config ---------- */
  ipcMain.handle('config:get', () => rawConfig())
  ipcMain.handle('config:path', () => CONFIG_PATH)
  ipcMain.handle('config:getText', () => readConfigText())
  ipcMain.handle('config:setText', async (_e, text: string) => {
    const config = writeConfigText(text)
    await reloadConfigDependents(config)
    return config
  })
  ipcMain.handle('config:save', async (_e, next: AppConfig) => {
    const config = saveConfig(next)
    await reloadConfigDependents(config)
    return config
  })
  ipcMain.handle('config:reveal', () => shell.showItemInFolder(CONFIG_PATH))

  /* ---------- secrets ---------- */
  ipcMain.handle('secrets:status', () => {
    const status = secretStatus()
    return {
      available: status.available,
      path: status.path,
      // Hints only: the values themselves never cross the bridge.
      hints: Object.fromEntries(status.names.map((name) => [name, secretHint(name)]))
    }
  })
  ipcMain.handle('secrets:set', (_e, name: string, value: string) => {
    setSecret(name, value)
    invalidateProviderCache()
    return secretHint(name)
  })
  ipcMain.handle('secrets:delete', (_e, name: string) => {
    deleteSecret(name)
    invalidateProviderCache()
  })

  /* ---------- models & environments ---------- */
  ipcMain.handle('models:list', () => listModels(rawConfig()))
  ipcMain.handle('env:test', (_e, environmentId: string) => testEnvironment(environmentId))
  ipcMain.handle('env:home', async (_e, environmentId: string) => {
    try {
      return await getRuntime(environmentId).homeDir()
    } catch {
      return homedir()
    }
  })

  /* ---------- sessions ---------- */
  ipcMain.handle('session:list', () => store.listSessions())
  ipcMain.handle(
    'session:create',
    (
      _e,
      input: { cwd?: string; environmentId?: string; agentId?: string; model?: string; title?: string }
    ) => {
      const config = rawConfig()
      const environmentId = input.environmentId ?? 'local'
      const cwd = input.cwd ?? config.environment[environmentId]?.cwd ?? homedir()
      return store.createSession({
        title: input.title,
        cwd,
        environmentId,
        agentId: input.agentId ?? Object.keys(config.agent)[0],
        model: input.model ?? config.model
      })
    }
  )
  ipcMain.handle('session:update', (_e, id: string, patch: Record<string, unknown>) =>
    store.updateSession(id, patch)
  )
  ipcMain.handle('session:delete', (_e, id: string) => {
    if (isRunning(id)) stop(id)
    history.clearHistory(id)
    store.deleteSession(id)
  })
  ipcMain.handle('session:clear', (_e, id: string) => {
    history.clearHistory(id)
    return store.updateSession(id, {})
  })
  ipcMain.handle('session:messages', (_e, id: string) => store.listMessages(id))
  ipcMain.handle('session:blocks', (_e, id: string) => store.listBlocks(id))
  ipcMain.handle('session:running', (_e, id: string) => isRunning(id))

  /* ---------- turns ---------- */
  ipcMain.handle('turn:send', async (_e, sessionId: string, text: string) => {
    void runTurn({ sessionId, userText: text }).catch(() => undefined)
    return true
  })
  ipcMain.handle('turn:stop', (_e, sessionId: string) => stop(sessionId))

  /* ---------- approvals ---------- */
  ipcMain.handle('approval:list', () => listPending())
  ipcMain.handle('approval:resolve', (_e, id: string, answer: ApprovalAnswer) =>
    resolveApproval(id, answer)
  )

  /* ---------- activity ---------- */
  ipcMain.handle('blocks:all', (_e, limit?: number) => store.allBlocks(limit ?? 800))
  ipcMain.handle('blocks:folders', () => store.knownFolders())

  /* ---------- terminal ---------- */
  ipcMain.handle('terminal:create', (_e, input: { environmentId: string; cwd: string; cols: number; rows: number }) =>
    createTerminal(input)
  )
  ipcMain.handle('terminal:write', (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.handle('terminal:resize', (_e, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows)
  )
  ipcMain.handle('terminal:kill', (_e, id: string) => killTerminal(id))
  ipcMain.handle('terminal:buffer', (_e, id: string) => terminalBuffer(id))

  /* ---------- git ---------- */
  ipcMain.handle('git:changes', (_e, environmentId: string, cwd: string) =>
    readChanges(environmentId, cwd)
  )
  ipcMain.handle('git:diff', (_e, environmentId: string, cwd: string, path: string, untracked: boolean) =>
    readFileDiff(environmentId, cwd, path, untracked)
  )

  /* ---------- files & preview ---------- */
  ipcMain.handle('fs:list', async (_e, environmentId: string, path: string) => {
    const runtime = getRuntime(environmentId)
    await runtime.connect()
    const target = path || (await runtime.homeDir())
    return { path: target, entries: await runtime.list(target) }
  })
  ipcMain.handle('fs:read', async (_e, environmentId: string, path: string) => {
    const runtime = getRuntime(environmentId)
    await runtime.connect()
    return runtime.readFile(path)
  })
  ipcMain.handle('preview:url', (_e, environmentId: string, path: string) =>
    previewUrl(environmentId, path)
  )
  ipcMain.handle('preview:origin', () => previewOrigin())

  /* ---------- host integration ---------- */
  ipcMain.handle('host:pickFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose a working directory'
    })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('host:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('host:openPath', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('host:resolvedConfigCheck', () => {
    // Reports whether each provider's apiKey actually resolved, without leaking it.
    const resolved = resolvedConfig()
    const raw = rawConfig()
    const out: Record<string, { resolved: boolean; source: string }> = {}
    for (const [id, provider] of Object.entries(resolved.provider)) {
      const template = String(raw.provider[id]?.options.apiKey ?? '')
      const source = template.startsWith('{secret:')
        ? 'keychain'
        : template.startsWith('{env:')
          ? `environment (${template.slice(5, -1)})`
          : template.startsWith('{file:')
            ? `file (${template.slice(6, -1)})`
            : template
              ? 'config file'
              : 'not set'
      out[id] = { resolved: Boolean(provider.options.apiKey), source }
    }
    return out
  })
}
