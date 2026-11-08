import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') throw new Error('The packaged test currently targets the Windows x64 build.')
const cli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const executable = fileURLToPath(new URL('../release/win-unpacked/SSH Heaven.exe', import.meta.url))
for (const filename of ['e2e.ts', 'home-keygen.e2e.ts', 'themes.e2e.ts', 'productivity.e2e.ts', 'window-chrome.e2e.ts', 'fleet.e2e.ts', 'workspace-tools.e2e.ts', 'management.e2e.ts', 'folders.e2e.ts', 'mcp.e2e.ts', 'terminal-layout.e2e.ts', 'wallpaper.e2e.ts', 'quick-connect.e2e.ts', 'input-latency.e2e.ts', 'stream-terminal.e2e.ts', 'scripts.e2e.ts', 'vault.e2e.ts', 'navigation.e2e.ts', 'updates.e2e.ts', 'connection-defaults.e2e.ts', 'qol.e2e.ts', 'file-workflow.e2e.ts', 'transfer-qol.e2e.ts', 'multi-session-performance.e2e.ts', 'editor-performance.e2e.ts']) {
  const test = fileURLToPath(new URL(`../tests/${filename}`, import.meta.url))
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, test], {
      env: { ...process.env, SSH_HEAVEN_EXECUTABLE: executable }, stdio: 'inherit', windowsHide: true
    })
    child.on('exit', (status) => resolve(status ?? 1))
    child.on('error', reject)
  })
  if (code !== 0) process.exit(Number(code))
}
