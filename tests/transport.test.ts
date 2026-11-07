import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MetricsService } from '../electron/metrics'
import { SshService } from '../electron/ssh-service'
import { AppStore } from '../electron/store'
import { TunnelManager } from '../electron/tunnels'
import type { HostKeyChallenge, HostProfile, SessionStatus, TunnelInfo } from '../shared/types'
import { startFixture } from './fixture'
import { startTransportFixture, type TransportFixtureOptions } from './transport-fixture'

const owner = 801
const profileFor = (fixture: { host: string; port: number; username: string }, id: string): HostProfile => ({ id, name: id, host: fixture.host, port: fixture.port, username: fixture.username, authType: 'password' })

function waitFor(events: EventEmitter, predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const changed = () => { if (predicate()) { cleanup(); resolve() } }
    const timer = setTimeout(() => { cleanup(); reject(new Error('Transport fixture condition timed out')) }, 5000)
    const cleanup = () => { clearTimeout(timer); events.off('change', changed) }
    events.on('change', changed)
  })
}

async function harness(options: TransportFixtureOptions = {}) {
  const fixture = await startTransportFixture(options)
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-transport-'))
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const profile = profileFor(fixture, 'transport-host')
  await store.saveProfile(profile)
  const notifications = new EventEmitter()
  const challenges: HostKeyChallenge[] = []
  const statuses: SessionStatus[] = []
  let output = ''
  let hold = false
  const ssh = new SshService(store, {
    hostKey(ownerId, challenge) { challenges.push(challenge); notifications.emit('change'); if (!hold) queueMicrotask(() => ssh.resolveHostKey(ownerId, challenge.requestId, true)) },
    status(_owner, event) { statuses.push(event); notifications.emit('change') },
    data(_owner, event) { output += Buffer.from(event.data).toString('utf8'); notifications.emit('change') }
  }, async (saved) => ({ password: saved.id === profile.id ? fixture.password : undefined }))
  return {
    fixture, directory, store, profile, ssh, notifications, challenges, statuses,
    holdChallenges(value: boolean) { hold = value },
    connect: (sessionId = 'transport-session', value: HostProfile = profile) => ssh.connect({ sessionId, profile: value, password: fixture.password }, owner),
    until: (predicate: () => boolean) => waitFor(notifications, predicate), output: () => output,
    async close() { ssh.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }) }
  }
}

test('jump routes authenticate and verify every hop for shells, SFTP, and separate command channels', { timeout: 20_000 }, async () => {
  const outer = await startTransportFixture({ username: 'outer-user', password: 'outer-password', forwarding: true })
  const inner = await startTransportFixture({ username: 'inner-user', password: 'inner-password', forwarding: true })
  const destination = await startFixture()
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-route-'))
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const outerProfile = profileFor(outer, 'outer-hop')
  const innerProfile = { ...profileFor(inner, 'inner-hop'), jumpHostId: outerProfile.id }
  const target = { ...profileFor(destination, 'route-target'), jumpHostId: innerProfile.id }
  await store.saveProfile(outerProfile); await store.saveProfile(innerProfile); await store.saveProfile(target)
  const prompts: number[] = []
  let terminal = ''
  const notifications = new EventEmitter()
  const ssh = new SshService(store, {
    hostKey(ownerId, challenge) { prompts.push(challenge.port); queueMicrotask(() => ssh.resolveHostKey(ownerId, challenge.requestId, true)) }, status() {},
    data(_owner, event) { terminal += Buffer.from(event.data).toString('utf8'); notifications.emit('change') }
  }, async (profile) => ({ password: profile.id === outerProfile.id ? outer.password : profile.id === innerProfile.id ? inner.password : undefined }))
  try {
    await ssh.connect({ sessionId: 'routed-shell', profile: target, password: destination.password }, owner)
    assert.deepEqual(prompts, [outer.port, inner.port, destination.port])
    assert.ok(outer.forwarded.some((request) => request.port === inner.port))
    assert.ok(inner.forwarded.some((request) => request.port === destination.port))
    assert.ok((await ssh.listDirectory(owner, 'routed-shell', '/')).entries.some((entry) => entry.name === 'welcome.txt'))
    let commandOutput = ''
    const result = await ssh.execute(owner, { sessionId: 'routed-exec', profile: target, password: destination.password, command: 'echo routed-exec-marker' }, new AbortController().signal, { phase() {}, data(data) { commandOutput += Buffer.from(data).toString('utf8') } })
    assert.equal(result.exitCode, 0); assert.ok(commandOutput.includes('routed-exec-marker'))
    assert.equal(prompts.length, 3, 'Persisted fingerprints should be reused independently on the second routed connection')
    ssh.write(owner, 'routed-shell', 'echo routed-terminal-survives\r')
    await waitFor(notifications, () => terminal.includes('\r\nrouted-terminal-survives\r\n'))
  } finally { ssh.dispose(); await outer.close(); await inner.close(); await destination.close(); await rm(directory, { recursive: true, force: true }) }
})

