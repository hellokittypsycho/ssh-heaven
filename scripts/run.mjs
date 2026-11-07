import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const cli = fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url))
const child = spawn(process.execPath, [cli, process.argv[2] || 'dev'], { env, stdio: 'inherit', windowsHide: true })
child.on('exit', (code) => process.exit(code ?? 0))
child.on('error', (error) => { console.error(error.message); process.exit(1) })
