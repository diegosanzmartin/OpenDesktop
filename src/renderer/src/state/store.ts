import { create } from 'zustand'
import type {
  ActivityQuery,
  AppConfig,
  AppEvent,
  ApprovalRequest,
  Block,
  Message,
  RepoChanges,
  Session,
  Skill
} from '@shared/types'
import { AUTO_AGENT } from '@shared/types'

/** What the right-hand dock is showing. The centre column is always the chat. */
export type DockTab = 'changes' | 'terminal' | 'browser' | 'files' | 'activity'

export type SessionGroupBy = 'none' | 'folder' | 'status' | 'date' | 'environment' | 'agent'
export type SessionSortBy = 'recent' | 'oldest' | 'title' | 'folder' | 'status'

export interface SessionQuery {
  groupBy: SessionGroupBy
  sortBy: SessionSortBy
  search: string
  environments: string[]
  agents: string[]
  statuses: Session['status'][]
  showArchived: boolean
}

interface Toast {
  id: number
  level: 'info' | 'warn' | 'error'
  message: string
}

interface State {
  ready: boolean
  config: AppConfig | null
  models: { ref: string; label: string; provider: string }[]
  skills: Skill[]
  keyStatus: Record<string, { resolved: boolean; source: string }>
  secrets: { available: boolean; path: string; failed: string[]; hints: Record<string, string | null> }

  sessions: Session[]
  activeSessionId: string | null
  messages: Record<string, Message[]>
  blocks: Record<string, Block>
  activity: Block[]
  approvals: ApprovalRequest[]
  envStatus: Record<string, { connected: boolean; message?: string }>
  toasts: Toast[]

  dock: { open: boolean; tab: DockTab; width: number }
  sidebarCollapsed: boolean
  settingsOpen: boolean
  changes: RepoChanges | null
  changesLoading: boolean
  sessionQuery: SessionQuery
  activityQuery: ActivityQuery
  browserUrl: string
  /** Block ids expanded in the transcript. */
  expanded: Record<string, boolean>
  activityCollapsed: boolean

  bootstrap: () => Promise<void>
  applyEvent: (event: AppEvent) => void
  selectSession: (id: string) => Promise<void>
  newSession: (input?: {
    cwd?: string
    environmentId?: string
    agentId?: string
    model?: string
  }) => Promise<void>
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  openDock: (tab: DockTab) => void
  toggleDock: (tab: DockTab) => void
  closeDock: () => void
  setDockWidth: (width: number) => void
  toggleSidebar: () => void
  setSettingsOpen: (open: boolean) => void
  refreshChanges: () => Promise<void>
  setSessionQuery: (patch: Partial<SessionQuery>) => void
  setActivityQuery: (patch: Partial<ActivityQuery>) => void
  setBrowserUrl: (url: string) => void
  toggleBlock: (id: string) => void
  setExpanded: (id: string, value: boolean) => void
  toggleActivity: () => void
  refreshActivity: () => Promise<void>
  refreshConfig: () => Promise<void>
  refreshSecrets: () => Promise<void>
  refreshSkills: () => Promise<void>
  pushToast: (level: Toast['level'], message: string) => void
  dismissToast: (id: number) => void
}

const api = (): Window['opendesktop'] => window.opendesktop

let toastSeq = 0

