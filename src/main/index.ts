import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { loadConfig, setAgentLoader, wallClockNote } from './config'
import { logLine } from './log'
import { listAgents, migrateFromConfig, seedBuiltins } from './agents'
import { loadSecrets } from './secrets'
import { loadShellEnvironment } from './shell-env'
import { registerIpc } from './ipc'
import { installMenu } from './menu'
import { startPreviewServer, stopPreviewServer } from './preview'
import { disposeRuntimes } from './runtime'
import { flush, listSessions, loadStore } from './store'
import { flushClaims, loadClaims } from './coordination'
import { dropOrphans } from './history'
import { loadBoards } from './boards'
import { reconcileOnStart, startBoardSync } from './board-sync'
import { startScheduler, stopScheduler } from './scheduler'
import { stopAll } from './agent/runner'
import { killAllTerminals } from './terminal'
import { killAllBackgroundTasks } from './background'
import { startWedgeWatch, stopWedgeWatch } from './watchdog'
import { disposeLocalModel } from './local-model'
import { disposeMcp } from './mcp'
import { disposeSandbox } from './sandbox'
import { isOwnWorkspace, makeWorkspaceDir } from './workspace'
import { deliverQueuedFollowUps } from './agent/runner'

const isDev = !app.isPackaged

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#191817',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The integrated browser pane uses <webview>.
      webviewTag: true
    }
  })

  win.on('ready-to-show', () => win.show())

  // Renderer failures are otherwise invisible from a terminal. Opt in with
  // OPENDESKTOP_DEBUG=1 to see them alongside the main-process output.
  if (process.env.OPENDESKTOP_DEBUG) {
    win.webContents.on('console-message', (event) => {
      console.log(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    })
    win.webContents.on('did-fail-load', (_e, code, description, url) => {
      console.log(`[renderer] failed to load ${url}: ${description} (${code})`)
    })
    win.webContents.on('did-finish-load', () => console.log('[renderer] loaded'))
    win.webContents.on('render-process-gone', (_e, details) =>
      console.log(`[renderer] gone: ${details.reason}`)
    )
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

void app.whenReady().then(async () => {
  // Must happen before the config is read: apiKey placeholders resolve against
  // process.env, and a Finder launch starts with almost none of it.
  const shellEnv = await loadShellEnvironment()
  if (process.env.OPENDESKTOP_DEBUG) {
    console.log(
      shellEnv.error
        ? `[env] could not read the login shell: ${shellEnv.error}`
        : `[env] merged ${shellEnv.loaded.length} variables from ${process.env.SHELL}`
    )
  }

  // Before loadConfig: {secret:...} placeholders resolve against this cache.
  const secrets = loadSecrets()
  if (process.env.OPENDESKTOP_DEBUG) {
    console.log(`[secrets] keychain=${secrets.available} stored=${secrets.names.length}${secrets.error ? ` (${secrets.error})` : ''}`)
  }

  // Agents used to live in config.json; move any that still do before the
  // config is read, then serve them from their own files from here on.
  const { readFileSync, existsSync } = await import('node:fs')
  const { CONFIG_PATH } = await import('./config')
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as { agent?: Record<string, never> }
      const moved = migrateFromConfig(raw.agent)
      if (moved > 0 && process.env.OPENDESKTOP_DEBUG) {
        console.log(`[agents] migrated ${moved} from config.json`)
      }
    } catch {
      /* a broken config is reported elsewhere */
    }
  }
  seedBuiltins()
  setAgentLoader(listAgents)

  loadConfig()
  // An invisible limit that still cuts turns off is the one nobody can debug.
  const wallClock = wallClockNote()
  if (wallClock) logLine('info', `config: ${wallClock}`)
  loadStore()
  // After the store, which is what says whose claims are still worth keeping.
  loadClaims()
  // Transcripts whose session is gone, now that the store has said what exists.
  const orphans = dropOrphans(listSessions().map((session) => session.id))
  if (orphans > 0 && process.env.OPENDESKTOP_DEBUG) {
    console.log(`[history] dropped ${orphans} transcript${orphans === 1 ? '' : 's'} with no session`)
  }
  /*
   * Any conversation whose folder is its own gets that folder back if it is
   * missing. Sessions made before the directory was created eagerly have a
   * path that points at nothing, and the pane that reads it should not have to
   * care which build made the session.
   */
  let healed = 0
  for (const session of listSessions()) {
    if (isOwnWorkspace(session.id, session.cwd) && !existsSync(session.cwd)) {
      makeWorkspaceDir(session.id)
      healed++
    }
  }
  if (healed > 0 && process.env.OPENDESKTOP_DEBUG) {
    console.log(`[workspaces] made ${healed} folder${healed === 1 ? '' : 's'} that were missing`)
  }

  loadBoards()
  startBoardSync()
  reconcileOnStart()
  startScheduler()
  // Anything typed into a running turn that the app never got to deliver — it
  // was persisted so that closing the app would not lose it, and this is the
  // half that makes that true.
  deliverQueuedFollowUps()
  startWedgeWatch()
  await startPreviewServer()
  registerIpc()
  installMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  stopWedgeWatch()
  stopScheduler()
  stopAll()
  killAllTerminals()
  killAllBackgroundTasks()
  flush()
  flushClaims()
  stopPreviewServer()
  // The local model server is this app's child process, so it goes when we do.
  disposeLocalModel()
  // ...and so is every tool server a session switched on.
  disposeMcp()
  // ...and every pentesting sandbox container is ours too; they are ephemeral.
  void disposeSandbox()
  void disposeRuntimes()
})
