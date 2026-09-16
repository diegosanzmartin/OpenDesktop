/**
 * Loads the UI check page in a hidden window and reports what it found.
 *
 * Electron is the test environment because it is the one the app runs in: the
 * same Chromium, the same CSS engine. No DOM shim can say whether a container
 * query holds; this can.
 */
import { app, BrowserWindow } from 'electron'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(process.cwd(), 'out/uicheck')

/**
 * The page is written here rather than kept as a source file, so the script and
 * stylesheet names live in exactly one place.
 */
function writePage(): string {
  // Named after the package in lib mode, so it is found rather than guessed at.
  const css = readdirSync(OUT).find((name) => name.endsWith('.css'))
  const styles = css ? `<link rel="stylesheet" href="./${css}">` : ''
  const page = join(OUT, 'index.html')
  writeFileSync(
    page,
    `<!doctype html><html><head><meta charset="utf-8">${styles}<script>
      /*
       * Counted rather than flagged. Setting the result directly was useless:
       * the suite writes its own failure count at the end of the run, so any
       * error raised before then was overwritten with a pass. A page that
       * throws has something wrong with it whatever the assertions say.
       */
      window.__pageErrors = 0
      window.onerror = (message, source, line, _c, error) => {
        console.log('PAGE ERROR: ' + message + ' @' + source + ':' + line)
        if (error && error.stack) console.log(error.stack)
        window.__pageErrors++
      }
      window.addEventListener('unhandledrejection', (event) => {
        console.log('UNHANDLED: ' + (event.reason && (event.reason.stack || event.reason.message)))
        window.__pageErrors++
      })
    </script></head><body><script src="./ui-check.js"></script></body></html>`,
    'utf8'
  )
  return page
}

void app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: { sandbox: false }
  })

  // The signature differs across Electron majors; take whichever shape arrives.
  win.webContents.on(
    'console-message',
    (...args: unknown[]) => {
      const first = args[0] as { message?: string } | undefined
      console.log(first?.message ?? String(args[2] ?? ''))
    }
  )
  win.webContents.on('did-fail-load', (_e, code, description) => {
    console.log(`the page failed to load: ${code} ${description}`)
  })

  // A screenshot of one dialog, for the times a design is the specification.
  const shot = process.env.OPENDESKTOP_SHOT
  await win.loadFile(writePage(), shot ? { search: `shot=${shot}` } : undefined)

  // The page sets this when it is finished, pass or fail.
  const failures = await new Promise<number>((resolve) => {
    const deadline = Date.now() + 20_000
    const poll = setInterval(() => {
      void win.webContents
        .executeJavaScript('window.__uiCheck')
        .then((value: unknown) => {
          if (typeof value === 'number') {
            clearInterval(poll)
            resolve(value)
          } else if (Date.now() > deadline) {
            clearInterval(poll)
            console.log('the UI check did not finish within 20s')
            resolve(1)
          }
        })
        .catch(() => undefined)
    }, 150)
  })

  if (shot) {
    const image = await win.webContents.capturePage()
    const path = join(OUT, `${shot}.png`)
    writeFileSync(path, image.toPNG())
    console.log(`wrote ${path}`)
  }

  app.exit(failures > 0 ? 1 : 0)
})
