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

/*
 * The motif: two conversations that touch.
 *
 * Which is the thing this app is for — several agents working at once on the
 * same repository, overlapping without treading on each other. One ring is
 * the conversation in front of you, the other the one next to it.
 *
 * The mark is deliberately heavier, and smaller, than it looks like it needs
 * to be. An icon is decided at 16 pixels, not at 1024. The first draft used a
 * 11/100 stroke, which is 1.1px in the menu bar and turns into grey mush; the
 * second filled 88% of the plate and left the rings touching its edges, which
 * is what an icon looks like when nobody checked it in the Dock. 14.5/100 at
 * 80% keeps both holes open at 16px and still leaves the plate a margin.
 */
const HTML = `<!doctype html>
<meta charset="utf-8">
<style>
  /* Everything is in vmin so the design is independent of the window size:
     macOS clamps a window to the display, so a fixed-pixel layout gets cropped. */
  html, body { margin: 0; width: 100vw; height: 100vw; background: transparent; overflow: hidden; }
  .plate {
    position: absolute; inset: 8.6vw;
    border-radius: 19.5vw;
    background: linear-gradient(170deg, #232120 0%, #1a1918 60%, #141312 100%);
    box-shadow: inset 0 0.5vw 0 rgba(255,255,255,0.05);
    display: flex; align-items: center; justify-content: center;
  }
  .mark { width: 80%; height: 80%; }
</style>
<div class="plate">
  <svg class="mark" viewBox="0 0 100 100">
    <circle cx="65.5" cy="50" r="24" fill="none" stroke="#d97757" stroke-width="14.5" opacity="0.55"/>
    <circle cx="34.5" cy="50" r="24" fill="none" stroke="#d97757" stroke-width="14.5"/>
  </svg>
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
