import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// A standalone bridge lets clients use the app's embedded Node runtime. It is
// copied outside app.asar, so no installed Node.js or module lookup is needed.
await build({
  entryPoints: [fileURLToPath(new URL('../electron/mcp-bridge.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../build/mcp/bridge.cjs', import.meta.url)),
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  sourcemap: false, legalComments: 'eof', logLevel: 'warning'
})
