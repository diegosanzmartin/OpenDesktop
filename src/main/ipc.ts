import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AppConfig } from '@shared/types'
import type { Savings } from '@shared/savings'
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
import { discoverModels } from './discover'
import { getRuntime, resetRuntimes, testEnvironment } from './runtime'
import { cachedRtkStatus, forgetRtkStatus, rtkStatus } from './rtk'
import { browse, dirIndex, forgetDirIndex, searchRoot } from './browse'
import { installRtk } from './rtk'
import { connectMcp, statusOf, stopMcp } from './mcp'
import {
  installLocalModel,
  localStatus,
  removeLocalModel,
  startLocalModel,
  stopLocalModel
} from './local-model'
import { meterSnapshot, resetMeter } from './meter'
import { logLine, logPath } from './log'
import { describeError } from '@shared/errors'
import { readForEditor, writeFromEditor } from './editor'
import { describeNeighbours } from './coordination'
import { createWorktree, removeWorktree, worktreeOffer, worktreeStatus } from './worktree'
import {
  buildImage,
  closeScope,
  openScope,
  refreshSandbox,
  removeContainer,
  sandboxStatus
} from './sandbox'
import { listSshAliases } from './runtime/ssh'
import * as store from './store'
import * as history from './history'
import { compactNow, isRunning, queueFollowUp, runTurn, stop } from './agent/runner'
import { forkFrom, rewind } from './rewind'
import { deniedSegment, listPending, resolveApproval, type ApprovalAnswer } from './approvals'
import { previewOrigin, previewUrl } from './preview'
import {
  WORKSPACES_DIR,
  makeWorkspaceDir,
  removeWorkspace,
  summariseWorkspace
} from './workspace'
import { deleteSecret, secretHint, secretStatus, setSecret } from './secrets'
import { createTerminal, killTerminal, resizeTerminal, terminalBuffer, writeTerminal } from './terminal'
import {
  readBlame,
  readBranchSummary,
  readChanges,
  readCommit,
  readFileAt,
  readFileDiff,
  readLog
} from './git'
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
  // An environment may now point somewhere else entirely, so what was probed
  // on the old one says nothing about the new one.
  forgetRtkStatus()
  forgetDirIndex()
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

  /**
   * What models this key can see, asked of the provider itself.
   *
   * The alternative is typing ids by hand, which is how a provider ends up
   * configured with a typo that only shows as a failed turn much later.
   */
  ipcMain.handle('models:discover', (_e, providerId: string) =>
    discoverModels(resolvedConfig(), providerId)
  )

  /** What has been spent on each model, for the allowance counters. */
  ipcMain.handle('meter:get', () => meterSnapshot())
  ipcMain.handle('meter:reset', () => {
    resetMeter()
    return meterSnapshot()
  })

  /*
   * Whether rtk can do anything on a given target.
   *
   * `probe` is honoured for the local machine only. Asking the question of a
   * remote target means opening the connection, and the mode picker is not a
   * reason to dial an SSH host — the first turn that needs it probes it anyway,
   * and until then the honest answer is that nobody has looked.
   */
  ipcMain.handle('rtk:status', async (_e, environmentId: string, probe?: boolean) => {
    const known = cachedRtkStatus(environmentId)
    if (known.state !== 'unknown' || !probe) return known
    const config = rawConfig()
    if (config.environment[environmentId]?.kind !== 'local') return known
    const runtime = getRuntime(environmentId)
    return rtkStatus(environmentId, runtime, config.environment[environmentId]?.cwd ?? homedir())
  })

  /**
   * Puts rtk on a target, when asked to.
   *
   * Never on a probe and never on a turn: this downloads an executable onto
   * somebody's machine, so it happens on a click and nowhere else.
   */
  ipcMain.handle('rtk:install', async (_e, environmentId: string) => {
    const config = rawConfig()
    const runtime = getRuntime(environmentId)
    const cwd = config.environment[environmentId]?.cwd ?? (await runtime.homeDir()) ?? '/'
    const result = await installRtk(environmentId, runtime, cwd)
    logLine(result.ok ? 'info' : 'warn', `rtk install on ${environmentId}: ${result.message}`)
    bus.emit({ type: 'toast', level: result.ok ? 'info' : 'error', message: result.message })
    return result
  })

  /*
   * The model that runs on this machine.
   *
   * Install is one call on purpose: it fetches the runtime, fetches the
   * weights, verifies both, declares the provider and fills in the model, so
   * the only thing the page has to know is that it takes a few minutes. Every
   * one of these answers with the whole status, and the same status is pushed
   * on the bus while a download is running.
   */
  ipcMain.handle('local:status', () => localStatus())
  ipcMain.handle('local:install', async (_e, modelId?: string) => {
    const status = await installLocalModel(modelId)
    // It declared a provider while we were waiting, so what was resolved
    // before is a provider list that did not have it in it.
    invalidateProviderCache()
    return status
  })
  ipcMain.handle('local:start', (_e, modelId?: string) => startLocalModel(modelId))
  ipcMain.handle('local:stop', () => stopLocalModel('you stopped it'))
  ipcMain.handle('local:remove', (_e, modelId?: string) => {
    const status = removeLocalModel(modelId)
    invalidateProviderCache()
    return status
  })

  /* ---- the pentesting sandbox ---- */

  ipcMain.handle('sandbox:status', () => refreshSandbox())
  ipcMain.handle('sandbox:build', () => {
    // Where the Dockerfile landed: beside the app's resources when packaged, in
    // the repo in dev. The image is built locally; only its base is pulled.
    const context = app.isPackaged
      ? join(process.resourcesPath, 'pentest')
      : join(app.getAppPath(), 'build', 'pentest')
    return buildImage(context)
  })
  ipcMain.handle('sandbox:scope', (_e, sessionId: string, targets: string[], note: string) =>
    openScope(sessionId, targets, note)
  )
  ipcMain.handle('sandbox:clearScope', async (_e, sessionId: string) => {
    await closeScope(sessionId)
    return true
  })

  /*
   * Tool servers: declared in the config, connected on demand, and measured.
   *
   * `mcp:connect` is what the settings page presses to find out what a server
   * offers and what its schemas weigh — the number that decides whether it is
   * worth switching on for a session.
   */
  ipcMain.handle('mcp:list', () =>
    Object.values(rawConfig().mcp ?? {}).map((server) => statusOf(server))
  )
  ipcMain.handle('mcp:connect', async (_e, id: string) => {
    const server = resolvedConfig().mcp?.[id]
    if (!server) return null
    const status = await connectMcp(server)
    logLine(
      status.state === 'ready' ? 'info' : 'warn',
      `mcp ${id}: ${status.state}${status.state === 'ready' ? ` (${status.tools.length} tools, ~${status.tokens} tokens)` : `: ${status.message ?? ''}`}`
    )
    return status
  })
  ipcMain.handle('mcp:stop', (_e, id?: string) => {
    stopMcp(id)
    return Object.values(rawConfig().mcp ?? {}).map((server) => statusOf(server))
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
      input: {
        cwd?: string
        environmentId?: string
        agentId?: string
        model?: string
        title?: string
        savings?: Partial<Savings>
        autoApprove?: boolean
      }
    ) => {
      const config = rawConfig()
      const environmentId = input.environmentId ?? 'local'
      /*
       * No folder chosen means the conversation's own, not the home directory.
       *
       * The default used to be the local environment's working directory,
       * which is `~` — so a question that produced a file put it in the home
       * directory, and the next one put another beside it with nothing to say
       * which conversation either came from. A remote session keeps the
       * environment's directory: a workspace is a folder on this machine and
       * would mean nothing over there.
       */
      const remote = config.environment[environmentId]?.kind !== 'local'
      const fallback = config.environment[environmentId]?.cwd ?? homedir()
      const session = store.createSession({
        title: input.title,
        cwd: input.cwd ?? fallback,
        environmentId,
        agentId: input.agentId ?? MANAGER_AGENT,
        model: input.model ?? config.model,
        savings: input.savings ?? config.savings,
        autoApprove: input.autoApprove ?? config.autoApprove
      })
      /*
       * Pointed at its own folder once it has an id to name it after — the
       * folder is not made until the first turn needs it, so a conversation
       * that only ever asked a question leaves nothing behind.
       */
      if (!input.cwd && !remote) {
        return store.updateSession(session.id, { cwd: makeWorkspaceDir(session.id) }) ?? session
      }
      return session
    }
  )
  ipcMain.handle('session:update', async (_e, id: string, patch: Record<string, unknown>) => {
    /*
     * Pointing a conversation at a different folder while it has a checkout of
     * its own hands the checkout back first. Otherwise it stays on disk with
     * nothing left pointing at it: `git worktree list` keeps naming it, the
     * branch keeps whatever was in it, and nobody has any way to find either.
     * Guarded here rather than in the folder picker because there is more than
     * one way to move a conversation.
     */
    const before = store.getSession(id)
    if (
      before?.worktree &&
      typeof patch.cwd === 'string' &&
      patch.cwd !== before.cwd &&
      !('worktree' in patch)
    ) {
      const removal = await removeWorktree(before)
      if (removal.error) bus.emit({ type: 'toast', level: 'warn', message: removal.error })
      else store.updateSession(id, { worktree: undefined })
    }
    return store.updateSession(id, patch)
  })
  /**
   * Where conversations' own folders live, asked once by the interface: it
   * decides from a path whether a file is something to open, and the root
   * moves with the app's own root.
   */
  ipcMain.handle('workspace:root', () => WORKSPACES_DIR)

  /** What deleting this conversation would take with it, for the prompt. */
  ipcMain.handle('session:workspace', (_e, id: string) => summariseWorkspace(id))

  ipcMain.handle('session:delete', async (_e, id: string) => {
    /*
     * The subagents go with it. A `task` call runs in its own session, and
     * deleting only the parent left those behind as chats whose context no
     * longer exists anywhere — two delegating tasks left five of them. Deepest
     * first, so a grandchild is never orphaned by its parent going first.
     */
    for (const child of store.descendantsOf(id).reverse()) {
      if (isRunning(child.id)) stop(child.id)
      history.clearHistory(child.id)
      killSessionTasks(child.id)
      dropSessionAttachments(child.id)
      store.deleteSession(child.id)
    }
    if (isRunning(id)) stop(id)
    history.clearHistory(id)
    killSessionTasks(id)
    dropSessionAttachments(id)
    // Its own folder goes with it — only ever the one named after it.
    removeWorkspace(id)
    /*
     * A checkout of somebody's repository goes too, but the branch stays: the
     * checkout is disposable and the branch is the work. Anything left
     * uncommitted in it is committed to that branch on the way out rather than
     * discarded, and if that cannot be done the checkout is left where it is
     * and the user is told where.
     */
    const doomed = store.getSession(id)
    // A sandbox session's container and network are ephemeral: they go with the
    // conversation, and nothing they held was meant to outlive it.
    if (doomed?.environmentId && resolvedConfig().environment[doomed.environmentId]?.kind === 'container') {
      await removeContainer(id).catch(() => undefined)
    }
    if (doomed?.worktree) {
      const removal = await removeWorktree(doomed)
      if (removal.error) {
        bus.emit({ type: 'toast', level: 'warn', message: removal.error })
      } else if (removal.branch) {
        bus.emit({
          type: 'toast',
          level: 'info',
          message: `${removal.branch} is still there${removal.committed ? ', with what was left uncommitted' : ''}.`
        })
      }
    }
    store.deleteSession(id)
  })

  /* ---- a branch of its own ---- */

  ipcMain.handle('worktree:offer', (_e, id: string) => {
    const session = store.getSession(id)
    return session ? worktreeOffer(session) : { eligible: false, reason: 'no such conversation' }
  })

  ipcMain.handle('worktree:create', async (_e, id: string) => {
    const session = store.getSession(id)
    if (!session) return { error: 'no such conversation' }
    const made = await createWorktree(session)
    if (made.error || !made.worktree || !made.path) return { error: made.error ?? 'git refused' }
    // The conversation moves into it. Everything that reads `cwd` — the tools,
    // the Files pane, the Changes pane — follows without knowing about any of
    // this.
    store.updateSession(id, { cwd: made.path, worktree: made.worktree })
    return made
  })

  ipcMain.handle('worktree:remove', async (_e, id: string) => {
    const session = store.getSession(id)
    if (!session?.worktree) return {}
    const removal = await removeWorktree(session)
    if (removal.error) return removal
    store.updateSession(id, { cwd: removal.cwd ?? session.worktree.repoRoot, worktree: undefined })
    return removal
  })

  ipcMain.handle('worktree:status', (_e, id: string) => {
    const session = store.getSession(id)
    return session ? worktreeStatus(session) : null
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
  ipcMain.handle('session:compact', (_e, id: string) => compactNow(id))
  ipcMain.handle('session:rewind', (_e, id: string, messageId: string) => rewind(id, messageId))
  ipcMain.handle('session:forkFrom', (_e, id: string, messageId: string) =>
    forkFrom(id, messageId)
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

    // No approval prompt — the click is the approval, and the command is right
    // there to read. The denylist still applies: it exists for the handful of
    // things that should not run however they were asked for, and a model can
    // put one of those in a fenced block for someone to click.
    const blocked = deniedSegment(resolvedConfig().permissions, command)
    if (blocked) {
      return {
        stdout: '',
        stderr: `Refused: "${blocked}" matches the denylist in your permissions.`,
        exitCode: 126
      }
    }

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

      /*
       * Typing while it works is not an error. The message waits and goes as
       * the next turn the moment this one stops — the alternative was a silent
       * refusal, and the thought being gone by the time the turn ended.
       */
      if (isRunning(sessionId)) {
        queueFollowUp(sessionId, text)
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
    readChanges(environmentId, cwd).catch(() => ({
      isRepo: false,
      root: '',
      branch: '',
      files: [],
      added: 0,
      removed: 0
    }))
  )
  ipcMain.handle('git:summary', (_e, environmentId: string, cwd: string) =>
    readBranchSummary(environmentId, cwd).catch(() => ({ isRepo: false, branch: '', dirty: 0 }))
  )
  /*
   * The history, which the Changes pane reads beside the working tree. In a
   * conversation's own folder this is the conversation: one commit per turn,
   * its subject the thing that was asked.
   */
  ipcMain.handle(
    'git:log',
    (_e, environmentId: string, cwd: string, options?: { limit?: number; path?: string }) =>
      readLog(environmentId, cwd, options)
  )
  ipcMain.handle('git:commit', (_e, environmentId: string, cwd: string, hash: string) =>
    readCommit(environmentId, cwd, hash)
  )
  ipcMain.handle(
    'git:fileAt',
    (_e, environmentId: string, cwd: string, hash: string, path: string) =>
      readFileAt(environmentId, cwd, hash, path)
  )
  ipcMain.handle(
    'git:blame',
    (_e, environmentId: string, cwd: string, path: string, options?: { from?: number; lines?: number }) =>
      readBlame(environmentId, cwd, path, options)
  )

  ipcMain.handle('git:diff', (_e, environmentId: string, cwd: string, path: string, untracked: boolean) =>
    readFileDiff(environmentId, cwd, path, untracked)
  )

  /* ---------- files & preview ---------- */
  /*
   * A folder that is not there is an answer, not an error.
   *
   * It threw `ENOENT: scandir` at whoever opened the Files pane on a
   * conversation whose folder had not been made yet — and the same is true of
   * a folder somebody deleted, or a remote host that has just gone away. The
   * pane can say "there is nothing here"; it cannot do anything with an
   * exception from a method it did not know it was calling.
   */
  ipcMain.handle('fs:list', async (_e, environmentId: string, path: string, sessionId?: string) => {
    try {
      const runtime = getRuntime(environmentId, sessionId)
      await runtime.connect()
      const target = path || (await runtime.homeDir())
      return { path: target, entries: await runtime.list(target) }
    } catch (err) {
      return { path, entries: [], error: describeError(err) }
    }
  })
  /* The folder picker: one call per step while browsing, one call for a whole
     tree when searching. See src/main/browse.ts for why they differ. */
  ipcMain.handle('fs:browse', async (_e, environmentId: string, path: string) =>
    browse(getRuntime(environmentId), path).catch(() => ({
      path,
      home: '',
      parent: '',
      dirs: []
    }))
  )
  ipcMain.handle(
    'fs:findDirs',
    async (_e, environmentId: string, cwd: string, refresh?: boolean) => {
      try {
        const runtime = getRuntime(environmentId)
        await runtime.connect()
        const home = (await runtime.homeDir()) || '/'
        const root = searchRoot(cwd, home)
        return await dirIndex(environmentId, runtime, root, refresh === true)
      } catch (err) {
        return { root: cwd, dirs: [], truncated: false, builtAt: Date.now(), error: describeError(err) }
      }
    }
  )

  ipcMain.handle('fs:read', async (_e, environmentId: string, path: string, sessionId?: string) => {
    const runtime = getRuntime(environmentId, sessionId)
    await runtime.connect()
    return runtime.readFile(path)
  })

  /**
   * Who else has changed the files this conversation has changed. Asked by the
   * line above the composer, on open and whenever a claim is recorded.
   */
  ipcMain.handle('coordination:neighbours', (_e, sessionId: string) =>
    describeNeighbours(sessionId)
  )

  /* The editor pane. Its failures are values; see `editor.ts` for why. */
  ipcMain.handle('editor:read', (_e, environmentId: string, path: string, sessionId?: string) =>
    readForEditor(environmentId, path, sessionId)
  )
  ipcMain.handle('editor:write', (_e, environmentId: string, path: string, text: string, sessionId?: string) =>
    writeFromEditor(environmentId, path, text, sessionId)
  )

  ipcMain.handle('fs:stat', async (_e, environmentId: string, path: string, sessionId?: string) => {
    try {
      const runtime = getRuntime(environmentId, sessionId)
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
  ipcMain.handle('fs:download', async (_e, environmentId: string, path: string, sessionId?: string) => {
    const name = path.split('/').filter(Boolean).pop() ?? 'download'
    const result = await dialog.showSaveDialog({ defaultPath: name, title: `Save ${name}` })
    if (result.canceled || !result.filePath) return { saved: false as const }
    try {
      const runtime = getRuntime(environmentId, sessionId)
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
  ipcMain.handle('host:logPath', () => logPath())
  ipcMain.handle('host:revealLog', () => shell.showItemInFolder(logPath()))
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