export const useStore = create<State>((set, get) => ({
  ready: false,
  config: null,
  models: [],
  skills: [],
  keyStatus: {},
  secrets: { available: false, path: '', failed: [], hints: {} },

  sessions: [],
  activeSessionId: null,
  messages: {},
  blocks: {},
  activity: [],
  approvals: [],
  envStatus: {},
  toasts: [],

  dock: { open: false, tab: 'changes', width: 460 },
  sidebarCollapsed: false,
  settingsOpen: false,
  changes: null,
  changesLoading: false,
  sessionQuery: {
    groupBy: 'date',
    sortBy: 'recent',
    search: '',
    environments: [],
    agents: [],
    statuses: [],
    showArchived: false
  },
  activityQuery: {
    groupBy: 'none',
    sortBy: 'recent',
    search: '',
    statuses: [],
    environments: [],
    agents: [],
    tools: [],
    sessionId: null,
    since: null
  },
  browserUrl: '',
  expanded: {},
  activityCollapsed: false,

  async bootstrap() {
    const [config, models, sessions, approvals, activity, keyStatus, secrets, skills] =
      await Promise.all([
        api().config.get(),
        api().models.list(),
        api().sessions.list(),
        api().approvals.list(),
        api().activity.all(),
        api().config.keyStatus(),
        api().secrets.status(),
        api().skills.list()
      ])
    const blocks: Record<string, Block> = {}
    for (const block of activity) blocks[block.id] = block

    set({
      config,
      models,
      sessions,
      approvals,
      activity,
      blocks,
      keyStatus,
      secrets,
      skills,
      ready: true
    })

    if (sessions.length > 0) await get().selectSession(sessions[0].id)
    else await get().newSession()
  },

  applyEvent(event) {
    const state = get()
    switch (event.type) {
      case 'config.updated':
        set({ config: event.config })
        void api().models.list().then((models) => set({ models }))
        break

      case 'session.created':
        set({
          sessions: [event.session, ...state.sessions.filter((s) => s.id !== event.session.id)],
          // A subagent's transcript is rendered inline in its parent, so start
          // collecting its messages as they stream rather than fetching later.
          messages: event.session.parentSessionId
            ? { ...state.messages, [event.session.id]: [] }
            : state.messages
        })
        break

      case 'session.updated':
        set({
          sessions: state.sessions
            .map((s) => (s.id === event.session.id ? event.session : s))
            .sort((a, b) => b.updatedAt - a.updatedAt)
        })
        break

      case 'session.deleted': {
        const sessions = state.sessions.filter((s) => s.id !== event.sessionId)
        set({ sessions })
        if (state.activeSessionId === event.sessionId && sessions.length > 0) {
          void get().selectSession(sessions[0].id)
        }
        break
      }

      case 'message.created':
        set({
          messages: {
            ...state.messages,
            [event.message.sessionId]: [
              ...(state.messages[event.message.sessionId] ?? []).filter((m) => m.id !== event.message.id),
              event.message
            ]
          }
        })
        break

      case 'message.updated':
        set({
          messages: {
            ...state.messages,
            [event.message.sessionId]: (state.messages[event.message.sessionId] ?? []).map((m) =>
              m.id === event.message.id ? event.message : m
            )
          }
        })
        break

      case 'message.part.delta': {
        const list = state.messages[event.sessionId] ?? []
        set({
          messages: {
            ...state.messages,
            [event.sessionId]: list.map((m) => {
              if (m.id !== event.messageId) return m
              const parts = m.parts.slice()
              const part = parts[event.partIndex]
              if (part) parts[event.partIndex] = { ...part, text: (part.text ?? '') + event.text }
              return { ...m, parts }
            })
          }
        })
        break
      }

      case 'block.created':
        set({
          blocks: { ...state.blocks, [event.block.id]: event.block },
          activity: [event.block, ...state.activity].slice(0, 800)
        })
        break

      case 'block.updated':
        set({
          blocks: { ...state.blocks, [event.block.id]: event.block },
          activity: state.activity.map((b) => (b.id === event.block.id ? event.block : b))
        })
        break

      case 'block.output': {
        const existing = state.blocks[event.blockId]
        if (!existing) break
        const next = { ...existing, output: existing.output + event.chunk }
        set({
          blocks: { ...state.blocks, [event.blockId]: next },
          activity: state.activity.map((b) => (b.id === event.blockId ? next : b))
        })
        break
      }

      case 'approval.requested':
        set({ approvals: [...state.approvals, event.request] })
        break

      case 'approval.resolved':
        set({ approvals: state.approvals.filter((a) => a.id !== event.approvalId) })
        break

      case 'environment.status':
        set({
          envStatus: {
            ...state.envStatus,
            [event.environmentId]: { connected: event.connected, message: event.message }
          }
        })
        break

      case 'toast':
        get().pushToast(event.level, event.message)
        break
    }
  },

  async selectSession(id) {
    set({ activeSessionId: id, changes: null })
    const [messages, blocks] = await Promise.all([api().sessions.messages(id), api().sessions.blocks(id)])
    const map = { ...get().blocks }
    for (const block of blocks) map[block.id] = block
    set({ messages: { ...get().messages, [id]: messages }, blocks: map })
  },

  async newSession(input) {
    const config = get().config
    const session = await api().sessions.create({
      environmentId: input?.environmentId ?? 'local',
      cwd: input?.cwd,
      // No agent pinned by default: the orchestrator decides per request.
      agentId: input?.agentId ?? AUTO_AGENT,
      model: input?.model ?? config?.model
    })
    await get().selectSession(session.id)
  },

  async send(text) {
    const id = get().activeSessionId
    if (!id || !text.trim()) return
    await api().turn.send(id, text)
  },

  async stop() {
    const id = get().activeSessionId
    if (id) await api().turn.stop(id)
  },

  openDock: (tab) => set({ dock: { ...get().dock, open: true, tab } }),
  toggleDock: (tab) => {
    const dock = get().dock
    set({ dock: { ...dock, open: !(dock.open && dock.tab === tab), tab } })
    if (tab === 'changes') void get().refreshChanges()
  },
  closeDock: () => set({ dock: { ...get().dock, open: false } }),
  setDockWidth: (width) => set({ dock: { ...get().dock, width: Math.min(900, Math.max(320, width)) } }),
  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  async refreshChanges() {
    const session = get().sessions.find((s) => s.id === get().activeSessionId)
    if (!session) return set({ changes: null })
    set({ changesLoading: true })
    try {
      set({ changes: await api().git.changes(session.environmentId, session.cwd) })
    } catch {
      set({ changes: null })
    } finally {
      set({ changesLoading: false })
    }
  },

  setSessionQuery: (patch) => set({ sessionQuery: { ...get().sessionQuery, ...patch } }),
  setActivityQuery: (patch) => set({ activityQuery: { ...get().activityQuery, ...patch } }),
  setBrowserUrl: (browserUrl) => set({ browserUrl }),
  toggleBlock: (id) => set({ expanded: { ...get().expanded, [id]: !get().expanded[id] } }),
  setExpanded: (id, value) => set({ expanded: { ...get().expanded, [id]: value } }),
  toggleActivity: () => set({ activityCollapsed: !get().activityCollapsed }),

  async refreshActivity() {
    const activity = await api().activity.all()
    const blocks = { ...get().blocks }
    for (const block of activity) blocks[block.id] = block
    set({ activity, blocks })
  },

  async refreshSkills() {
    set({ skills: await api().skills.list() })
  },

  async refreshSecrets() {
    const [secrets, keyStatus] = await Promise.all([api().secrets.status(), api().config.keyStatus()])
    set({ secrets, keyStatus })
  },

  async refreshConfig() {
    const [config, models, keyStatus] = await Promise.all([
      api().config.get(),
      api().models.list(),
      api().config.keyStatus()
    ])
    set({ config, models, keyStatus })
  },

  pushToast: (level, message) =>
    set({ toasts: [...get().toasts, { id: ++toastSeq, level, message }].slice(-4) }),

  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

export const activeSession = (state: State): Session | undefined =>
  state.sessions.find((s) => s.id === state.activeSessionId)
