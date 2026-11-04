import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// The browser's `window.opendesktop`: the desktop preload, with `electron`
// replaced by a socket to the web server. One classic script, loaded before the app.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), electron: resolve('src/web/electron.ts') }
  },
  build: {
    outDir: 'out/web',
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: resolve('src/web/main.ts'), formats: ['iife'], name: 'OpenDesktopWeb', fileName: () => 'web.js' }
  }
})
