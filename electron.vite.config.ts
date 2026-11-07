import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(root, 'electron/main.ts'),
        external: ['electron', 'ssh2', /^@modelcontextprotocol\/sdk(?:\/|$)/, /^zod(?:\/|$)/],
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(root, 'electron/preload.ts'),
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve(root, 'src'),
    resolve: { alias: { '@ssh-heaven/privacy-jsx': resolve(root, 'src/privacy-jsx') } },
    plugins: [
      react({ jsxImportSource: '@ssh-heaven/privacy-jsx' }),
      {
        name: 'development-refresh-csp',
        apply: 'serve',
        // Vite's local refresh preamble is inline. Production retains script-src 'self'.
        transformIndexHtml: {
          order: 'post',
          handler: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        }
      }
    ],
    build: { rollupOptions: { input: resolve(root, 'src/index.html') } }
  }
})
