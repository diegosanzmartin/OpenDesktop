import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Electron, as far as the main process needs it, for a plain Node server.
 *
 * The web build bundles the same main-process code as the desktop app with
 * `electron` aliased to this file. Everything the code calls is here and does
 * the server's version of it: handlers go into a table the WebSocket dispatches
 * from, a "window" is the set of connected browsers, and what only makes sense
 * on a desktop (dialogs, Finder, the Dock) answers that it did nothing.
 */

type Handler = (event: unknown, ...args: unknown[]) => unknown;

export const handlers = new Map<string, Handler>();

export const ipcMain = {
  handle(channel: string, handler: Handler): void {
    handlers.set(channel, handler);
  },
  removeHandler(channel: string): void {
    handlers.delete(channel);
  },
};

/** The connected browsers; the server adds and removes them as sockets come and go. */
export const clients = new Set<(channel: string, payload: unknown) => void>();

const browserWindow = {
  isDestroyed: (): boolean => false,
  isFocused: (): boolean => clients.size > 0,
  webContents: {
    send(channel: string, payload: unknown): void {
      for (const send of clients) send(channel, payload);
    },
  },
};

export const BrowserWindow = {
  // The browsers are one window: what the app says, every tab hears.
  getAllWindows: () => (clients.size > 0 ? [browserWindow] : []),
  getFocusedWindow: () => (clients.size > 0 ? browserWindow : null),
};

const emitter = new EventEmitter();
let name = "opendesktop";

export const app = Object.assign(emitter, {
  // Laid out like a checkout, not an app bundle: resources sit under getAppPath(), and there is no resourcesPath.
  isPackaged: false,
  getName: (): string => name,
  setName: (next: string): void => {
    name = next;
  },
  getVersion: (): string => process.env.npm_package_version ?? "0.0.0",
  // The pentest sandbox context and other bundled resources sit beside the server bundle.
  getAppPath: (): string => process.env.OPENDESKTOP_APP_PATH ?? resolve(__dirname, "../.."),
  getPath: (which: string): string => (which === "home" ? homedir() : join(homedir(), ".opendesktop")),
  whenReady: (): Promise<void> => Promise.resolve(),
  setAppUserModelId: (): void => undefined,
  setAboutPanelOptions: (): void => undefined,
  quit: (): void => {
    emitter.emit("before-quit");
    process.exit(0);
  },
  exit: (code = 0): void => process.exit(code),
});

/*
 * Secrets at rest. On a Mac the key is in the Keychain; a workstation has no
 * keychain, so the key is a file only this user can read, on the same
 * persistent disk as the secrets. It keeps API keys out of config.json and out
 * of anything that copies it; it does not stand up to someone who already has
 * this user's home directory. Secret Manager replaces it on GKE.
 */
const KEY_PATH = join(process.env.OPENDESKTOP_HOME ?? join(homedir(), ".opendesktop"), "secret.key");

function key(): Buffer {
  if (!existsSync(KEY_PATH)) {
    mkdirSync(dirname(KEY_PATH), { recursive: true });
    writeFileSync(KEY_PATH, randomBytes(32), { mode: 0o600, flag: "wx" });
  }
  return readFileSync(KEY_PATH);
}

export const safeStorage = {
  isEncryptionAvailable: (): boolean => {
    try {
      return key().length === 32;
    } catch {
      return false;
    }
  },
  encryptString(text: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  decryptString(data: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
  },
};

// No desktop: the browser opens links itself, and there is no Finder to reveal in.
export const shell = {
  openExternal: async (): Promise<void> => undefined,
  openPath: async (): Promise<string> => "there is no desktop to open it on",
  showItemInFolder: (): void => undefined,
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined as string | undefined }),
};

export const Notification = { isSupported: (): boolean => false };

export const powerSaveBlocker = { start: (): number => 0, stop: (): void => undefined };

export default { app, BrowserWindow, dialog, ipcMain, Notification, powerSaveBlocker, safeStorage, shell };
