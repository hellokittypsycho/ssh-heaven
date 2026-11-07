import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { HostProfile, McpApproval, McpState } from '../shared/types'
import type { SFTPWrapper } from 'ssh2'
import { McpService, MCP_TOOLS } from '../electron/mcp-server'
import { MetricsService } from '../electron/metrics'
import { RemoteEditorService } from '../electron/remote-editor'
import { SshService } from '../electron/ssh-service'
import { AppStore } from '../electron/store'
import { startFixture } from './fixture'

function output<T>(result: unknown): T {
  const value = result as CallToolResult
  assert.equal(value.isError, undefined, JSON.stringify(value.content))
  assert.equal(value.content[0]?.type, 'text')
  return JSON.parse((value.content[0] as { text: string }).text) as T
}
function errorText(result: unknown): string {
  const value = result as CallToolResult
  assert.equal(value.isError, true)
  return (value.content[0] as { text: string }).text
}
async function eventually(predicate: () => boolean, label = 'condition'): Promise<void> {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`); await new Promise((resolve) => setTimeout(resolve, 10)) }
}
async function harness(approvalTimeoutMs = 4000) {
  const fixture = await startFixture()
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-mcp-'))
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const owner = 901
  const sessionId = 'mcp-session'
  const profile: HostProfile = { id: 'mcp-fixture', name: 'MCP fixture', host: fixture.host, port: fixture.port, username: fixture.username, authType: 'password', group: 'Test fleet' }
  await store.saveProfile(profile)
  await store.saveProfile({ id: 'private-key-metadata', name: 'Key metadata only', host: 'example.invalid', port: 22, username: 'root', authType: 'privateKey', privateKeyPath: path.join(directory, 'never-expose-key') })
  const ssh = new SshService(store, {
    data() {}, status() {}, hostKey(ownerId, challenge) { queueMicrotask(() => ssh.resolveHostKey(ownerId, challenge.requestId, true)) }
  })
  await ssh.connect({ sessionId, password: fixture.password, profile }, owner)
  const editor = new RemoteEditorService((ownerId, id) => ssh.getSftp(ownerId, id))
  const metrics = new MetricsService(ssh)
  const connectionFile = path.join(directory, 'mcp', 'connection.json')
  const states: McpState[] = []
  const mcp = new McpService({ store, ssh, editor, metrics, version: 'test', connectionFile, bridgePath: path.join(directory, 'bridge.cjs'), bridgeCommand: process.execPath, bridgeEnv: { ELECTRON_RUN_AS_NODE: '1' }, approvalTimeoutMs, notifyState: (state) => states.push(state) })
  const clients: { client: Client; transport: StreamableHTTPClientTransport }[] = []
  const calls: string[] = []
  const exec = ssh.execOnSession.bind(ssh)
  ssh.execOnSession = async (...args) => { calls.push(args[2]); return exec(...args) }
  const connect = async () => {
    const connection = JSON.parse(await readFile(connectionFile, 'utf8')) as { endpoint: string; token: string }
    const client = new Client({ name: 'mcp-integration-test', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL(connection.endpoint), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } } })
    await client.connect(transport)
    clients.push({ client, transport })
    return { client, transport, connection }
  }
  return {
    fixture, directory, store, owner, sessionId, profile, ssh, editor, mcp, connectionFile, states, calls, connect,
    async approval(): Promise<McpApproval> { await eventually(() => mcp.getState().pendingApprovals.length > 0, 'approval'); return mcp.getState().pendingApprovals[0] },
    async close() {
      for (const { client, transport } of clients) { await transport.terminateSession().catch(() => {}); await client.close().catch(() => {}) }
      await mcp.dispose(); ssh.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true })
    }
  }
}

test('MCP authenticates loopback requests, rejects browser origins/host spoofing/oversized bodies, and exposes standard sanitized discovery', { timeout: 25_000 }, async () => {
  const h = await harness()
  try {
    assert.equal(h.mcp.getState().enabled, false)
    await assert.rejects(readFile(h.connectionFile), /ENOENT/)
    const state = await h.mcp.setEnabled(h.owner, true)
    const { client, connection } = await h.connect()
    assert.match(connection.token, /^[\w-]{43}$/)
    assert.equal(JSON.stringify(state).includes(connection.token), false)
    assert.deepEqual(JSON.parse(state.claudeConfig).mcpServers['ssh-heaven'].env, { ELECTRON_RUN_AS_NODE: '1' })
    assert.match(state.codexConfig, /tool_timeout_sec = 240/)
    if (process.platform !== 'win32') assert.equal((await stat(h.connectionFile)).mode & 0o077, 0)
    const headers = { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
    assert.equal((await fetch(connection.endpoint)).status, 401)
    assert.equal((await fetch(connection.endpoint, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status, 403)
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers: { ...headers, Origin: 'null' }, body: '{}' })).status, 403)
    const hostileHost = await new Promise<number>((resolve, reject) => {
      const req = request(connection.endpoint, { method: 'POST', headers: { ...headers, Host: 'untrusted.example' } }, (res) => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject); req.end('{}')
    })
    assert.equal(hostileHost, 403)
    const malformed = await fetch(connection.endpoint, { method: 'POST', headers, body: '{' })
    assert.equal(malformed.status, 400)
    assert.equal(malformed.headers.get('access-control-allow-origin'), null)
    assert.equal((await fetch(connection.endpoint, { method: 'POST', headers, body: 'x'.repeat(1024 * 1024 + 1) })).status, 413)
    const chunkedTooLarge = await new Promise<number>((resolve, reject) => {
      const req = request(connection.endpoint, { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' } }, (res) => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject); req.write('x'.repeat(512 * 1024)); req.end('x'.repeat(512 * 1024 + 1))
    })
    assert.equal(chunkedTooLarge, 413)
    assert.equal((await fetch(`${connection.endpoint}?token=${connection.token}`, { headers })).status, 404)
    assert.equal((await fetch(connection.endpoint, { headers })).status, 400)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...MCP_TOOLS].sort())
    assert.equal(tools.tools.find((tool) => tool.name === 'read_remote_file')?.annotations?.readOnlyHint, true)
    assert.equal(tools.tools.find((tool) => tool.name === 'run_command')?.annotations?.readOnlyHint, false)
    const hosts = output<HostProfile[]>(await client.callTool({ name: 'list_hosts', arguments: {} }))
    assert.equal(hosts.length, 2)
    assert.equal(JSON.stringify(hosts).includes('privateKeyPath'), false)
    assert.equal(JSON.stringify(hosts).includes('never-expose-key'), false)
    assert.equal(JSON.stringify(hosts).includes(h.fixture.password), false)
    const sessions = output<{ sessionId: string; host: string; username: string }[]>(await client.callTool({ name: 'list_sessions', arguments: {} }))
    assert.deepEqual(sessions.map((session) => session.sessionId), [h.sessionId])
    const directory = output<{ entries: { name: string }[] }>(await client.callTool({ name: 'list_remote_files', arguments: { sessionId: h.sessionId, path: '/' } }))
    assert.ok(directory.entries.some((entry) => entry.name === 'welcome.txt'))
    const file = output<{ content: string; version: string }>(await client.callTool({ name: 'read_remote_file', arguments: { sessionId: h.sessionId, path: '/welcome.txt' } }))
    assert.match(file.content, /Welcome/)
    assert.match(file.version, /^[a-f0-9]{64}$/)
    await writeFile(path.join(h.fixture.root, 'id_rsa'), '-----BEGIN RSA PRIVATE KEY-----\nnever-return-this\n-----END RSA PRIVATE KEY-----')
    assert.match(errorText(await client.callTool({ name: 'read_remote_file', arguments: { sessionId: h.sessionId, path: '/id_rsa' } })), /Private-key/)
    await h.ssh.connect({ sessionId: 'other-window', password: h.fixture.password, profile: h.profile }, h.owner + 1)
    assert.match(errorText(await client.callTool({ name: 'read_remote_file', arguments: { sessionId: 'other-window', path: '/welcome.txt' } })), /another window/)
  } finally { await h.close() }
})

test('MCP commands and atomic file writes require exact one-use native approval; conflicts and large/unreviewable changes never execute', { timeout: 25_000 }, async () => {
  const h = await harness()
  try {
    await h.mcp.setEnabled(h.owner, true)
    const { client } = await h.connect()
    const denied = client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo denied' } })
    let approval = await h.approval()
    assert.equal(approval.command, 'echo denied')
    assert.equal(approval.host, h.fixture.host)
    assert.equal(approval.port, h.fixture.port)
    assert.throws(() => h.mcp.resolveApproval(h.owner + 1, approval.id, true), /another application window/)
    assert.equal(h.calls.length, 0)
    h.mcp.resolveApproval(h.owner, approval.id, false)
    assert.match(errorText(await denied), /denied/)
    assert.throws(() => h.mcp.resolveApproval(h.owner, approval.id, true), /expired|canceled/)
    const allowed = client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo approved' } })
    approval = await h.approval()
    h.mcp.resolveApproval(h.owner, approval.id, true)
    assert.match(output<{ stdout: string; exitCode: number }>(await allowed).stdout, /approved/)
    const original = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    const savedText = '\uFEFFapproved MCP change\r\n'
    const saving = client.callTool({ name: 'write_remote_file', arguments: { sessionId: h.sessionId, path: '/welcome.txt', content: savedText, expectedVersion: original.version } })
    approval = await h.approval()
    assert.equal(approval.previousContent, original.content)
    assert.equal(approval.content, savedText)
    assert.equal(await readFile(path.join(h.fixture.root, 'welcome.txt'), 'utf8'), original.content)
    h.mcp.resolveApproval(h.owner, approval.id, true)
    assert.equal(output<{ content: string }>(await saving).content, savedText)
    assert.equal(await readFile(path.join(h.fixture.root, 'welcome.txt'), 'utf8'), savedText)
    assert.equal((await readdir(h.fixture.root)).some((name) => name.endsWith('.part')), false)
    const stale = await client.callTool({ name: 'write_remote_file', arguments: { sessionId: h.sessionId, path: '/welcome.txt', content: 'stale overwrite', expectedVersion: original.version } })
    assert.match(errorText(stale), /conflict/i)
    assert.equal(h.mcp.getState().pendingApprovals.length, 0)
    const fresh = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    const race = client.callTool({ name: 'write_remote_file', arguments: { sessionId: h.sessionId, path: '/welcome.txt', content: 'approved but now stale', expectedVersion: fresh.version } })
    approval = await h.approval()
    await writeFile(path.join(h.fixture.root, 'welcome.txt'), 'Changed while native approval was open')
    h.mcp.resolveApproval(h.owner, approval.id, true)
    assert.match(errorText(await race), /conflict/i)
    assert.equal(await readFile(path.join(h.fixture.root, 'welcome.txt'), 'utf8'), 'Changed while native approval was open')
    await writeFile(path.join(h.fixture.root, 'large.txt'), 'a'.repeat(65537))
    const large = await h.editor.read(h.owner, h.sessionId, '/large.txt')
    assert.match(errorText(await client.callTool({ name: 'write_remote_file', arguments: { sessionId: h.sessionId, path: '/large.txt', content: 'smaller', expectedVersion: large.version } })), /64 KiB/)
    assert.equal(h.mcp.getState().pendingApprovals.length, 0)
  } finally { await h.close() }
})

test('SDK cancellation, disconnected HTTP calls and disabling remove pending approvals without closing the SSH terminal; re-enable rotates credentials', { timeout: 25_000 }, async () => {
  const h = await harness()
  try {
    await h.mcp.setEnabled(h.owner, true)
    const { client, transport, connection } = await h.connect()
    const controller = new AbortController()
    const canceled = client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo must-not-run' } }, undefined, { signal: controller.signal }).catch((error: unknown) => error)
    await h.approval()
    controller.abort()
    await canceled
    await eventually(() => h.mcp.getState().pendingApprovals.length === 0, 'SDK approval cancellation')
    assert.equal(h.calls.length, 0)
    // Deliberately kill an authenticated tool POST without a cancellation notification.
    const pendingRequest = request(connection.endpoint, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': transport.sessionId!, 'MCP-Protocol-Version': '2025-11-25' } })
    pendingRequest.on('error', () => {})
    pendingRequest.end(JSON.stringify({ jsonrpc: '2.0', id: 'killed-client', method: 'tools/call', params: { name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo orphan-must-not-run' } } }))
    await h.approval()
    pendingRequest.destroy()
    await eventually(() => h.mcp.getState().pendingApprovals.length === 0, 'HTTP disconnect cancellation')
    assert.equal(h.calls.length, 0)
    const runningController = new AbortController()
    const running = client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'wait-for-cancel' } }, undefined, { signal: runningController.signal }).catch((error: unknown) => error)
    const approval = await h.approval()
    h.mcp.resolveApproval(h.owner, approval.id, true)
    await eventually(() => h.calls.includes('wait-for-cancel'), 'running exec channel')
    runningController.abort()
    await running
    assert.match((await h.ssh.execOnSession(h.owner, h.sessionId, 'echo terminal-still-alive')).stdout, /terminal-still-alive/)
    const disabled = client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo disabled-must-not-run' } }).catch((error: unknown) => error)
    await h.approval()
    await h.mcp.setEnabled(h.owner, false)
    await disabled
    assert.equal(h.mcp.getState().pendingApprovals.length, 0)
    assert.equal(h.mcp.getState().enabled, false)
    await assert.rejects(readFile(h.connectionFile), /ENOENT/)
    await assert.rejects(fetch(connection.endpoint))
    assert.equal(h.calls.includes('echo disabled-must-not-run'), false)
    await h.mcp.setEnabled(h.owner, true)
    const next = await h.connect()
    assert.notEqual(next.connection.token, connection.token)
    await h.mcp.cancelOwner(h.owner + 1)
    assert.equal(h.mcp.getState().enabled, true)
    await h.mcp.cancelOwner(h.owner)
    assert.equal(h.mcp.getState().enabled, false)
  } finally { await h.close() }
})

test('MCP approvals expire, reject reconnected session identities, and group commands retain their reviewed target snapshot', { timeout: 25_000 }, async () => {
  const h = await harness(350)
  try {
    await h.mcp.setEnabled(h.owner, true)
    const { client } = await h.connect()
    const expired = client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo expired' } })
    await h.approval()
    assert.match(errorText(await expired), /timed out/)
    assert.equal(h.mcp.getState().pendingApprovals.length, 0)
    const reconnected = client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo stale-client' } })
    const approval = await h.approval()
    h.ssh.disconnect(h.owner, h.sessionId)
    await h.ssh.connect({ sessionId: h.sessionId, password: h.fixture.password, profile: h.profile }, h.owner)
    h.mcp.resolveApproval(h.owner, approval.id, true)
    assert.match(errorText(await reconnected), /connection changed/i)
    assert.equal(h.calls.includes('echo stale-client'), false)
    await h.store.saveProfile({ ...h.profile, name: 'Updated nickname', group: 'Renamed group' })
    assert.equal(h.ssh.listSessions(h.owner)[0].group, 'Renamed group')
    const group = client.callTool({ name: 'run_group_command', arguments: { group: 'Renamed group', command: 'echo reviewed-group' } })
    const groupApproval = await h.approval()
    assert.deepEqual(groupApproval.targets?.map((target) => target.id), [h.sessionId])
    assert.equal(groupApproval.targets?.[0].name, 'Updated nickname')
    await h.ssh.connect({ sessionId: 'late-connection', password: h.fixture.password, profile: { ...h.profile, name: 'Late connection', group: 'Renamed group' } }, h.owner)
    h.mcp.resolveApproval(h.owner, groupApproval.id, true)
    const results = output<{ sessionId: string; stdout: string }[]>(await group)
    assert.deepEqual(results.map((result) => result.sessionId), [h.sessionId])
    assert.match(results[0].stdout, /reviewed-group/)
    await h.store.saveProfile({ ...h.profile, host: 'different.invalid', name: 'Different target', group: 'Different group' })
    assert.equal(h.ssh.listSessions(h.owner).find((session) => session.sessionId === h.sessionId)?.host, h.fixture.host)
    assert.notEqual(h.ssh.listSessions(h.owner).find((session) => session.sessionId === h.sessionId)?.group, 'Different group')
  } finally { await h.close() }
})

test('MCP connection-file creation refuses unrelated existing data and active instances, and removes only the file it created', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await writeFile(path.join(h.directory, 'untouched.txt'), 'not an MCP connection')
    const conflicting = new McpService({ store: h.store, ssh: h.ssh, editor: h.editor, metrics: new MetricsService(h.ssh), version: 'test', connectionFile: path.join(h.directory, 'untouched.txt'), bridgePath: path.join(h.directory, 'bridge.cjs'), bridgeCommand: process.execPath, bridgeEnv: {}, notifyState() {} })
    await assert.rejects(conflicting.setEnabled(h.owner, true), /already in use/)
    assert.equal(await readFile(path.join(h.directory, 'untouched.txt'), 'utf8'), 'not an MCP connection')
    await conflicting.dispose()
    await h.mcp.setEnabled(h.owner, true)
    const contender = new McpService({ store: h.store, ssh: h.ssh, editor: h.editor, metrics: new MetricsService(h.ssh), version: 'test', connectionFile: h.connectionFile, bridgePath: path.join(h.directory, 'bridge.cjs'), bridgeCommand: process.execPath, bridgeEnv: {}, notifyState() {} })
    await assert.rejects(contender.setEnabled(h.owner, true), /active MCP connection file/)
    await contender.dispose()
    assert.equal(JSON.parse(await readFile(h.connectionFile, 'utf8')).application, 'ssh-heaven-mcp')
  } finally { await h.close() }
})

test('disabling MCP while a reviewed file is being written cancels before commit and cleans its temporary sibling without disconnecting SSH', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.mcp.setEnabled(h.owner, true)
    const { client } = await h.connect()
    const original = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    const getSftp = h.ssh.getSftp.bind(h.ssh)
    let intercepted = false
    h.ssh.getSftp = async (...args) => {
      const sftp = await getSftp(...args)
      return new Proxy(sftp, {
        get(target, property) {
          if (property === 'write') return (handle: Buffer, bytes: Buffer, offset: number, length: number, position: number, callback: (error?: Error | null) => void) => {
            target.write(handle, bytes, offset, length, position, (error) => {
              if (error || intercepted) { callback(error); return }
              intercepted = true
              void h.mcp.setEnabled(h.owner, false).then(() => callback(), (failure: Error) => callback(failure))
            })
          }
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }
      }) as SFTPWrapper
    }
    const saving = client.callTool({ name: 'write_remote_file', arguments: { sessionId: h.sessionId, path: '/welcome.txt', content: 'x'.repeat(60 * 1024), expectedVersion: original.version } }).catch((error: unknown) => error)
    const approval = await h.approval()
    h.mcp.resolveApproval(h.owner, approval.id, true)
    await saving
    await eventually(() => intercepted && !h.mcp.getState().enabled, 'disable during SFTP write')
    const deadline = Date.now() + 3000
    while ((await readdir(h.fixture.root)).some((name) => name.endsWith('.part'))) {
      assert.ok(Date.now() < deadline, 'temporary sibling was not cleaned after cancellation')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(await readFile(path.join(h.fixture.root, 'welcome.txt'), 'utf8'), original.content)
    assert.match((await h.ssh.execOnSession(h.owner, h.sessionId, 'echo still-connected')).stdout, /still-connected/)
  } finally { await h.close() }
})

test('independent MCP clients cannot cross-cancel approvals; terminating one session removes only its own request', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.mcp.setEnabled(h.owner, true)
    const first = await h.connect()
    const second = await h.connect()
    const one = first.client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo first-client' } }).catch((error: unknown) => error)
    const two = second.client.callTool({ name: 'run_command', arguments: { sessionId: h.sessionId, command: 'echo second-client' } })
    await eventually(() => h.mcp.getState().pendingApprovals.length === 2, 'two independent client approvals')
    await first.transport.terminateSession()
    await first.client.close()
    await one
    await eventually(() => h.mcp.getState().pendingApprovals.length === 1, 'terminated client approval cleanup')
    const remaining = h.mcp.getState().pendingApprovals[0]
    assert.equal(remaining.command, 'echo second-client')
    h.mcp.resolveApproval(h.owner, remaining.id, true)
    assert.match(output<{ stdout: string }>(await two).stdout, /second-client/)
    assert.equal(h.calls.includes('echo first-client'), false)
  } finally { await h.close() }
})

test('remote reads abort promptly while waiting for SFTP setup or a read RPC and close their file handle without closing SSH', { timeout: 15_000 }, async () => {
  const setupController = new AbortController()
  const waiting = new RemoteEditorService(() => new Promise<SFTPWrapper>(() => {}))
  const setup = waiting.read(901, 'waiting-for-sftp', '/welcome.txt', setupController.signal)
  setupController.abort(new Error('Canceled SFTP setup.'))
  await assert.rejects(setup, /Canceled SFTP setup/)
  const h = await harness()
  try {
    const sftp = await h.ssh.getSftp(h.owner, h.sessionId)
    const controller = new AbortController()
    let reads = 0
    let closes = 0
    const slow = new Proxy(sftp, {
      get(target, property) {
        if (property === 'read') return () => { reads++; controller.abort(new Error('Canceled pending READ.')) }
        if (property === 'close') return (...args: Parameters<SFTPWrapper['close']>) => { closes++; return target.close(...args) }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as SFTPWrapper
    const editor = new RemoteEditorService(async () => slow)
    await assert.rejects(editor.read(h.owner, h.sessionId, '/welcome.txt', controller.signal), /Canceled pending READ/)
    await eventually(() => closes === 1, 'canceled READ handle cleanup')
    assert.equal(reads, 1)
    assert.match((await h.ssh.execOnSession(h.owner, h.sessionId, 'echo read-cancel-kept-ssh')).stdout, /read-cancel-kept-ssh/)
  } finally { await h.close() }
})
