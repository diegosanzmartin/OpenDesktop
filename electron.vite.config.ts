import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const require = createRequire(import.meta.url)
const pkg = require('./package.json') as { dependencies: Record<string, string> }

// Node-facing deps stay external: ssh2 reaches for optional native bindings
// (cpu-features) that a bundler cannot resolve, and the AI SDK packages are
// plain CJS/ESM that Electron can require at runtime.
const nodeExternals = [...Object.keys(pkg.dependencies), 'cpu-features', 'ssh2', 'electron']

const shared = resolve('src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: resolve('src/main/index.ts'),
        external: nodeExternals
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        external: nodeExternals
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': shared, '@': resolve('src/renderer/src') } },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
