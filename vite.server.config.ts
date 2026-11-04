import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const pkg = require('./package.json') as { dependencies: Record<string, string> }

// The web server: the desktop main process bundled for plain node, with
// `electron` replaced by the server's stand-in. CommonJS, like the desktop
// build, so `__dirname` means what the main process expects it to.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve('src/shared'), electron: resolve('src/server/electron.ts') }
  },
  build: {
    ssr: true,
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      input: { server: resolve('src/server/main.ts') },
      external: [...Object.keys(pkg.dependencies), 'cpu-features', /^node:/],
      output: { format: 'cjs', entryFileNames: '[name].cjs' }
    }
  }
})