test('jump routes reject cycles, excessive chains, missing credentials, and rejected hop fingerprints', { timeout: 15_000 }, async () => {
  const hop = await startTransportFixture({ forwarding: true })
  const targetFixture = await startTransportFixture()
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-route-errors-'))
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const first = { ...profileFor(hop, 'first-hop'), jumpHostId: 'second-hop' }
  const second = { ...profileFor(hop, 'second-hop'), jumpHostId: 'first-hop' }
  await store.saveProfile(first); await store.saveProfile(second)
  const target = { ...profileFor(targetFixture, 'target'), jumpHostId: first.id }
  let rejectTrust = false
  let noPassword = false
  const ssh = new SshService(store, {
    hostKey(ownerId, challenge) { queueMicrotask(() => ssh.resolveHostKey(ownerId, challenge.requestId, !rejectTrust)) }, data() {}, status() {}
  }, async () => ({ password: noPassword ? undefined : hop.password }))
  try {
    await assert.rejects(ssh.connect({ sessionId: 'cycle-route', profile: target, password: targetFixture.password }, owner), /cycle/)
    assert.equal(hop.authentications, 0)
    for (let index = 0; index < 5; index++) await store.saveProfile({ ...profileFor(hop, `chain-${index}`), ...(index < 4 ? { jumpHostId: `chain-${index + 1}` } : {}) })
    await assert.rejects(ssh.connect({ sessionId: 'long-route', profile: { ...target, jumpHostId: 'chain-0' }, password: targetFixture.password }, owner), /four jump/)
    await store.saveProfile({ ...first, jumpHostId: undefined })
    noPassword = true
    await assert.rejects(ssh.connect({ sessionId: 'missing-jump-secret', profile: target, password: targetFixture.password }, owner), /no saved password/)
    noPassword = false; rejectTrust = true
    await assert.rejects(ssh.connect({ sessionId: 'rejected-jump', profile: target, password: targetFixture.password }, owner), /verification|Jump host|disconnected/i)
    assert.equal(targetFixture.authentications, 0)
  } finally { ssh.dispose(); await hop.close(); await targetFixture.close(); await rm(directory, { recursive: true, force: true }) }
})

test('tmux is opt-in, validates names, and reports unavailable tmux without breaking ordinary shells', { timeout: 15_000 }, async () => {
  const available = await harness({ tmux: true })
  const unavailable = await harness({ tmux: false })
  try {
    await available.connect('ordinary-shell')
    assert.equal(available.fixture.commands.length, 0)
    await available.connect('persistent-shell', { ...available.profile, tmuxSession: 'work_session-1' })
    assert.ok(available.fixture.commands.includes('tmux new-session -A -s work_session-1'))
    available.ssh.resize(owner, 'persistent-shell', 120, 40)
    available.ssh.write(owner, 'persistent-shell', 'echo tmux-terminal-marker\r')
    await available.until(() => available.output().includes('\r\ntmux-terminal-marker\r\n'))
    const before = available.fixture.authentications
    await assert.rejects(available.connect('unsafe-tmux', { ...available.profile, tmuxSession: 'bad; run-other-command' }), /tmux session/)
    assert.equal(available.fixture.authentications, before)
    await assert.rejects(unavailable.connect('missing-tmux', { ...unavailable.profile, tmuxSession: 'work' }), /tmux is not installed/)
    await unavailable.connect('fallback-shell')
    assert.ok(unavailable.ssh.getClient(owner, 'fallback-shell'))
  } finally { await available.close(); await unavailable.close() }
})

test('canceling private-key preparation prevents a late connection and leaves the session identifier reusable', { timeout: 15_000 }, async () => {
  const fixture = await startFixture({ privateKeyAuth: true })
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-preparing-cancel-'))
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const profile: HostProfile = { ...profileFor(fixture, 'key-host'), authType: 'privateKey', privateKeyPath: fixture.privateKeyPath }
  const prompts: string[] = []
  const ssh = new SshService(store, { data() {}, status() {}, hostKey(ownerId, challenge) { prompts.push(challenge.requestId); queueMicrotask(() => ssh.resolveHostKey(ownerId, challenge.requestId, true)) } })
  try {
    const request = { sessionId: 'preparing-key', profile, passphrase: fixture.passphrase }
    const connecting = ssh.connect(request, owner)
    assert.throws(() => ssh.disconnect(999, request.sessionId), /another window/)
    ssh.disconnect(owner, request.sessionId)
    await assert.rejects(connecting, /canceled/)
    assert.equal(prompts.length, 0, 'No SSH handshake should begin after cancellation during the key read')
    await ssh.connect(request, owner)
    assert.equal(prompts.length, 1)
    assert.ok(ssh.getClient(owner, request.sessionId))
  } finally { ssh.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }) }
})

