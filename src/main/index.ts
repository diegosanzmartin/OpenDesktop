import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { startCore, stopCore } from "./core";
import { startNotifications } from "./notifications";
import { installMenu } from "./menu";
import { startWedgeWatch, stopWedgeWatch } from "./watchdog";
import { startKeepAwake } from "./keep-awake";

const isDev = !app.isPackaged;

const isWebUrl = (url: string): boolean => /^https?:\/\//i.test(url);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 600,
    show: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#191817",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The integrated browser pane uses <webview>.
      webviewTag: true,
    },
  });

  win.on("ready-to-show", () => win.show());

  // Renderer failures are otherwise invisible from a terminal. Opt in with
  // OPENDESKTOP_DEBUG=1 to see them alongside the main-process output.
  if (process.env.OPENDESKTOP_DEBUG) {
    win.webContents.on("console-message", (event) => {
      console.log(
        `[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`,
      );
    });
    win.webContents.on("did-fail-load", (_e, code, description, url) => {
      console.log(`[renderer] failed to load ${url}: ${description} (${code})`);
    });
    win.webContents.on("did-finish-load", () =>
      console.log("[renderer] loaded"),
    );
    win.webContents.on("render-process-gone", (_e, details) =>
      console.log(`[renderer] gone: ${details.reason}`),
    );
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // The window carries the full preload (terminals, shell); it must never become some other page.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event, preferences, params) => {
    delete preferences.preload;
    preferences.nodeIntegration = false;
    preferences.contextIsolation = true;
    if (params.src !== "about:blank" && !isWebUrl(params.src)) {
      event.preventDefault();
    }
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

void app.whenReady().then(async () => {
  await startCore();
  startWedgeWatch();
  installMenu();
  createWindow();
  // After the window: what it has to say about focus is the window's, and a
  // notification that arrives before there is one has nowhere to be clicked to.
  startNotifications();
  startKeepAwake();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopWedgeWatch();
  stopCore();
});
