import { decode, encode } from "@shared/wire";

/**
 * Electron, as far as the preload needs it, for a browser tab.
 *
 * The web build compiles the desktop preload unchanged with `electron` aliased
 * to this file, so `window.opendesktop` is the same object with the same 124
 * methods. Here `invoke` is a call over the server's socket and `on` listens
 * to what the server broadcasts.
 */

type Listener = (event: unknown, payload: unknown) => void;

const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
const listeners = new Map<string, Set<Listener>>();
const queued: string[] = [];
let socket: WebSocket | null = null;
let next = 1;
let retry = 500;

function url(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${location.pathname.replace(/[^/]*$/, "")}ws`;
}

function connect(): void {
  const ws = new WebSocket(url());
  ws.onopen = () => {
    socket = ws;
    retry = 500;
    while (queued.length > 0) ws.send(queued.shift()!);
  };
  ws.onmessage = (message) => {
    const data = decode<{ id?: number; result?: unknown; error?: string; event?: string; payload?: unknown }>(String(message.data));
    if (data.event) {
      for (const listener of listeners.get(data.event) ?? []) listener(null, data.payload);
      return;
    }
    const call = data.id === undefined ? undefined : pending.get(data.id);
    if (!call) return;
    pending.delete(data.id!);
    if (data.error !== undefined) call.reject(new Error(data.error));
    else call.resolve(data.result);
  };
  ws.onclose = () => {
    socket = null;
    // What was in flight will never be answered by that server; the caller hears so instead of waiting forever.
    for (const [id, call] of pending) {
      call.reject(new Error("the connection to OpenDesktop was lost"));
      pending.delete(id);
    }
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10_000);
  };
}

connect();

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const id = next++;
    const message = encode({ id, channel, args });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (socket) socket.send(message);
      else queued.push(message);
    });
  },
  on(channel: string, listener: Listener): void {
    const set = listeners.get(channel) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(channel, set);
  },
  off(channel: string, listener: Listener): void {
    listeners.get(channel)?.delete(listener);
  },
};

export const contextBridge = {
  exposeInMainWorld(name: string, api: unknown): void {
    (window as unknown as Record<string, unknown>)[name] = api;
  },
};

// A file dropped into a browser has no path on the workstation; the composer sends its bytes instead.
export const webUtils = {
  getPathForFile: (): string => "",
};