test('losing a jump connection closes its routed session and attached listeners, then permits a clean reconnect', { timeout: 15_000 }, async () => {
  const hop = await startTransportFixture({ forwarding: true })
  const target = await startTransportFixture()
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-route-close-'))
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const jump = profileFor(hop, 'jump')
  const destination = { ...profileFor(target, 'destination'), jumpHostId: jump.id }
  await store.saveProfile(jump); await store.saveProfile(destination)
  const notifications = new EventEmitter()
  const statuses: SessionStatus[] = []
  const prompts: number[] = []
  const ssh = new SshService(store, {
    data() {}, status(_owner, event) { statuses.push(event); notifications.emit('change') },
    hostKey(ownerId, challenge) { prompts.push(challenge.port); queueMicrotask(() => ssh.resolveHostKey(ownerId, challenge.requestId, true)) }
  }, async () => ({ password: hop.password }))
  const tunnels = new TunnelManager(ssh, () => notifications.emit('change'))
  try {
    const request = { sessionId: 'routed-listener', profile: destination, password: target.password }
    await ssh.connect(request, owner)
    const forward = await tunnels.start(owner, request.sessionId, { id: 'route-listener', name: 'Routed listener', direction: 'local', bindPort: 0, targetHost: target.host, targetPort: target.port })
    hop.disconnectClients()
    await waitFor(notifications, () => statuses.some((event) => event.sessionId === request.sessionId && (event.status === 'error' || event.status === 'disconnected')) && tunnels.list(owner).every((info) => info.status === 'closed'))
    await assert.rejects(exchange(forward.boundPort, 'closed'), /ECONNREFUSED|ECONNRESET|closed|timed out/)
    assert.throws(() => ssh.getClient(owner, request.sessionId), /no longer connected/)
    await ssh.connect(request, owner)
    assert.equal(prompts.length, 2, 'Reconnecting should reuse the individually trusted hop and destination keys')
    assert.ok(ssh.getClient(owner, request.sessionId))
  } finally { await tunnels.dispose(); ssh.dispose(); await hop.close(); await target.close(); await rm(directory, { recursive: true, force: true }) }
})

test('metrics use a bounded command on the existing SSH session and preserve terminal availability', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.connect()
    const metrics = new MetricsService(h.ssh)
    const [sample, duplicate] = await Promise.all([metrics.getServerMetrics(owner, 'transport-session'), metrics.getServerMetrics(owner, 'transport-session')])
    assert.deepEqual(sample, duplicate)
    assert.equal(h.fixture.authentications, 1)
    assert.equal(h.fixture.commands.filter((command) => command.includes('SSH_HEAVEN_METRICS_V1')).length, 1)
    assert.equal(sample.cpuPercent, 50); assert.equal(sample.os, 'Fixture Linux'); assert.equal(sample.uptimeSeconds, 12345.5)
    assert.equal(sample.memoryTotalBytes, 8192 * 1024); assert.equal(sample.memoryUsedBytes, 6144 * 1024)
    assert.equal(sample.diskTotalBytes, 100000 * 1024); assert.equal(sample.diskUsedBytes, 25000 * 1024)
    await assert.rejects(h.ssh.execOnSession(owner, 'transport-session', 'wait-for-cancel', { timeoutMs: 30, maxBytes: 1024 }), /timed out/)
    await assert.rejects(async () => metrics.getServerMetrics(999, 'transport-session'), /another window/)
    h.ssh.write(owner, 'transport-session', 'echo metrics-shell-available\r')
    await h.until(() => h.output().includes('\r\nmetrics-shell-available\r\n'))
  } finally { await h.close() }
})

test('unsupported and excessive metrics output fail clearly without disconnecting SSH', { timeout: 15_000 }, async () => {
  for (const mode of ['unsupported', 'large'] as const) {
    const h = await harness({ metrics: mode })
    try {
      await h.connect()
      await assert.rejects(new MetricsService(h.ssh).getServerMetrics(owner, 'transport-session'), mode === 'unsupported' ? /require Linux/ : /output size/)
      h.ssh.write(owner, 'transport-session', `echo ${mode}-metrics-terminal\r`)
      await h.until(() => h.output().includes(`\r\n${mode}-metrics-terminal\r\n`))
    } finally { await h.close() }
  }
})

