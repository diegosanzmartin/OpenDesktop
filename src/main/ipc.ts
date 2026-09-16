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
import { listSshAliases } from './runtime/ssh'
import * as store from './store'
import * as history from './history'
import { isRunning, runTurn, stop } from './agent/runner'
import { listPending, resolveApproval, type ApprovalAnswer } from './approvals'
import { previewOrigin, previewUrl } from './preview'
import { deleteSecret, secretHint, secretStatus, setSecret } from './secrets'
import { createTerminal, killTerminal, resizeTerminal, terminalBuffer, writeTerminal } from './terminal'
import { readBranchSummary, readChanges, readFileDiff } from './git'
import { createBoard, deleteBoard, getBoard, listBoards, updateBoard, defaultBoardFor } from './boards'
import {
  columnOfKind,
  defaultColumns,
  findColumn,
  isDraggable,
  isManualColumn,
  statusForColumn
} from '@shared/boards'
import { tick } from './scheduler'
import {
  clearFinished,
  killBackgroundTask,
  killSessionTasks,
  listBackgroundTasks,
  readBackgroundOutput
} from './background'
import {
  AGENTS_DIR,
  agentFilePath,
  deleteAgent,
  importAgents,
  importableAgents,
  listAgents,
  saveAgent
} from './agents'
import {
  SKILLS_DIR,
  deleteSkill,
  importSkills,
  importableSkills,
  listSkills
} from './skills'
import { MANAGER_AGENT, type AgentConfig, type Attachment } from '@shared/types'
import {
  addFromBytes,
  addFromPaths,
  dropSessionAttachments,
  modelAcceptsImages,
  removeAttachment
} from './attachments'

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

  /* ---------- agents ---------- */
  ipcMain.handle('agents:list', () => listAgents())
  ipcMain.handle('agents:dir', () => AGENTS_DIR)
  ipcMain.handle('agents:save', async (_e, agent: AgentConfig) => {
    const saved = saveAgent(agent)
    bus.emit({ type: 'config.updated', config: rawConfig() })
    return saved
  })
  ipcMain.handle('agents:delete', (_e, id: string) => {
    deleteAgent(id)
    bus.emit({ type: 'config.updated', config: rawConfig() })
  })
  ipcMain.handle('agents:reveal', (_e, id: string) => shell.showItemInFolder(agentFilePath(id)))
  ipcMain.handle('agents:importable', () => importableAgents())
  ipcMain.handle('agents:import', (_e, ids: string[]) => {
    const count = importAgents(ids)
    bus.emit({ type: 'config.updated', config: rawConfig() })
    return count
  })

  /* ---------- skills ---------- */
  ipcMain.handle('skills:list', () => listSkills())
  ipcMain.handle('skills:dir', () => SKILLS_DIR)
  ipcMain.handle('skills:delete', (_e, id: string) => deleteSkill(id))
  ipcMain.handle('skills:reveal', () => shell.openPath(SKILLS_DIR))
  ipcMain.handle('skills:importable', () => importableSkills())
  ipcMain.handle('skills:import', (_e, ids: string[]) => importSkills(ids))

  /* ---------- secrets ---------- */
  ipcMain.handle('secrets:status', () => {
    const status = secretStatus()
    return {
      available: status.available,
      path: status.path,
      failed: status.failed,
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
  ipcMain.handle('env:sshAliases', () => listSshAliases())
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
        agentId: input.agentId ?? MANAGER_AGENT,
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
    killSessionTasks(id)
    dropSessionAttachments(id)
    store.deleteSession(id)
  })
  ipcMain.handle('session:clear', (_e, id: string) => {
    history.clearHistory(id)
    return store.updateSession(id, {})
  })
  ipcMain.handle(
    'session:fork',
    (_e, id: string, target?: { boardId?: string; columnId?: string }) => {
      const board = target?.boardId ? getBoard(target.boardId) : undefined
      const column = board
        ? (findColumn(board, target?.columnId) ?? columnOfKind(board, 'backlog') ?? board.columns[0])
        : undefined
      return store.forkSession(id, {
        boardId: board?.id,
        columnId: column?.id,
        standalone: Boolean(board)
      })
    }
  )
  ipcMain.handle('session:messages', (_e, id: string) => store.listMessages(id))
  ipcMain.handle('session:blocks', (_e, id: string) => store.listBlocks(id))
  ipcMain.handle('session:running', (_e, id: string) => isRunning(id))

  /* ---------- boards ---------- */
  ipcMain.handle('board:list', () => listBoards())
  ipcMain.handle(
    'board:create',
    (_e, input: { name?: string; cwd?: string; environmentId?: string }) => {
      const config = rawConfig()
      const environmentId = input.environmentId ?? 'local'
      return createBoard({
        name: input.name,
        cwd: input.cwd ?? config.environment[environmentId]?.cwd ?? homedir(),
        environmentId,
        columns: defaultColumns()
      })
    }
  )
  ipcMain.handle('board:update', (_e, id: string, patch: Record<string, unknown>) =>
    updateBoard(id, patch)
  )
  ipcMain.handle('board:delete', (_e, id: string) => {
    // The cards outlive the board: they go back to being ordinary chats.
    for (const session of store.listSessions()) {
      if (session.boardId === id) {
        store.updateSession(session.id, { boardId: undefined, columnId: undefined })
      }
    }
    deleteBoard(id)
  })

  /**
   * Creating a task is creating a session plus its placement. Dropping it in a
   * queueing column marks it `queued` and hands it to the scheduler; anywhere
   * else it just sits there until someone moves it.
   */
  ipcMain.handle(
    'board:createTask',
    (
      _e,
      input: {
        boardId?: string
        columnId?: string
        title?: string
        prompt?: string
        agentId?: string
        model?: string
        parentSessionId?: string
      }
    ) => {
      const config = rawConfig()
      const board = (input.boardId && getBoard(input.boardId)) || undefined
      const target = board ?? defaultBoardFor(config.environment.local?.cwd ?? homedir(), 'local')
      const column =
        findColumn(target, input.columnId) ?? columnOfKind(target, 'todo') ?? target.columns[0]

      const session = store.createSession({
        title: input.title?.trim() || 'New task',
        cwd: target.cwd,
        environmentId: target.environmentId,
        agentId: input.agentId ?? MANAGER_AGENT,
        model: input.model ?? config.model,
        parentSessionId: input.parentSessionId
      })

      // A task created without instructions is an empty chat waiting for them;
      // it is only queued once there is something to send.
      const queueing = Boolean(input.prompt) && (column.kind === 'todo' || column.kind === 'in-progress')
      store.updateSession(session.id, {
        boardId: target.id,
        columnId: column.id,
        order: Date.now(),
        queuedPrompt: input.prompt || undefined,
        status: queueing ? 'queued' : 'idle'
      })
      void tick()
      return store.getSession(session.id)
    }
  )

  /** A drag. The column carries the intent; the status follows it. */
  ipcMain.handle(
    'board:moveTask',
    (_e, input: { sessionId: string; boardId: string; columnId: string; order?: number }) => {
      const session = store.getSession(input.sessionId)
      const board = getBoard(input.boardId)
      if (!session || !board) return undefined
      const column = findColumn(board, input.columnId)
      if (!column) return undefined

      // Checked here and not only in the UI: In progress and Blocked are
      // readings of what the chat is doing, so accepting a hand-placed card
      // there would let the board assert something untrue.
      if (!isManualColumn(column.kind) || !isDraggable(session)) return undefined

      const status = statusForColumn(column.kind, session.status)
      const updated = store.updateSession(session.id, {
        boardId: board.id,
        columnId: column.id,
        order: input.order ?? Date.now(),
        status,
        // Queueing something with nothing to send would spin the scheduler.
        queuedPrompt: status === 'queued' ? (session.queuedPrompt ?? '') : session.queuedPrompt,
        blockedReason: column.kind === 'blocked' ? session.blockedReason : undefined
      })
      void tick()
      return updated
    }
  )

  /** Puts an existing chat on a board, so a conversation can become a task. */
  ipcMain.handle(
    'board:addSession',
    (_e, input: { sessionId: string; boardId: string; columnId?: string }) => {
      const board = getBoard(input.boardId)
      const session = store.getSession(input.sessionId)
      if (!board || !session) return undefined
      const column =
        findColumn(board, input.columnId) ?? columnOfKind(board, 'backlog') ?? board.columns[0]
      return store.updateSession(session.id, { boardId: board.id, columnId: column.id, order: Date.now() })
    }
  )

  ipcMain.handle('board:removeSession', (_e, sessionId: string) =>
    store.updateSession(sessionId, { boardId: undefined, columnId: undefined, queuedPrompt: undefined })
  )

  /**
   * A command the user ran themselves, from a code block in the transcript.
   *
   * No approval: clicking the button is the approval, and no agent is involved
   * — this is a person running a command they can read, on the session's own
   * host and folder, which is exactly what the terminal beside it would do.
   */
  ipcMain.handle('shell:run', async (_e, sessionId: string, command: string) => {
    const session = store.getSession(sessionId)
    if (!session) return { stdout: '', stderr: 'unknown session', exitCode: 1 }
    try {
      const runtime = getRuntime(session.environmentId)
      await runtime.connect()
      const res = await runtime.exec(command, {
        cwd: session.cwd,
        timeoutMs: 120_000,
        maxBytes: 200_000
      })
      return { stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode }
    } catch (err) {
      return { stdout: '', stderr: (err as Error).message, exitCode: 1 }
    }
  })

  /* ---------- attachments ---------- */
  ipcMain.handle('attachments:pick', async (_e, sessionId: string) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Attach files'
    })
    if (result.canceled) return { added: [], errors: [] }
    return addFromPaths(sessionId, result.filePaths)
  })
  ipcMain.handle('attachments:addPaths', (_e, sessionId: string, paths: string[]) =>
    addFromPaths(sessionId, paths)
  )
  ipcMain.handle(
    'attachments:addBytes',
    (_e, sessionId: string, name: string, mediaType: string, bytes: Uint8Array) =>
      addFromBytes(sessionId, name, mediaType, bytes)
  )
  ipcMain.handle('attachments:remove', (_e, path: string) => removeAttachment(path))
  ipcMain.handle('attachments:accepted', (_e, model: string) => ({
    images: modelAcceptsImages(rawConfig(), model)
  }))

  /* ---------- turns ---------- */
  ipcMain.handle(
    'turn:send',
    async (_e, sessionId: string, text: string, attachments?: Attachment[]) => {
      // On a board, the column the card sits in decides whether this runs now
      // or joins the queue. That is what the column is for: a task in To do
      // means "do this when there is room", and honouring it here is what lets
      // a person line up ten tasks through the ordinary composer.
      const session = store.getSession(sessionId)
      const board = session?.boardId ? getBoard(session.boardId) : undefined
      const column = board && findColumn(board, session!.columnId)

      if (session && column && (column.kind === 'todo' || column.kind === 'backlog')) {
        store.updateSession(session.id, {
          queuedPrompt: text,
          status: column.kind === 'todo' ? 'queued' : 'idle',
          title:
            session.title === 'New task' || session.title === 'New session'
              ? text.replace(/\s+/g, ' ').slice(0, 70) || session.title
              : session.title
        })
        void tick()
        return true
      }

      void runTurn({ sessionId, userText: text, attachments }).catch(() => undefined)
      return true
    }
  )
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

  /* ---------- background tasks ---------- */
  ipcMain.handle('background:list', (_e, sessionId?: string) => listBackgroundTasks(sessionId))
  ipcMain.handle('background:kill', (_e, id: string) => killBackgroundTask(id))
  ipcMain.handle('background:clear', (_e, sessionId?: string) => clearFinished(sessionId))
  ipcMain.handle('background:peek', (_e, id: string) => readBackgroundOutput(id, true))

  /* ---------- git ---------- */
  ipcMain.handle('git:changes', (_e, environmentId: string, cwd: string) =>
    readChanges(environmentId, cwd)
  )
  ipcMain.handle('git:summary', (_e, environmentId: string, cwd: string) =>
    readBranchSummary(environmentId, cwd)
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
  ipcMain.handle('fs:stat', async (_e, environmentId: string, path: string) => {
    try {
      const runtime = getRuntime(environmentId)
      await runtime.connect()
      return await runtime.stat(path)
    } catch {
      return null
    }
  })

  /**
   * Saves a file the agent produced to wherever the user wants it.
   *
   * Goes through the runtime, so a document written on a remote host is
   * fetched over the same connection that made it rather than needing the user
   * to go and find it there.
   */
  ipcMain.handle('fs:download', async (_e, environmentId: string, path: string) => {
    const name = path.split('/').filter(Boolean).pop() ?? 'download'
    const result = await dialog.showSaveDialog({ defaultPath: name, title: `Save ${name}` })
    if (result.canceled || !result.filePath) return { saved: false as const }
    try {
      const runtime = getRuntime(environmentId)
      await runtime.connect()
      const bytes = await runtime.readFileBuffer(path)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(result.filePath, bytes)
      return { saved: true as const, path: result.filePath }
    } catch (err) {
      return { saved: false as const, error: (err as Error).message }
    }
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
