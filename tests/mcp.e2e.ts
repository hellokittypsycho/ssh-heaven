import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { McpState, RemoteFile, SessionInfo } from '../shared/types'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-mcp-e2e-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture()
const originalFile = await readFile(path.join(fixture.root, 'welcome.txt'), 'utf8')
const rendererErrors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let client: Client | undefined
let transport: StdioClientTransport | undefined
let bridgeErrors = ''
let connectionToken = ''

type ToolResult = Awaited<ReturnType<Client['callTool']>>
type Outcome = { result: ToolResult; error?: never } | { result?: never; error: unknown }
function resultText(result: ToolResult): string {
  return (result.content as { type: string; text?: string }[]).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n')
}
function data<T>(result: ToolResult): T {
  assert.notEqual(result.isError, true, `MCP tool failed: ${resultText(result)}`)
  return JSON.parse(resultText(result)) as T
}
function call(name: string, args: Record<string, unknown> = {}) {
  assert.ok(client)
  return client.callTool({ name, arguments: args }, undefined, { timeout: 40_000 })
}
function pending(name: string, args: Record<string, unknown>): Promise<Outcome> {
  return call(name, args).then((result) => ({ result }), (error: unknown) => ({ error }))
}
function assertDenied(outcome: Outcome, pattern: RegExp = /denied|disabled|cancel|closed|rejected/i) {
  const message = outcome.error ? String(outcome.error) : resultText(outcome.result!)
  assert.ok(outcome.error || outcome.result?.isError, 'An unapproved MCP operation must fail')
  assert.match(message, pattern)
}
async function launch(): Promise<Page> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  const current = await app.firstWindow()
  current.on('pageerror', (error) => rendererErrors.push(error.message))
  await expect(current.getByRole('button', { name: 'MCP server', exact: true })).toBeVisible()
  // These tests never write to the user's system clipboard.
  await app.evaluate(({ clipboard }) => {
    const target = globalThis as unknown as { mcpTestClipboard?: string }
    clipboard.writeText = async (value) => { target.mcpTestClipboard = value }
  })
  page = current
  return current
}
async function panel(current: Page) {
  await current.getByRole('button', { name: 'MCP server', exact: true }).click()
  const dialog = current.getByRole('dialog', { name: 'AI tools (MCP)', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
async function connectBridge(state: McpState) {
  const configuration = JSON.parse(state.claudeConfig) as { mcpServers: Record<string, StdioServerParameters> }
  const server = Object.values(configuration.mcpServers)[0]
  assert.ok(server?.command && server.args?.length, 'Client configuration must launch the bundled stdio bridge')
  assert.equal(server.env?.ELECTRON_RUN_AS_NODE, '1')
  assert.ok(server.args.some((argument) => argument.endsWith('bridge.cjs')))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  transport = new StdioClientTransport({ ...server, env: { ...env, ...server.env }, stderr: 'pipe' })
  transport.stderr?.on('data', (chunk: Buffer | string) => { bridgeErrors += String(chunk) })
  client = new Client({ name: 'ssh-heaven-electron-e2e', version: '1.0.0' })
  await client.connect(transport)
}
async function closeBridge() {
  await client?.close().catch(() => {})
  await transport?.close().catch(() => {})
  client = undefined; transport = undefined
}

try {
  let current = await launch()
  let state = await current.evaluate(() => window.sshHeaven.getMcpState())
  assert.equal(state.enabled, false)
  assert.deepEqual(state.pendingApprovals, [])
  let settings = await panel(current)
  await expect(settings.getByText('MCP server disabled', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Enable MCP server', exact: true }).click()
  await expect(settings.getByText('MCP server enabled', { exact: true })).toBeVisible()
  state = await current.evaluate(() => window.sshHeaven.getMcpState())
  assert.ok(state.endpoint && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(state.endpoint))
  assert.ok(state.connectionFile)
  const protectedConnection = JSON.parse(await readFile(state.connectionFile, 'utf8')) as { token: string }
  connectionToken = protectedConnection.token
  assert.ok(connectionToken.length >= 32)
  assert.equal(JSON.stringify(state).includes(connectionToken), false, 'MCP UI state and configuration must not disclose its bearer token')
  assert.equal(state.claudeConfig.includes(fixture.password), false)
  assert.match(state.codexConfig, /tool_timeout_sec\s*=\s*240/)
  await settings.getByRole('button', { name: 'Copy Claude MCP configuration', exact: true }).click()
  assert.equal(await app!.evaluate(() => (globalThis as unknown as { mcpTestClipboard?: string }).mcpTestClipboard), state.claudeConfig)
  await settings.getByRole('button', { name: 'Copy Codex MCP configuration', exact: true }).click()
  assert.equal(await app!.evaluate(() => (globalThis as unknown as { mcpTestClipboard?: string }).mcpTestClipboard), state.codexConfig)
  for (const authorization of [undefined, 'Bearer invalid-test-token']) {
    const response: Response = await fetch(state.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 401, 'Loopback access without the protected token must be rejected')
  }
  for (const headers of [{ Origin: 'https://untrusted.example' }, { Host: 'untrusted.example' }] as Record<string, string>[]) {
    const response: Response = await fetch(state.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${connectionToken}`, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), signal: AbortSignal.timeout(5000) })
    assert.ok([400, 403, 421].includes(response.status), 'Authenticated requests from an untrusted origin or host must still be rejected')
  }
  await connectBridge(state)
  const tools = (await client!.listTools()).tools.map((tool) => tool.name).sort()
  assert.deepEqual(tools, ['list_hosts', 'list_remote_files', 'list_sessions', 'read_remote_file', 'read_server_metrics', 'run_command', 'run_group_command', 'write_remote_file'].sort())
  assert.deepEqual(data<unknown[]>(await call('list_sessions')), [])
  assert.deepEqual(data<unknown[]>(await call('list_hosts')), [])
  await current.screenshot({ path: path.join(root, 'test-results', 'mcp-configuration.png') })

  // Disabling the app's server invalidates an already-running external bridge.
  await settings.getByRole('button', { name: 'Disable MCP server', exact: true }).click()
  await expect(settings.getByText('MCP server disabled', { exact: true })).toBeVisible()
  assertDenied(await pending('list_sessions', {}), /disabled|connect|fetch|closed|unavailable|refused/i)
  await closeBridge()
  await settings.getByRole('button', { name: 'Enable MCP server', exact: true }).click()
  await expect(settings.getByText('MCP server enabled', { exact: true })).toBeVisible()
  state = await current.evaluate(() => window.sshHeaven.getMcpState())
  const nextConnection = JSON.parse(await readFile(state.connectionFile!, 'utf8')) as { token: string }
  assert.notEqual(nextConnection.token, connectionToken, 'A new server activation must rotate its authentication token')
  connectionToken = nextConnection.token
  await connectBridge(state)
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click()

  await current.getByRole('tab', { name: 'New connection', exact: true }).click()
  await current.getByLabel(/^Nickname/).fill('MCP fixture')
  await current.getByLabel(/^Group/).fill('MCP QA')
  await current.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
  await current.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
  await current.getByLabel('Username', { exact: true }).fill(fixture.username)
  await current.getByLabel('Password', { exact: true }).fill(fixture.password)
  await current.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(current.getByRole('dialog', { name: 'Verify server identity', exact: true })).toBeVisible()
  await current.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(current.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  const sessions = data<SessionInfo[]>(await call('list_sessions'))
  assert.equal(sessions.length, 1)
  const sessionId = sessions[0].sessionId
  assert.equal(sessions[0].host, fixture.host)
  const hosts = await call('list_hosts')
  assert.equal(resultText(hosts).includes(fixture.password), false)
  assert.equal(resultText(hosts).includes(connectionToken), false)
  assert.equal(data<unknown[]>(hosts).length, 1)
  assert.match(resultText(await call('list_remote_files', { sessionId, path: '/' })), /welcome\.txt/)
  const original = data<RemoteFile>(await call('read_remote_file', { sessionId, path: '/welcome.txt' }))
  assert.equal(original.content, originalFile)
  const approval = current.getByRole('dialog', { name: 'Review AI request', exact: true })

  const cancellation = new AbortController()
  const canceled = client!.callTool({ name: 'run_command', arguments: { sessionId, command: 'echo canceled-before-review-marker' } }, undefined, { timeout: 40_000, signal: cancellation.signal }).then((result): Outcome => ({ result }), (error: unknown): Outcome => ({ error }))
  await expect(approval).toBeVisible()
  cancellation.abort()
  assertDenied(await canceled, /abort|cancel/i)
  await expect(approval).toHaveCount(0)

  const firstQueued = pending('run_command', { sessionId, command: 'echo first-queued-marker' })
  await expect(approval.getByLabel('MCP command preview', { exact: true })).toHaveText('echo first-queued-marker')
  const secondQueued = pending('run_command', { sessionId, command: 'echo second-queued-marker' })
  await expect.poll(async () => (await current.evaluate(() => window.sshHeaven.getMcpState())).pendingApprovals.length).toBe(2)
  await approval.getByRole('button', { name: 'Deny MCP request', exact: true }).click()
  assertDenied(await firstQueued)
  await expect(approval.getByLabel('MCP command preview', { exact: true })).toHaveText('echo second-queued-marker')
  await expect(approval.getByRole('button', { name: 'Close dialog', exact: true })).toBeFocused()
  await approval.getByRole('button', { name: 'Deny MCP request', exact: true }).click()
  assertDenied(await secondQueued)
  await expect(approval).toHaveCount(0)

  let request = pending('run_command', { sessionId, command: 'echo denied-command-marker' })
  await expect(approval).toBeVisible()
  await expect(approval.getByLabel('MCP command preview', { exact: true })).toHaveText('echo denied-command-marker')
  await expect(approval.getByText(`${fixture.username}@${fixture.host}:${fixture.port}`, { exact: true })).toBeVisible()
  await approval.getByRole('button', { name: 'Deny MCP request', exact: true }).click()
  assertDenied(await request)
  await expect(approval).toHaveCount(0)

  request = pending('run_command', { sessionId, command: 'echo mcp-command-approved-marker' })
  await expect(approval).toBeVisible()
  // Approval remains global after the configuration panel has been closed.
  await expect(current.getByRole('dialog', { name: 'AI tools (MCP)', exact: true })).toHaveCount(0)
  await current.screenshot({ path: path.join(root, 'test-results', 'mcp-command-approval.png') })
  await approval.getByRole('button', { name: 'Approve MCP request', exact: true }).click()
  let outcome = await request
  assert.ok(outcome.result)
  const command = data<{ stdout: string; exitCode: number }>(outcome.result)
  assert.equal(command.exitCode, 0)
  assert.match(command.stdout, /mcp-command-approved-marker/)
  await expect(approval).toHaveCount(0)

  request = pending('run_group_command', { group: 'MCP QA', command: 'echo mcp-group-approved-marker' })
  await expect(approval).toBeVisible()
  await expect(approval.getByRole('region', { name: 'Reviewed MCP targets', exact: true })).toContainText(`${fixture.username}@${fixture.host}:${fixture.port}`)
  await approval.getByRole('button', { name: 'Approve MCP request', exact: true }).click()
  outcome = await request
  assert.ok(outcome.result)
  assert.notEqual(outcome.result.isError, true)
  assert.match(resultText(outcome.result), /mcp-group-approved-marker/)

  request = pending('write_remote_file', { sessionId, path: '/welcome.txt', content: 'denied-file-marker\n', expectedVersion: original.version })
  await expect(approval).toBeVisible()
  await expect(approval.getByLabel('Current remote file contents', { exact: true })).toHaveText(originalFile)
  await expect(approval.getByLabel('Proposed remote file contents', { exact: true })).toHaveText('denied-file-marker\n')
  assert.equal(await readFile(path.join(fixture.root, 'welcome.txt'), 'utf8'), originalFile)
  await approval.getByRole('button', { name: 'Deny MCP request', exact: true }).click()
  assertDenied(await request)
  assert.equal(await readFile(path.join(fixture.root, 'welcome.txt'), 'utf8'), originalFile)

  const fullContent = `${'Full preview line.\n'.repeat(1200)}mcp-final-preview-marker\n`
  request = pending('write_remote_file', { sessionId, path: '/welcome.txt', content: fullContent, expectedVersion: original.version })
  await expect(approval).toBeVisible()
  await expect(approval.getByLabel('Proposed remote file contents', { exact: true })).toHaveText(fullContent)
  await current.screenshot({ path: path.join(root, 'test-results', 'mcp-file-approval.png') })
  await approval.getByRole('button', { name: 'Approve MCP request', exact: true }).click()
  outcome = await request
  assert.ok(outcome.result)
  assert.equal(data<RemoteFile>(outcome.result).content, fullContent)
  assert.equal(await readFile(path.join(fixture.root, 'welcome.txt'), 'utf8'), fullContent)
  const reread = data<RemoteFile>(await call('read_remote_file', { sessionId, path: '/welcome.txt' }))
  assert.equal(reread.content, fullContent)
  assert.notEqual(reread.version, original.version)

  // Disabling with an unreviewed request must clear the global approval and fail it.
  request = pending('run_command', { sessionId, command: 'echo unreviewed-disable-marker' })
  await expect(approval).toBeVisible()
  await current.evaluate(() => window.sshHeaven.setMcpEnabled(false))
  await expect(approval).toHaveCount(0)
  assertDenied(await request, /disabled|cancel|closed|fetch|connect|unavailable|refused/i)
  await closeBridge()
  settings = await panel(current)
  await expect(settings.getByText('MCP server disabled', { exact: true })).toBeVisible()
  await settings.getByRole('button', { name: 'Enable MCP server', exact: true }).click()
  await expect(settings.getByText('MCP server enabled', { exact: true })).toBeVisible()
  await app!.close(); app = undefined

  // Persisted client configuration never silently enables MCP on the next launch.
  current = await launch()
  state = await current.evaluate(() => window.sshHeaven.getMcpState())
  assert.equal(state.enabled, false)
  assert.deepEqual(state.pendingApprovals, [])
  assert.equal((await current.evaluate(() => window.sshHeaven.listProfiles())).length, 1)
  assert.deepEqual(rendererErrors, [])
  console.log('MCP E2E passed: bundled stdio handshake, token-free client configuration, clipboard stubs, loopback authentication and hostile-origin rejection, session/file reads, explicit command/group/file approvals and denials, full previews, cancellation, and disabled-by-default restart.')
} catch (error) {
  if (page && app) {
    await page.screenshot({ path: path.join(root, 'test-results', 'mcp-failure.png') }).catch(() => {})
    console.error((await page.locator('body').innerText().catch(() => '')).replaceAll(fixture.password, '[REDACTED]').replaceAll(connectionToken || 'unused-test-token', '[REDACTED]').slice(0, 6500))
  }
  if (bridgeErrors) console.error(bridgeErrors.replaceAll(connectionToken || 'unused-test-token', '[REDACTED]').slice(0, 3000))
  throw error
} finally {
  await closeBridge()
  try { await app?.close() }
  finally {
    try { await fixture.close() }
    finally {
      // temporary is the absolute path returned by mkdtemp above.
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
