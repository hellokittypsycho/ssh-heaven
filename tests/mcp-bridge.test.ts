import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('MCP bridge rejects invalid local connection details without leaking tokens or writing protocol garbage', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ssh-heaven-bridge-test-'))
  try {
    const token = 's'.repeat(43)
    const filename = path.join(directory, 'connection.json')
    const cli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
    const bridge = fileURLToPath(new URL('../electron/mcp-bridge.ts', import.meta.url))
    for (const endpoint of ['http://127.0.0.2:9/mcp', 'http://127.0.0.1:9/wrong-path', 'http://127.0.0.1:9/mcp?token=secret']) {
      await writeFile(filename, JSON.stringify({ version: 1, application: 'ssh-heaven-mcp', pid: process.pid, endpoint, token }), { mode: 0o600 })
      const result = await new Promise<{ failed: boolean; stdout: string; stderr: string }>((resolve) => {
        execFile(process.execPath, [cli, bridge, '--config', filename], { windowsHide: true, timeout: 4000 }, (error, stdout, stderr) => resolve({ failed: !!error, stdout, stderr }))
      })
      assert.equal(result.failed, true)
      assert.equal(result.stdout, '', 'Bridge stdout is reserved exclusively for MCP messages')
      assert.match(result.stderr, /Open SSH Heaven, enable MCP/)
      assert.equal(result.stderr.includes(token), false)
      assert.equal(result.stderr.includes('token=secret'), false)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
