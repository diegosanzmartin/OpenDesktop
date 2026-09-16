import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import { defineConfig } from 'vite'

/**
 * Bundles the UI check as one classic script plus its stylesheet.
 *
 * Not a module: the page is loaded over file:// and Chromium refuses ES modules
 * from an opaque origin, which fails silently — the script simply never runs.
 * An IIFE has no such problem and needs no server to test a component.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // React reads this, and lib mode does not define it for us.
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'out/uicheck',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: resolve('src/renderer/ui-check.tsx'),
      formats: ['iife'],
      name: 'openDesktopUiCheck',
      fileName: () => 'ui-check.js'
    }
  }
})
