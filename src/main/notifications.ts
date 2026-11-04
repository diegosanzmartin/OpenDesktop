import { BrowserWindow, Notification, app } from "electron";
import type { Session } from "@shared/types";
import {
  decideNotice,
  noticeContent,
  notificationSettings,
  type NoticeKind,
} from "@shared/notifications";
import { bus } from "./bus";
import { rawConfig } from "./config";
import { logLine } from "./log";
import { getSession, listMessages, listSessions, rootOf } from "./store";

/**
 * Telling somebody a turn ended, from the app itself.
 *
 * The alternative was a `turn` hook running `osascript`, and it was the wrong
 * shape twice over: a shell command that works on one platform, and a click
 * that goes nowhere because the operating system has no idea which
 * conversation it was about. A notification sent by this app knows its sender,
 * so a click brings back the window and the session it belongs to.
 *
 * Where the turn ends is not here. This listens to the store's own
 * `session.updated` events and reads the change off them: a turn has finished
 * when a session that was running is not running any more, which is true
 * however it ended — answered, failed, or stopped by a person.
 */

/** Sessions seen running, so an ending is a transition rather than a state. */
const working = new Set<string>();
/** Sessions already told about an approval prompt, so it is said once. */
const asked = new Set<string>();
/**
 * Every notification on screen. Electron drops a collected one from the
 * Notification Center and loses its click, so each is held until it is done.
 */
const onScreen = new Set<Notification>();

let started = false;
let pendingFocus: string | null = null;

/** The conversation a notification asked for before there was a window to show it in. */
export function takePendingFocus(): string | null {
  const sessionId = pendingFocus;
  pendingFocus = null;
  return sessionId;
}

export function startNotifications(): void {
  if (started) return;
  started = true;

  // Windows groups notifications by this id; without it they are anonymous and
  // an installed build's toasts may not appear at all. Harmless elsewhere.
  if (process.platform === "win32")
    app.setAppUserModelId("com.opendesktop.app");

  // A turn that was already running when the app started — a queued board task
  // picked up on launch — has to be in here, or its end looks like the first
  // status it ever had and nothing is said.
  for (const session of listSessions()) {
    if (
      session.status === "running" ||
      session.status === "awaiting-approval"
    ) {
      working.add(session.id);
    }
  }

  bus.subscribe((event) => {
    if (event.type === "session.updated") onSession(event.session);
    else if (event.type === "session.deleted") {
      working.delete(event.sessionId);
      asked.delete(event.sessionId);
    }
  });
}

function onSession(session: Session): void {
  const status = session.status;

  if (status === "running") {
    working.add(session.id);
    // Whatever it was waiting on was answered; another request later is still
    // worth saying, so the "already said" flag goes when the work carries on.
    asked.delete(session.id);
    return;
  }

  if (status === "awaiting-approval" || status === "blocked") {
    working.add(session.id);
    if (asked.has(session.id)) return;
    asked.add(session.id);
    show(session, "approval");
    return;
  }

  if (status === "idle" || status === "error" || status === "done") {
    if (!working.has(session.id)) return;
    working.delete(session.id);
    asked.delete(session.id);
    show(session, status === "error" ? "error" : "done");
    return;
  }

  // Queued: it has not started, so it has neither ended nor needs anybody.
  if (status === "queued") working.delete(session.id);
}

/** Whether any window of this app is the one in front. */
function windowFocused(): boolean {
  return BrowserWindow.getAllWindows().some(
    (win) => !win.isDestroyed() && win.isFocused(),
  );
}

/**
 * What the agent said last, for the body of the notification.
 *
 * The last assistant message rather than the last block: a turn usually ends
 * with prose, and a tool's output is not an answer to anything.
 */
function lastSaid(sessionId: string): string | undefined {
  const messages = listMessages(sessionId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n\n");
    if (text.trim()) return text;
  }
  return undefined;
}

/** Why the last turn failed: the error the runner wrote into its last answer. */
function lastFailure(sessionId: string): string | undefined {
  const messages = listMessages(sessionId);
  const last = messages.filter((message) => message.role === "assistant").at(-1);
  return last?.parts.filter((part) => part.type === "error").at(-1)?.text;
}

function show(session: Session, kind: NoticeKind): void {
  const settings = notificationSettings(rawConfig().notifications);
  const root = rootOf(session);
  const decision = decideNotice({
    kind,
    settings,
    session: root.notify,
    windowFocused: windowFocused(),
    subagent: root.id !== session.id,
  });

  if (!decision.show) {
    // Worth a line only to somebody asking why the app was silent.
    if (process.env.OPENDESKTOP_DEBUG) {
      logLine(
        "info",
        `notification ${session.id} not shown: ${decision.reason}`,
      );
    }
    return;
  }

  const sent = send(
    noticeContent({
      kind,
      title: root.taskLabel ?? root.title,
      said: kind === "done" ? lastSaid(session.id) : undefined,
      failure: kind === "error" ? lastFailure(session.id) : undefined,
      waiting: session.status === "blocked" ? session.blockedReason : undefined,
    }),
    settings.sound,
    root.id,
  );
  if (sent) logLine("info", `notified ${session.id} (${kind})`);
}

function send(
  content: { title: string; body: string },
  sound: boolean,
  sessionId?: string,
): Notification | null {
  if (!Notification.isSupported()) {
    logLine("warn", "notifications are not supported on this system");
    return null;
  }

  const notification = new Notification({
    title: content.title,
    body: content.body,
    silent: !sound,
  });
  onScreen.add(notification);
  const release = (): void => {
    onScreen.delete(notification);
  };
  notification.on("close", release);
  // macOS refuses silently otherwise: an unsigned build, or permission denied.
  notification.on("failed", (_event, error) => {
    release();
    logLine("warn", `notification failed: ${String(error)}`);
  });

  notification.on("click", () => {
    release();
    // Both halves matter: the window that is nowhere, and the conversation in
    // it. Selecting the session is the renderer's job — it is the only side
    // that knows what the panes are showing — so it is asked for as an event.
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) {
      // Every window closed (macOS keeps the app running): open one the way the Dock would,
      // and leave the conversation for its renderer to ask for once it has loaded.
      pendingFocus = sessionId ?? null;
      app.emit("activate");
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    if (sessionId) bus.emit({ type: "session.focus", sessionId });
  });

  notification.show();
  return notification;
}

/**
 * One notification, right now, whatever the settings say.
 *
 * Because the point of it is to answer "does this work on this machine?" — a
 * button that honoured the switch beside it could only ever answer "yes, and
 * also, it is off". So it waits for the system's answer instead of assuming it.
 */
export function testNotification(): Promise<boolean> {
  const notification = send(
    {
      title: "OpenDesktop",
      body: "Notifications from this app look like this.",
    },
    true,
  );
  if (!notification) return Promise.resolve(false);
  return new Promise((resolve) => {
    // ponytail: no "show" within 3 s counts as shown; macOS may drop it without saying.
    const timer = setTimeout(() => resolve(true), 3000);
    notification.once("show", () => {
      clearTimeout(timer);
      resolve(true);
    });
    notification.once("failed", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/** What the settings page needs to know before offering to turn it on. */
export function notificationsSupported(): boolean {
  return Notification.isSupported();
}
