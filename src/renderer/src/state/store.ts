import { create } from "zustand";
import { previewTarget } from "../lib/preview";
import type {
  ActivityQuery,
  AppConfig,
  Attachment,
  AppEvent,
  ApprovalRequest,
  BackgroundTask,
  Block,
  Board,
  GitSummary,
  Message,
  RepoChanges,
  Session,
  SessionQuery,
  Skill,
} from "@shared/types";
import { MANAGER_AGENT } from "@shared/types";
import { forgetFolder, rememberFolder } from "@shared/recent";
import {
  DEFAULT_LAYOUT,
  clampPanelHeight,
  closePane,
  normalizeLayout,
  openPane,
  paneFor,
  placePane,
  togglePanel,
  type PaneLayout,
  type PaneId,
  type WorkbenchLayout,
} from "@shared/layout";

/**
 * The layout with a pane in the side column.
 *
 * The column and the dock are one thing, so every path that puts a pane on the
 * right goes through here rather than repeating the placement rule.
 */
function withSidePane(layout: WorkbenchLayout, pane: PaneId): WorkbenchLayout {
  return { ...layout, panes: placePane(layout.panes, pane, "right") };
}

/**
 * A pane of the workbench. The centre column is always the chat.
 *
 * `files` and `editor` are one pane now — a file tree with nothing open is a
 * directory listing, and the editor is what the tree is for — so a caller
 * asking for either gets the pair.
 */
export type DockTab =
  | "changes"
  | "terminal"
  | "browser"
  | "editor"
  | "files"
  | "files-editor"
  | "activity"
  | "background"
  | "tasks";


/** The two ways of working: one conversation at a time, or the whole board. */
export type AppView = "chat" | "board";

/**
 * The three halves of choosing a folder.
 *
 * Browse is the tree, search is the whole tree filtered, recent is the short
 * list of folders this conversation has already been in.
 */
export type FolderPickerMode = "browse" | "search" | "recent";

// Declared in @shared/types, beside ActivityQuery, so the headless tests can
// reach the list logic without pulling the renderer's DOM types in.
export type {
  GitSummary,
  SessionGroupBy,
  SessionQuery,
  SessionSortBy,
  SessionStatusFilter,
} from "@shared/types";

interface Toast {
  id: number;
  level: "info" | "warn" | "error";
  message: string;
}

interface State {
  ready: boolean;
  config: AppConfig | null;
  models: { ref: string; label: string; provider: string }[];
  skills: Skill[];
  keyStatus: Record<string, { resolved: boolean; source: string }>;
  secrets: {
    available: boolean;
    path: string;
    failed: string[];
    hints: Record<string, string | null>;
  };

  sessions: Session[];
  activeSessionId: string | null;
  messages: Record<string, Message[]>;
  blocks: Record<string, Block>;
  activity: Block[];
  approvals: ApprovalRequest[];
  backgroundTasks: BackgroundTask[];
  envStatus: Record<string, { connected: boolean; message?: string }>;
  toasts: Toast[];

