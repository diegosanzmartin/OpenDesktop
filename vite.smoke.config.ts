import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { defineConfig } from 'vite'

const require = createRequire(import.meta.url)
const pkg = require('./package.json') as { dependencies: Record<string, string> }

// Bundles the headless smoke test with the same externals as the main process
// so it runs under plain node, no Electron involved.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  build: {
    ssr: true,
    outDir: 'out/smoke',
    emptyOutDir: true,
    target: 'node22',
    rollupOptions: {
      input: resolve('src/main/smoke.ts'),
      external: [...Object.keys(pkg.dependencies), 'ai/test', 'cpu-features', /^node:/],
      output: { format: 'esm', entryFileNames: 'smoke.mjs' }
    }
  }
})