function exchange(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let output = ''
    socket.setTimeout(3000, () => socket.destroy(new Error('TCP exchange timed out')))
    socket.once('error', reject)
    socket.once('connect', () => socket.write(text))
    socket.on('data', (data) => { output += data.toString('utf8'); if (output.length >= text.length) { socket.destroy(); resolve(output) } })
  })
}

test('local and remote forwarding carry real TCP bytes, stay loopback-only, and close with their session', { timeout: 20_000 }, async () => {
  const h = await harness({ forwarding: true })
  const sockets = new Set<Socket>()
  const echo = createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.pipe(socket) })
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
  const address = echo.address()
  if (!address || typeof address === 'string') throw new Error('Echo server failed')
  const events: TunnelInfo[] = []
  const changed = new EventEmitter()
  const tunnels = new TunnelManager(h.ssh, (ownerId, info) => { assert.equal(ownerId, owner); events.push(info); changed.emit('change') })
  try {
    await h.connect()
    const local = await tunnels.start(owner, 'transport-session', { id: 'local-rule', name: 'Local echo', direction: 'local', bindPort: 0, targetHost: '127.0.0.1', targetPort: address.port })
    const remote = await tunnels.start(owner, 'transport-session', { id: 'remote-rule', name: 'Remote echo', direction: 'remote', bindPort: 0, targetHost: '127.0.0.1', targetPort: address.port })
    assert.equal(await exchange(local.boundPort, 'local-forward-marker'), 'local-forward-marker')
    assert.equal(await exchange(remote.boundPort, 'remote-forward-marker'), 'remote-forward-marker')
    await assert.rejects(tunnels.start(owner, 'transport-session', { id: 'duplicate-remote', name: 'Conflicting port', direction: 'remote', bindPort: remote.boundPort, targetHost: '127.0.0.1', targetPort: address.port }))
    assert.equal(await exchange(remote.boundPort, 'original-remote-survives-duplicate'), 'original-remote-survives-duplicate', 'A failed bind must never cancel another rule that owns the requested port')
    await tunnels.stop(owner, 'duplicate-remote')
    assert.ok(h.fixture.forwarded.every((request) => request.host === '127.0.0.1'))
    assert.equal(tunnels.list(owner).filter((info) => info.status === 'active').length, 2)
    assert.deepEqual(tunnels.list(999), [])
    await assert.rejects(tunnels.stop(999, local.id), /another window/)
    await tunnels.stop(owner, local.id)
    await assert.rejects(exchange(local.boundPort, 'closed'), /ECONNREFUSED|ECONNRESET|closed|timed out/)
    assert.equal(await exchange(remote.boundPort, 'remote-still-works'), 'remote-still-works')
    await tunnels.stop(owner, remote.id)
    await assert.rejects(exchange(remote.boundPort, 'closed'), /ECONNREFUSED|ECONNRESET|closed|timed out/)
    const restarted = await tunnels.start(owner, 'transport-session', { id: 'remote-rule', name: 'Remote echo', direction: 'remote', bindPort: 0, targetHost: '127.0.0.1', targetPort: address.port })
    assert.equal(await exchange(restarted.boundPort, 'restarted-remote-forward'), 'restarted-remote-forward')
    h.ssh.disconnect(owner, 'transport-session')
    await waitFor(changed, () => tunnels.list(owner).every((info) => info.status === 'closed'))
    await assert.rejects(exchange(restarted.boundPort, 'closed'), /ECONNREFUSED|ECONNRESET|closed|timed out/)
  } finally {
    await tunnels.dispose(); await h.close()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => echo.close(() => resolve()))
  }
})

test('a refused remote unforward remains an error until SSH disconnect confirms teardown', { timeout: 15_000 }, async () => {
  const h = await harness({ forwarding: true, denyCancelForward: true })
  const notifications = new EventEmitter()
  const tunnels = new TunnelManager(h.ssh, () => notifications.emit('change'))
  try {
    await h.connect()
    const remote = await tunnels.start(owner, 'transport-session', { id: 'refused-stop', name: 'Refused listener', direction: 'remote', bindPort: 0, targetHost: '127.0.0.1', targetPort: 12345 })
    await assert.rejects(tunnels.stop(owner, remote.id), /refused to close/)
    const state = tunnels.list(owner).find((entry) => entry.id === remote.id)
    assert.equal(state?.status, 'error')
    assert.match(state?.error ?? '', /Disconnect this SSH session/)
    assert.ok(h.ssh.getClient(owner, 'transport-session'), 'Stopping a rule must not silently disconnect the terminal')
    h.ssh.disconnect(owner, 'transport-session')
    await waitFor(notifications, () => tunnels.list(owner).every((entry) => entry.status === 'closed'))
  } finally { await tunnels.dispose(); await h.close() }
})
