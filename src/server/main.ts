import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { decode, encode } from "@shared/wire";
import { clients, handlers } from "./electron";
import { startCore, stopCore } from "../main/core";
import { logLine } from "../main/log";

/**
 * OpenDesktop served to a browser, for a machine without a screen: a Cloud
 * Workstation reached through its authenticated gateway.
 *
 * The main process is the desktop app's, unchanged; only how it is reached
 * differs. The renderer is the built one, and `/web.js` gives it the same
 * `window.opendesktop` the preload gives the desktop window, over one socket.
 */

const PORT = Number(process.env.OPENDESKTOP_PORT ?? 8080);
const HOST = process.env.OPENDESKTOP_LISTEN ?? "0.0.0.0";
const ROOT = resolve(__dirname, "..");
const RENDERER = join(ROOT, "renderer");
const WEB = join(ROOT, "web");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

// The renderer's page, with the bridge loaded before the app so `window.opendesktop` exists when it starts.
function page(): string {
  const html = readFileSync(join(RENDERER, "index.html"), "utf8");
  return html.replace("<head>", '<head>\n    <script src="./web.js"></script>');
}

function fileFor(url: string): string | null {
  const path = decodeURIComponent(new URL(url, "http://x").pathname);
  if (path === "/web.js") return join(WEB, "web.js");
  const target = normalize(join(RENDERER, path));
  // Nothing outside the built renderer is served, whatever the path says.
  if (!target.startsWith(RENDERER + "/")) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

/*
 * The host the browser sees. Behind the Cloud Workstations gateway that is not
 * the Host header that reaches this process — the gateway rewrites it — but
 * `<port>-$WEB_HOST`, which Workstations publishes to the container.
 */
const PUBLIC_HOSTS = process.env.WEB_HOST
  ? [`${PORT}-${process.env.WEB_HOST}`, ...(PORT === 80 ? [process.env.WEB_HOST] : [])]
  : [];

/*
 * A WebSocket handshake carries the gateway's cookies and is not subject to
 * CORS, so any page open in the same browser could otherwise connect and drive
 * the agent. Only the page this server served may: same host, or this server's
 * own address on the gateway.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    return host === req.headers.host || PUBLIC_HOSTS.includes(host);
  } catch {
    return false;
  }
}

interface Call {
  id: number;
  channel: string;
  args: unknown[];
}

function serve(socket: WebSocket): void {
  const send = (channel: string, payload: unknown): void => {
    if (socket.readyState === socket.OPEN) socket.send(encode({ event: channel, payload }));
  };
  clients.add(send);
  socket.on("close", () => clients.delete(send));
  socket.on("message", async (data) => {
    let call: Call;
    try {
      call = decode<Call>(String(data));
    } catch {
      return;
    }
    const handler = handlers.get(call.channel);
    try {
      if (!handler) throw new Error(`no handler for ${call.channel}`);
      const result = await handler({ sender: null }, ...(call.args ?? []));
      socket.send(encode({ id: call.id, result: result ?? null }));
    } catch (error) {
      socket.send(encode({ id: call.id, error: error instanceof Error ? error.message : String(error) }));
    }
  });
}

async function main(): Promise<void> {
  await startCore();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const path = new URL(url, "http://x").pathname;
    if (path === "/" || path === "/index.html") {
      res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" }).end(page());
      return;
    }
    const file = fileFor(url);
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws" || !sameOrigin(req)) {
      logLine(
        "warn",
        `web: refused a socket from origin ${req.headers.origin ?? "(none)"} (host ${req.headers.host ?? "(none)"}, public ${PUBLIC_HOSTS.join(", ") || "(WEB_HOST unset)"})`,
      );
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => serve(ws));
  });

  server.listen(PORT, HOST, () =>
    console.log(
      `OpenDesktop on http://${HOST}:${PORT}${PUBLIC_HOSTS.length > 0 ? `, public as https://${PUBLIC_HOSTS[0]}` : ""}`,
    ),
  );

  const stop = (): void => {
    stopCore();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

void main();