  dock: { open: boolean; tab: DockTab; width: number };
  /** The workbench's panes: what is docked where, and the bottom panel. */
  layout: WorkbenchLayout;
  sidebarCollapsed: boolean;
  settingsOpen: boolean;
  /**
   * The folder picker, when it is open, and which of its two halves to open
   * in. Held here rather than in the composer so that ⌘R can open it from
   * anywhere in the chat.
   */
  folderPicker: { sessionId: string; mode: FolderPickerMode } | null;
  /**
   * Text and attachments waiting to be put back into a composer, from a
   * rewind. Held here because the composer owns what is typed in it and there
   * is no other way to hand it something from outside.
   */
  draft: { sessionId: string; text: string; attachments: Attachment[] } | null;
  /**
   * What is typed into each composer and not sent, by session.
   *
   * Held here rather than in the composer's own state because the composer is
   * unmounted the moment the board opens, and switching chat changes its
   * `session` prop without remounting it — two ways for one component's state
   * to be the wrong text for the conversation on screen. The session carries
   * the same string once the typing pauses, so a restart keeps it too.
   */
  composerText: Record<string, string>;
  changes: RepoChanges | null;
  changesLoading: boolean;
  /** Keyed by `environmentId:cwd`, so sessions sharing a folder share a lookup. */
  gitSummaries: Record<string, GitSummary>;
  sessionQuery: SessionQuery;
  activityQuery: ActivityQuery;
  /** Where conversations' own folders live, read once at startup. */
  workspacesRoot: string;
  /** The file the editor pane has open, if any. */
  editorFile: {
    environmentId: string;
    path: string;
    sessionId?: string;
  } | null;
  browserUrl: string;
  /**
   * Whether the browser pane shows its address bar. Null is "decide from what
   * is loaded": a file does not need one, a website does.
   */
  browserChrome: boolean | null;
  view: AppView;
  boards: Board[];
  /** The card open as a chat beside the board. */
  boardTaskId: string | null;
  /** The row whose title is being edited in place, from the session menu. */
  renamingSessionId: string | null;
  /** The session filter box, toggled from the window bar it does not live in. */
  searchOpen: boolean;
  /**
   * Text handed to the terminal pane from somewhere else — a code block's run
   * button. The counter is what makes sending the same command twice register
   * as two events rather than as no change at all.
   */
  terminalInject: { text: string; run: boolean; nonce: number } | null;
  /** Null means the overview: every card from every board. */
  activeBoardId: string | null;
  /** Block ids expanded in the transcript. */
  expanded: Record<string, boolean>;
  activityCollapsed: boolean;

  bootstrap: () => Promise<void>;
  applyEvent: (event: AppEvent) => void;
  selectSession: (id: string) => Promise<void>;
  newSession: (input?: {
    cwd?: string;
    environmentId?: string;
    agentId?: string;
    model?: string;
  }) => Promise<void>;
  send: (text: string, attachments?: Attachment[]) => Promise<void>;
  stop: () => Promise<void>;
  openDock: (tab: DockTab) => void;
  toggleDock: (tab: DockTab) => void;
  closeDock: () => void;
  setDockWidth: (width: number) => void;
  togglePanel: () => void;
  openPaneInWorkbench: (pane: PaneId) => void;
  closePaneInWorkbench: (pane: PaneId) => void;
  setPanelActive: (pane: PaneId) => void;
  setPanelHeight: (height: number) => void;
  setFilesSide: (side: "left" | "right") => void;
  /** Replaces the pane arrangement, leaving the panel's own state alone. */
  applyLayout: (panes: PaneLayout) => void;
  /** Saves the window's arrangement as the one this install opens with. */
  persistLayout: () => Promise<void>;
  toggleSidebar: () => void;
  setSettingsOpen: (open: boolean) => void;
  openFolderPicker: (sessionId: string, mode?: FolderPickerMode) => void;
  /**
   * Puts a folder in the recent list, or takes it out.
   *
   * Written straight through to the config rather than kept in this store:
   * the list is what the picker offers on the next launch, so it has to
   * survive the window, and it is small enough that a write per click is
   * cheaper than a merge policy.
   */
  rememberFolder: (environmentId: string, path: string) => Promise<void>;
  forgetFolder: (environmentId: string, path: string) => Promise<void>;
  closeFolderPicker: () => void;
  setDraft: (
    draft: {
      sessionId: string;
      text: string;
      attachments: Attachment[];
    } | null,
  ) => void;
  /**
   * What is typed in a conversation, kept as it is typed.
   *
   * Synchronous in this window, because it has to be: the point is that the
   * text is still there when the composer is remounted. The write to the
   * session itself follows a pause, since a keystroke is not a reason to touch
   * a file on disk — and the session is where it lives between runs.
   */
  setComposerText: (sessionId: string, text: string) => void;
  rewindTo: (sessionId: string, messageId: string) => Promise<void>;
  forkFrom: (sessionId: string, messageId: string) => Promise<void>;
  refreshChanges: () => Promise<void>;
  setSessionQuery: (patch: Partial<SessionQuery>) => void;
  setView: (view: AppView) => void;
  selectBoard: (id: string | null) => void;
  closeTask: () => void;
  startRename: (id: string | null) => void;
  toggleSearch: () => void;
  sendToTerminal: (text: string, run: boolean) => void;
  consumeTerminalInject: () => void;
  refreshBoards: () => Promise<void>;
  openTask: (sessionId: string) => Promise<void>;
  setActivityQuery: (patch: Partial<ActivityQuery>) => void;
  setBrowserUrl: (url: string) => void;
  setBrowserChrome: (show: boolean | null) => void;
  openInEditor: (
    file: { environmentId: string; path: string; sessionId?: string } | null,
  ) => void;
  toggleBlock: (id: string) => void;
  setExpanded: (id: string, value: boolean) => void;
  toggleActivity: () => void;
  refreshActivity: () => Promise<void>;
  refreshConfig: () => Promise<void>;
  refreshSecrets: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  refreshBackgroundTasks: () => Promise<void>;
  refreshGitSummaries: () => Promise<void>;
  pushToast: (level: Toast["level"], message: string) => void;
  dismissToast: (id: number) => void;
}

