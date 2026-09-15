/**
 * Renders the app icon with Electron and builds build/icon.icns.
 *
 * There is no SVG rasterizer on a stock macOS, but we already depend on a
 * browser engine, so draw the icon in HTML, capture it at 1024px and let
 * sips/iconutil produce the iconset.
 *
 * CommonJS on purpose: with an ESM main entry Electron never resolves
 * app.whenReady() here, and the script hangs before the window exists.
 *
 * Run with: pnpm icon
 */
const { app, BrowserWindow } = require('electron')
const { execFile } = require('node:child_process')
const { mkdir, rm, writeFile } = require('node:fs/promises')
const { join, resolve } = require('node:path')
const { promisify } = require('node:util')

const run = promisify(execFile)
const OUT_DIR = 'build'
const ICONSET = join(OUT_DIR, 'icon.iconset')
// Kept well under any display height: macOS shrinks an oversized window,
// and capturePage would then return a non-square image.
const SIZE = 600

// The motif is the app's own idea: stacked command blocks, the top one open.
const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  /* Everything is in vmin so the design is independent of the window size:
     macOS clamps a window to the display, so a fixed-pixel layout gets cropped. */
  html, body { margin: 0; width: 100vw; height: 100vw; background: transparent; overflow: hidden; }
  .plate {
    position: absolute; inset: 8.6vw;
    border-radius: 19.5vw;
    background: linear-gradient(155deg, #2e2b27 0%, #1b1a18 55%, #111010 100%);
    box-shadow: inset 0 0.6vw 0 rgba(255,255,255,0.055), inset 0 -0.8vw 2.4vw rgba(0,0,0,0.55);
    overflow: hidden;
  }
  .glow {
    position: absolute; width: 74vw; height: 74vw; left: -17vw; top: -27vw;
    background: radial-gradient(circle, rgba(217,119,87,0.26) 0%, rgba(217,119,87,0) 68%);
  }
  .stack { position: absolute; left: 14.5vw; top: 29.4vw; width: 53.5vw; }
  .bar {
    height: 9.4vw; border-radius: 2.8vw; margin-bottom: 3.9vw;
    background: #322e2b; display: flex; align-items: center; padding-left: 3.9vw;
    box-sizing: border-box;
  }
  .bar.open { background: #d97757; }
  .bar.dim { background: #2a2724; }
  .chev { width: 3.3vw; height: 3.3vw; border-right: 0.98vw solid; border-bottom: 0.98vw solid; }
  .bar.open .chev { border-color: #2b1a13; transform: rotate(45deg) translateY(-0.5vw); }
  .bar.dim .chev { border-color: #6e6b66; transform: rotate(-45deg) translate(0.6vw, -0.6vw); }
  .body {
    height: 14.6vw; border-radius: 2.8vw; background: #232120; margin-top: -1.6vw;
    margin-bottom: 3.9vw; padding: 3.3vw 3.9vw; box-sizing: border-box;
  }
  .line { height: 1.75vw; border-radius: 0.9vw; background: #45403b; margin-bottom: 2.3vw; }
  .line.short { width: 58%; background: #3a3632; margin-bottom: 0; }
</style>
<div class="plate">
  <div class="glow"></div>
  <div class="stack">
    <div class="bar open"><div class="chev"></div></div>
    <div class="body">
      <div class="line"></div>
      <div class="line short"></div>
    </div>
    <div class="bar dim"><div class="chev"></div></div>
  </div>
</div>`

// macOS wants these exact members in an iconset.
const VARIANTS = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

async function main() {
  // A real window parked off-screen: an offscreen transparent window never
  // composites a first frame, and capturePage then blocks forever.
  const win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    x: -SIZE - 200,
    y: 0,
    show: true,
    transparent: true,
    frame: false,
    hasShadow: false,
    skipTaskbar: true,
    backgroundColor: '#00000000'
  })

  await mkdir(OUT_DIR, { recursive: true })
  // Electron blocks top-level navigation to data: URLs, so stage a real file.
  const page = join(OUT_DIR, 'icon.html')
  await writeFile(page, HTML, 'utf8')
  await win.loadFile(resolve(page))
  await new Promise((resolve) => setTimeout(resolve, 800))

  const image = await win.webContents.capturePage()
  const { width, height } = image.getSize()
  if (width !== height) throw new Error(`capture is not square: ${width}x${height}`)
  const master = join(OUT_DIR, 'icon.png')
  await writeFile(master, image.toPNG())

  await rm(ICONSET, { recursive: true, force: true })
  await mkdir(ICONSET, { recursive: true })
  for (const [name, size] of VARIANTS) {
    await run('sips', ['-z', String(size), String(size), master, '--out', join(ICONSET, name)])
  }
  await run('iconutil', ['-c', 'icns', ICONSET, '-o', join(OUT_DIR, 'icon.icns')])
  await rm(ICONSET, { recursive: true, force: true })
  await rm(page, { force: true })

  console.log(`wrote ${join(OUT_DIR, 'icon.icns')} from a ${image.getSize().width}px master`)
}

const guard = setTimeout(() => {
  console.error('icon render timed out')
  app.exit(1)
}, 60000)

app.whenReady().then(main).then(
  () => {
    clearTimeout(guard)
    app.exit(0)
  },
  (err) => {
    console.error(err)
    app.exit(1)
  }
)