const api = (): Window["opendesktop"] => window.opendesktop;

let toastSeq = 0;

/** How long a note stays up; a warning or an error stays until it is dismissed. */
export const TOAST_MS = 4000;

/**
 * Where the pending write of each conversation's unsent text lives.
 *
 * One per session, so a burst of typing in one chat cannot cancel the write for
 * another — and module-level rather than in the store because a timer is not
 * state anything renders from.
 */
const draftWrites = new Map<string, ReturnType<typeof setTimeout>>();

export const useStore = create<State>((set, get) => ({
  ready: false,
  config: null,
  models: [],
  skills: [],
  keyStatus: {},
  secrets: { available: false, path: "", failed: [], hints: {} },

  sessions: [],
  activeSessionId: null,
  messages: {},
  blocks: {},
  activity: [],
  approvals: [],
  backgroundTasks: [],
  envStatus: {},
  toasts: [],

  dock: { open: false, tab: "changes", width: 460 },
  // Open from the start, showing the terminal. DEFAULT_LAYOUT keeps its own
  // default of closed, because that object is also what `normalizeLayout`
  // falls back to for a window with no panes at all.
  layout: { ...DEFAULT_LAYOUT, panelOpen: true },
  sidebarCollapsed: false,
  settingsOpen: false,
  folderPicker: null,
  draft: null,
  composerText: {},
  changes: null,
  changesLoading: false,
  gitSummaries: {},
  sessionQuery: {
    status: "active",
    environment: "all",
    groupBy: "date",
    sortBy: "recent",
    search: "",
    showGitStatus: true,
  },
  activityQuery: {
    groupBy: "none",
    sortBy: "recent",
    search: "",
    statuses: [],
    environments: [],
    agents: [],
    tools: [],
    sessionId: null,
    since: null,
  },
  workspacesRoot: "",
  editorFile: null,
  browserUrl: "",
  browserChrome: null,
  expanded: {},
  activityCollapsed: false,
  view: "chat",
  boards: [],
  boardTaskId: null,
  renamingSessionId: null,
  searchOpen: false,
  terminalInject: null,
  activeBoardId: null,

  async bootstrap() {
    const [
      config,
      models,
      sessions,
      approvals,
      activity,
      keyStatus,
      secrets,
      skills,
      backgroundTasks,
      boards,
      workspacesRoot,
    ] = await Promise.all([
      api().config.get(),
      api().models.list(),
      api().sessions.list(),
      api().approvals.list(),
      api().activity.all(),
      api().config.keyStatus(),
      api().secrets.status(),
      api().skills.list(),
      api().background.list(),
      api().boards.list(),
      api().files.workspacesRoot(),
    ]);
    const blocks: Record<string, Block> = {};
    for (const block of activity) blocks[block.id] = block;

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
      backgroundTasks,
      boards,
      workspacesRoot,
      /*
       * The window somebody arranged, rather than the one this file starts
       * with. `normalizeLayout` is what the main process used to read it, so a
       * layout that reached this far is already a drawable one — and a fresh
       * install has no key here at all, which is what the defaults are for.
       */
      layout: normalizeLayout(config.layout),
      ready: true,
    });

    // A window opened by clicking a notification shows the conversation it was about.
    const asked = await api().host.pendingFocus();
    const opening = sessions.find((s) => s.id === asked) ?? sessions[0];
    if (opening) await get().selectSession(opening.id);
    else await get().newSession();
  },

  applyEvent(event) {
    const state = get();
    switch (event.type) {
      case "config.updated":
        set({ config: event.config });
        void api()
          .models.list()
          .then((models) => set({ models }));
        break;

      case "board.updated":
        set({
          boards: [
            ...state.boards.filter((b) => b.id !== event.board.id),
            event.board,
          ].sort((a, b) => a.name.localeCompare(b.name)),
        });
        break;

      case "board.deleted":
        set({
          boards: state.boards.filter((b) => b.id !== event.boardId),
          activeBoardId:
            state.activeBoardId === event.boardId ? null : state.activeBoardId,
        });
        break;

      case "session.created":
        set({
          sessions: [
            event.session,
            ...state.sessions.filter((s) => s.id !== event.session.id),
          ],
          // A subagent's transcript is rendered inline in its parent, so start
          // collecting its messages as they stream rather than fetching later.
          messages: event.session.parentSessionId
            ? { ...state.messages, [event.session.id]: [] }
            : state.messages,
        });
        break;

      case "session.updated":
        set({
          sessions: state.sessions
            .map((s) => (s.id === event.session.id ? event.session : s))
            .sort((a, b) => b.updatedAt - a.updatedAt),
        });
        break;

      case "session.rewound": {
        // Messages and blocks were removed, which no incremental event can
        // express: reload what this session now is.
        if (get().activeSessionId === event.sessionId)
          void get().selectSession(event.sessionId);
        else {
          const next = { ...get().messages };
          delete next[event.sessionId];
          set({ messages: next });
        }
        break;
      }
      case "session.deleted": {
        const sessions = state.sessions.filter((s) => s.id !== event.sessionId);
        // The conversation is gone, so its unsent text is too: a pending write
        // would otherwise try to save a draft onto a session nobody has.
        const pending = draftWrites.get(event.sessionId);
        if (pending) {
          clearTimeout(pending);
          draftWrites.delete(event.sessionId);
        }
        const composerText = { ...state.composerText };
        delete composerText[event.sessionId];
        set({ sessions, composerText });
        // Otherwise the board's panel keeps showing a card that is gone.
        if (state.boardTaskId === event.sessionId) set({ boardTaskId: null });
        if (state.activeSessionId === event.sessionId && sessions.length > 0) {
          void get().selectSession(sessions[0].id);
        }
        break;
      }

      /*
       * A notification was clicked. The main process has already brought the
       * window forward; choosing the conversation is the part only this side
       * can do, because it is what the panes are showing.
       */
      case "session.focus": {
        if (state.sessions.some((s) => s.id === event.sessionId)) {
          void get().selectSession(event.sessionId);
        }
        break;
      }

      case "message.created":
        set({
          messages: {
            ...state.messages,
            [event.message.sessionId]: [
              ...(state.messages[event.message.sessionId] ?? []).filter(
                (m) => m.id !== event.message.id,
              ),
              event.message,
            ],
          },
        });
        break;

      case "message.updated":
        set({
          messages: {
            ...state.messages,
            [event.message.sessionId]: (
              state.messages[event.message.sessionId] ?? []
            ).map((m) => (m.id === event.message.id ? event.message : m)),
          },
        });
        break;

      case "message.part.delta": {
        const list = state.messages[event.sessionId] ?? [];
        set({
          messages: {
            ...state.messages,
            [event.sessionId]: list.map((m) => {
              if (m.id !== event.messageId) return m;
              const parts = m.parts.slice();
              const part = parts[event.partIndex];
              if (part)
                parts[event.partIndex] = {
                  ...part,
                  text: (part.text ?? "") + event.text,
                };
              return { ...m, parts };
            }),
          },
        });
        break;
      }

      case "block.created":
        set({
          blocks: { ...state.blocks, [event.block.id]: event.block },
          activity: [event.block, ...state.activity].slice(0, 800),
        });
        break;

      case "block.updated":
        set({
          blocks: { ...state.blocks, [event.block.id]: event.block },
          activity: state.activity.map((b) =>
            b.id === event.block.id ? event.block : b,
          ),
        });
        break;

      case "block.output": {
        const existing = state.blocks[event.blockId];
        if (!existing) break;
        const next = { ...existing, output: existing.output + event.chunk };
        set({
          blocks: { ...state.blocks, [event.blockId]: next },
          activity: state.activity.map((b) =>
            b.id === event.blockId ? next : b,
          ),
        });
        break;
      }

      case "approval.requested":
        set({ approvals: [...state.approvals, event.request] });
        break;

      case "approval.resolved":
        set({
          approvals: state.approvals.filter((a) => a.id !== event.approvalId),
        });
        break;

      case "environment.status":
        set({
          envStatus: {
            ...state.envStatus,
            [event.environmentId]: {
              connected: event.connected,
              message: event.message,
            },
          },
        });
        break;

      case "background.updated": {
        const others = state.backgroundTasks.filter(
          (task) => task.id !== event.task.id,
        );
        // Output arrives on its own event, so keep what has accumulated.
        const previous = state.backgroundTasks.find(
          (task) => task.id === event.task.id,
        );
        const merged = previous
          ? { ...event.task, output: previous.output }
          : event.task;
        set({
          backgroundTasks: [merged, ...others].sort(
            (a, b) => b.startedAt - a.startedAt,
          ),
        });
        break;
      }

      case "background.output":
        set({
          backgroundTasks: state.backgroundTasks.map((task) =>
            task.id === event.taskId
              ? { ...task, output: task.output + event.chunk }
              : task,
          ),
        });
        break;

      case "background.cleared":
        void get().refreshBackgroundTasks();
        break;

      case "toast":
        get().pushToast(event.level, event.message);
        break;
    }
  },

  async selectSession(id) {
    set({ activeSessionId: id, changes: null });
    const [messages, blocks] = await Promise.all([
      api().sessions.messages(id),
      api().sessions.blocks(id),
    ]);
    const map = { ...get().blocks };
    for (const block of blocks) map[block.id] = block;
    set({ messages: { ...get().messages, [id]: messages }, blocks: map });
  },

  async newSession(input) {
    const config = get().config;
    const session = await api().sessions.create({
      environmentId: input?.environmentId ?? "local",
      cwd: input?.cwd,
      // No agent pinned by default: the orchestrator decides per request.
      agentId: input?.agentId ?? MANAGER_AGENT,
      model: input?.model ?? config?.model,
    });
    await get().selectSession(session.id);
  },

  async send(text, attachments) {
    const id = get().activeSessionId;
    if (!id || (!text.trim() && !attachments?.length)) return;
    await api().turn.send(id, text, attachments);
  },

  async stop() {
    const id = get().activeSessionId;
    if (id) await api().turn.stop(id);
  },

  /*
   * The side dock and the workbench's right column are the same thing seen
   * from two places: the window bar names a tab, the arrange menu names a
   * column. Both go through here, so a pane moved to the right shows up as a
   * dock tab and a dock tab closed from the bar leaves the column.
   */
  openDock: (tab) => {
    const pane = paneFor(tab);
    set({
      dock: { ...get().dock, open: true, tab },
      layout: withSidePane(get().layout, pane),
    });
  },
  toggleDock: (tab) => {
    const dock = get().dock;
    const pane = paneFor(tab);
    const closing = dock.open && dock.tab === tab;
    set({
      dock: { ...dock, open: !closing, tab },
      layout: closing
        ? closePane(get().layout, pane)
        : withSidePane(get().layout, pane),
    });
    if (tab === "changes") void get().refreshChanges();
  },
  closeDock: () => {
    const tab = get().dock.tab;
    set({
      dock: { ...get().dock, open: false },
      layout: closePane(get().layout, paneFor(tab)),
    });
  },
  setDockWidth: (width) =>
    set({
      dock: { ...get().dock, width: Math.min(900, Math.max(320, width)) },
    }),

  /*
   * The workbench beside the dock, and deliberately a different thing: the
   * dock is one pane on the right, while these panes can live in any column
   * and the panel across the bottom. Every action here is a call into
   * @shared/layout and none of the rules are repeated in this file, so the
   * window the main process reads and the window this draws cannot disagree.
   */
  togglePanel: () => set({ layout: togglePanel(get().layout) }),
  /*
   * Opening a pane from the arrange menu has to bring the thing that draws it
   * with it: a pane moved to the side column is drawn by the dock, and a dock
   * left closed would be a move nobody could see.
   */
  openPaneInWorkbench: (pane) => {
    const layout = openPane(get().layout, pane);
    const side = layout.panes.right.includes(pane);
    set({
      layout,
      ...(side ? { dock: { ...get().dock, open: true, tab: pane } } : {}),
    });
  },
  closePaneInWorkbench: (pane) => {
    const wasDock = get().dock.tab === pane && get().dock.open;
    set({
      layout: closePane(get().layout, pane),
      ...(wasDock ? { dock: { ...get().dock, open: false } } : {}),
    });
  },
  setPanelActive: (pane) =>
    set({ layout: { ...get().layout, panelActive: pane } }),
  setPanelHeight: (height) =>
    set({
      layout: { ...get().layout, panelHeight: clampPanelHeight(height) },
    }),
  setFilesSide: (filesSide) => set({ layout: { ...get().layout, filesSide } }),

  /*
   * Moving a pane can leave the panel pointing at a tab that is no longer in
   * it, or holding panes with nothing open. Both are settled here rather than
   * in the component: the layout is the thing that has to stay coherent, and
   * `normalizeLayout` is already the one place that knows what coherent means.
   */
  applyLayout: (panes) => {
    /*
     * Whatever ended up in the side column becomes the dock's tab, and an
     * emptied column closes it. Without this the arrange menu would reorder a
     * column the dock is not drawing.
     */
    const current = get().layout.panes.right;
    const arriving = panes.right.find((pane) => !current.includes(pane));
    const removed = current.find((pane) => !panes.right.includes(pane));
    set({
      layout: normalizeLayout({
        ...get().layout,
        panes,
        panelActive: panes.bottom.includes(
          get().layout.panelActive ?? panes.bottom[0],
        )
          ? get().layout.panelActive
          : (panes.bottom[0] ?? null),
      }),
      ...(arriving
        ? { dock: { ...get().dock, open: true, tab: arriving } }
        : removed && get().dock.tab === removed
          ? { dock: { ...get().dock, open: false } }
          : {}),
    })
  },

  /**
   * The arrangement, written back to the config file.
   *
   * Only the layout key is changed: saving the whole document from here would
   * fight the settings pages, which hold a draft of their own and write it on
   * a timer.
   */
  async persistLayout() {
    const config = get().config;
    if (!config) return;
    try {
      const next = await api().config.save({ ...config, layout: get().layout });
      if (next) set({ config: next });
    } catch (error) {
      get().pushToast(
        "warn",
        `Could not save the window: ${(error as Error).message}`,
      );
    }
  },

  toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  openFolderPicker: (sessionId, mode = "browse") =>
    set({ folderPicker: { sessionId, mode } }),
  closeFolderPicker: () => set({ folderPicker: null }),

  async rememberFolder(environmentId, path) {
    const config = get().config;
    if (!config) return;
    const recentFolders = rememberFolder(
      config.recentFolders,
      environmentId,
      path,
    );
    // Applied here first: the list is on screen and should change under the
    // click, not a round trip later.
    set({ config: { ...config, recentFolders } });
    try {
      const next = await api().config.save({ ...config, recentFolders });
      if (next) set({ config: next });
    } catch (error) {
      // A folder now missing from a convenience list is not worth a dialog,
      // but it is worth not losing the click that was meant to happen.
      get().pushToast(
        "warn",
        `Could not remember that folder: ${(error as Error).message}`,
      );
    }
  },

  async forgetFolder(environmentId, path) {
    const config = get().config;
    if (!config) return;
    const recentFolders = forgetFolder(
      config.recentFolders,
      environmentId,
      path,
    );
    set({ config: { ...config, recentFolders } });
    try {
      const next = await api().config.save({ ...config, recentFolders });
      if (next) set({ config: next });
    } catch (error) {
      get().pushToast(
        "warn",
        `Could not update the list: ${(error as Error).message}`,
      );
    }
  },

  setDraft: (draft) => set({ draft }),

  setComposerText: (sessionId, text) => {
    const current = get().composerText;
    // The same check the store makes, repeated here so a cursor move that fires
    // `onChange` with the same string does not cost a render.
    if (current[sessionId] === text) return;
    set({ composerText: { ...current, [sessionId]: text } });

    // One timer per conversation: typing in one chat and then in another must
    // not have the first one's last keystroke overwrite the second's file.
    const pending = draftWrites.get(sessionId);
    if (pending) clearTimeout(pending);
    draftWrites.set(
      sessionId,
      setTimeout(() => {
        draftWrites.delete(sessionId);
        void api()
          .sessions.setDraft(sessionId, text)
          .catch(() => undefined);
      }, 400),
    );
  },

  /**
   * Takes the conversation back to a message and puts what it said back in the
   * box. Everything after it goes — which is the point: the window should look
   * as though the turn never happened.
   */
  async rewindTo(sessionId, messageId) {
    const result = await api().sessions.rewind(sessionId, messageId);
    if (!result.ok) {
      get().pushToast("warn", result.reason);
      return;
    }
    await get().selectSession(sessionId);
    set({
      draft: { sessionId, text: result.text, attachments: result.attachments },
    });
  },

  async forkFrom(sessionId, messageId) {
    const result = await api().sessions.forkFrom(sessionId, messageId);
    if (!result.ok) {
      get().pushToast("warn", result.reason);
      return;
    }
    // The copy arrives as a session.created event; selecting it is all that is
    // left to do.
    await get().selectSession(result.sessionId);
  },

  async refreshChanges() {
    const session = get().sessions.find((s) => s.id === get().activeSessionId);
    if (!session) return set({ changes: null });
    set({ changesLoading: true });
    try {
      set({
        changes: await api().git.changes(session.environmentId, session.cwd),
      });
    } catch {
      set({ changes: null });
    } finally {
      set({ changesLoading: false });
    }
  },

  setSessionQuery: (patch) => {
    set({ sessionQuery: { ...get().sessionQuery, ...patch } });
    if (patch.showGitStatus) void get().refreshGitSummaries();
  },
  setView: (view) => set({ view }),
  selectBoard: (activeBoardId) => set({ activeBoardId }),

  async refreshBoards() {
    set({ boards: await api().boards.list() });
  },

  /**
   * Opening a card opens its chat, with everything that led to it — the point
   * of the board being made of real sessions rather than of task records that
   * merely reference them.
   *
   * It also becomes the active session, because the composer, the dock and the
   * changes pane all follow that. Beside the board rather than instead of it:
   * the board is the thing you came to look at.
   */
  async openTask(sessionId) {
    set({ boardTaskId: sessionId });
    await get().selectSession(sessionId);
  },

  closeTask: () => set({ boardTaskId: null }),
  startRename: (renamingSessionId) => set({ renamingSessionId }),

  toggleSearch: () => {
    const open = !get().searchOpen;
    // Closing it clears the filter: leaving a hidden filter applied is how a
    // session list ends up looking empty for no visible reason.
    set({
      searchOpen: open,
      sessionQuery: {
        ...get().sessionQuery,
        search: open ? get().sessionQuery.search : "",
      },
    });
  },

  sendToTerminal: (text, run) => {
    set({
      terminalInject: { text: text.trim(), run, nonce: Date.now() },
      dock: { ...get().dock, open: true, tab: "terminal" },
    });
  },

  // Cleared once the terminal has taken it. A command is an act, not state: if
  // it stayed here, remounting the pane — which happens the moment the dock
  // opens — would run it a second time.
  consumeTerminalInject: () => set({ terminalInject: null }),

  setActivityQuery: (patch) =>
    set({ activityQuery: { ...get().activityQuery, ...patch } }),
  setBrowserUrl: (browserUrl) => {
    /*
     * A choice about the address bar belongs to the kind of thing being
     * looked at, not to the pane for ever: going from a file to a website
     * brings the bar back, and going the other way takes it away again.
     * Within one kind, what was chosen by hand stands.
     */
    const kindChanged =
      Boolean(previewTarget(get().browserUrl)) !==
      Boolean(previewTarget(browserUrl));
    set({ browserUrl, ...(kindChanged ? { browserChrome: null } : {}) });
  },
  setBrowserChrome: (browserChrome) => set({ browserChrome }),
  /**
   * Opens a file in the editor, and the pane with it.
   *
   * One call rather than "set the file" and "open the pane" separately: every
   * caller wants both, and the one that forgets the second is a click that
   * does nothing visible.
   */
  openInEditor: (editorFile) => {
    set({ editorFile });
    if (editorFile) get().openDock("editor");
  },
  toggleBlock: (id) =>
    set({ expanded: { ...get().expanded, [id]: !get().expanded[id] } }),
  setExpanded: (id, value) =>
    set({ expanded: { ...get().expanded, [id]: value } }),
  toggleActivity: () => set({ activityCollapsed: !get().activityCollapsed }),

  async refreshActivity() {
    const activity = await api().activity.all();
    const blocks = { ...get().blocks };
    for (const block of activity) blocks[block.id] = block;
    set({ activity, blocks });
  },

  /**
   * One lookup per distinct folder, not per session: several chats usually sit
   * in the same repository, and this runs whenever the list is shown.
   */
  async refreshGitSummaries() {
    if (!get().sessionQuery.showGitStatus) return;
    const wanted = new Map<string, { environmentId: string; cwd: string }>();
    for (const session of get().sessions) {
      if (session.parentSessionId) continue;
      wanted.set(`${session.environmentId}:${session.cwd}`, {
        environmentId: session.environmentId,
        cwd: session.cwd,
      });
    }
    const entries = await Promise.all(
      [...wanted.entries()].map(async ([key, where]) => {
        try {
          return [
            key,
            await api().git.summary(where.environmentId, where.cwd),
          ] as const;
        } catch {
          return [key, { isRepo: false, branch: "", dirty: 0 }] as const;
        }
      }),
    );
    set({ gitSummaries: Object.fromEntries(entries) });
  },

  async refreshBackgroundTasks() {
    set({ backgroundTasks: await api().background.list() });
  },

  async refreshSkills() {
    set({ skills: await api().skills.list() });
  },

  async refreshSecrets() {
    const [secrets, keyStatus] = await Promise.all([
      api().secrets.status(),
      api().config.keyStatus(),
    ]);
    set({ secrets, keyStatus });
  },

  async refreshConfig() {
    const [config, models, keyStatus] = await Promise.all([
      api().config.get(),
      api().models.list(),
      api().config.keyStatus(),
    ]);
    set({ config, models, keyStatus });
  },

  pushToast: (level, message) => {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts, { id, level, message }].slice(-4) });
    if (level === "info") setTimeout(() => get().dismissToast(id), TOAST_MS);
  },

  dismissToast: (id) =>
    set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const activeSession = (state: State): Session | undefined =>
  state.sessions.find((s) => s.id === state.activeSessionId);
