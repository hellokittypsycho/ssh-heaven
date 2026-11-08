import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { SshService, resolveSshAgent } from '../electron/ssh-service'
import { AppStore } from '../electron/store'
import type { ConnectRequest, HostKeyChallenge, ScriptRun, SessionStatus, TerminalData } from '../shared/types'
import { startFixture, type FixtureOptions } from './fixture'
import { startAgentFixture } from './agent-fixture'

interface Owned<T> { ownerId: number; event: T }

test('SSH agent selection uses the Windows OpenSSH named pipe or an absolute SSH_AUTH_SOCK', () => {
  assert.equal(resolveSshAgent('win32', { SSH_AUTH_SOCK: 'pageant' }), '\\\\.\\pipe\\openssh-ssh-agent')
  assert.equal(resolveSshAgent('linux', { SSH_AUTH_SOCK: '/tmp/test-agent.sock' }), '/tmp/test-agent.sock')
  assert.throws(() => resolveSshAgent('linux', {}), /SSH_AUTH_SOCK/)
  assert.throws(() => resolveSshAgent('linux', { SSH_AUTH_SOCK: 'relative.sock' }), /SSH_AUTH_SOCK/)
})

async function harness(options: FixtureOptions = {}) {
  const fixture = await startFixture(options)
  const settingsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-heaven-service-test-'))
  const settingsFile = path.join(settingsDirectory, 'settings.json')
  const store = new AppStore(settingsFile)
  await store.load()
  const notifications = new EventEmitter()
  const challenges: Owned<HostKeyChallenge>[] = []
  const statuses: Owned<SessionStatus>[] = []
  const terminal: Owned<TerminalData>[] = []
  const scriptRuns: Owned<ScriptRun>[] = []
  const service = new SshService(store, {
    hostKey(ownerId, event) {
      const item = { ownerId, event }
      challenges.push(item)
      notifications.emit('hostKey', item)
    },
    status(ownerId, event) {
      statuses.push({ ownerId, event })
      notifications.emit('status')
    },
    data(ownerId, event) {
      terminal.push({ ownerId, event })
      notifications.emit('data')
    },
    scriptRun(ownerId, event) { scriptRuns.push({ ownerId, event }); notifications.emit('scriptRun') },
  })
  const request = (sessionId: string, password = fixture.password): ConnectRequest => ({
    sessionId,
    profile: {
      id: 'fixture-profile', name: 'Local service fixture',
      host: fixture.host, port: fixture.port, username: fixture.username, authType: 'password',
    },
    password, cols: 100, rows: 30,
  })
  function waitUntil(eventName: string, predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const changed = () => {
        if (predicate()) { cleanup(); resolve() }
      }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${eventName}`)) }, 5_000)
      const cleanup = () => { clearTimeout(timer); notifications.off(eventName, changed) }
      notifications.on(eventName, changed)
    })
  }
  async function challenge(index: number): Promise<Owned<HostKeyChallenge>> {
    await waitUntil('hostKey', () => challenges.length > index)
    return challenges[index]
  }
  async function connectTrusted(ownerId: number, sessionId: string, connectionRequest = request(sessionId)) {
    const index = challenges.length
    const connection = service.connect(connectionRequest, ownerId)
    // Register a rejection handler before waiting for an asynchronous prompt.
    const result = connection.then((value) => ({ value }), (error: Error) => ({ error }))
    const prompt = await challenge(index)
    assert.equal(prompt.ownerId, ownerId)
    service.resolveHostKey(ownerId, prompt.event.requestId, true)
    const completed = await result
    if ('error' in completed) throw completed.error
    return completed.value
  }
  return {
    fixture, store, settingsFile, service, request, challenges, statuses, terminal, scriptRuns,
    challenge, connectTrusted, waitUntil,
    terminalText: (sessionId: string) => terminal.filter((item) => item.event.sessionId === sessionId).map((item) => Buffer.from(item.event.data).toString('utf8')).join(''),
    async close() {
      service.dispose()
      await fixture.close()
      // This path is directly returned by mkdtemp and never accepts remote data.
      await fs.rm(settingsDirectory, { recursive: true, force: true })
    },
  }
}

test('managed script results use the real terminal, strip private frames, report exit codes, and isolate owners', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.connectTrusted(201, 'script-session')
    const first = await h.service.runTerminalScript(201, 'script-session', "printf '%s\\n' 'script-中文-quote\"'\nprintf '\\ttab\\n'\nexit 7\n\n", { scriptId: 'saved-script', name: 'Failure fixture' })
    assert.equal(first.scriptId, 'saved-script')
    await h.waitUntil('scriptRun', () => h.service.listScriptRuns(201).some((run) => run.id === first.id && run.status === 'failed'))
    const failed = h.service.getScriptRun(201, first.id)
    assert.equal(failed.exitCode, 7); assert.equal(failed.name, 'Failure fixture')
    assert.ok(failed.durationMs! >= 0); assert.ok(failed.finishedAt! >= failed.startedAt)
    await h.waitUntil('data', () => h.terminalText('script-session').includes('script-中文-quote"'))
    assert.equal(h.terminalText('script-session').includes('\x1b]777;ssh-heaven;'), false)
    assert.deepEqual(h.service.listScriptRuns(999), [])
    assert.throws(() => h.service.getScriptRun(999, first.id), /not available/)
    assert.ok(h.scriptRuns.every((event) => event.ownerId === 201))
    await h.waitUntil('data', () => h.terminalText('script-session').endsWith(`${h.fixture.username}@ssh-heaven:/$ `))
    const second = await h.service.runTerminalScript(201, 'script-session', "printf 'completed-real\\n'\n", { name: 'Success fixture' })
    await h.waitUntil('scriptRun', () => h.service.getScriptRun(201, second.id).status === 'completed')
    assert.equal(h.service.getScriptRun(201, second.id).exitCode, 0)
    assert.equal(h.service.listSessions(201).length, 1)
    await h.waitUntil('data', () => h.terminalText('script-session').endsWith(`${h.fixture.username}@ssh-heaven:/$ `))
    h.service.write(201, 'script-session', 'echo terminal-still-connected\r')
    await h.waitUntil('data', () => h.terminalText('script-session').includes('terminal-still-connected'))
  } finally { await h.close() }
})

test('a pending terminal script blocks another managed run and becomes disconnected when its SSH session closes', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.connectTrusted(202, 'script-disconnect')
    const run = await h.service.runTerminalScript(202, 'script-disconnect', "printf 'waiting-for-terminal-input\\n'\nread response\nprintf '%s' \"$response\"\n")
    await h.waitUntil('data', () => h.terminalText('script-disconnect').includes('waiting-for-terminal-input'))
    await assert.rejects(h.service.runTerminalScript(202, 'script-disconnect', 'echo no-duplicate'), /already running/)
    h.service.disconnect(202, 'script-disconnect')
    assert.equal(h.service.getScriptRun(202, run.id).status, 'disconnected')
    assert.equal(h.service.getScriptRun(202, run.id).exitCode, undefined)
    assert.ok(h.service.getScriptRun(202, run.id).durationMs! >= 0)
  } finally { await h.close() }
})

test('SFTP properties and handle-bound chmod validate versions, owners, special bits, and symbolic links', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.connectTrusted(203, 'property-session')
    const initial = await h.service.getRemoteProperties(203, 'property-session', '/welcome.txt')
    assert.equal(initial.type, 'file'); assert.ok(initial.size > 0)
    assert.equal(typeof initial.uid, 'number'); assert.equal(typeof initial.gid, 'number')
    assert.match(initial.version, /^[a-f0-9]{64}$/)
    await assert.rejects(h.service.getRemoteProperties(999, 'property-session', '/welcome.txt'), /another window/)
    for (const invalid of [-1, 0o1000, 0o4755, 2.5, '755']) await assert.rejects(h.service.chmodRemote(203, 'property-session', '/welcome.txt', invalid, initial.version), /permissions/)
    await assert.rejects(h.service.chmodRemote(203, 'property-session', '/welcome.txt', 0o640, '0'.repeat(64)), /changed/)
    const changed = await h.service.chmodRemote(203, 'property-session', '/welcome.txt', 0o640, initial.version)
    assert.equal(changed.mode & 0o777, 0o640)
    const directory = await h.service.getRemoteProperties(203, 'property-session', '/documents')
    assert.equal((await h.service.chmodRemote(203, 'property-session', '/documents', 0o750, directory.version)).mode & 0o777, 0o750)
    const link = path.join(h.fixture.root, 'directory-link')
    await fs.symlink(path.join(h.fixture.root, 'documents'), link, process.platform === 'win32' ? 'junction' : 'dir')
    const symbolic = await h.service.getRemoteProperties(203, 'property-session', '/directory-link')
    assert.equal(symbolic.type, 'symlink')
    await assert.rejects(h.service.chmodRemote(203, 'property-session', '/directory-link', 0o777, symbolic.version), /Symbolic links/)
    const listing = await h.service.listDirectory(203, 'property-session', '/')
    assert.equal(listing.entries.find((entry) => entry.name === 'directory-link')?.type, 'symlink')
    const before = await h.service.getRemoteProperties(203, 'property-session', '/welcome.txt')
    await fs.appendFile(path.join(h.fixture.root, 'welcome.txt'), 'changed\n')
    await assert.rejects(h.service.chmodRemote(203, 'property-session', '/welcome.txt', 0o600, before.version), /changed/)
  } finally { await h.close() }
})

test('SSH-agent auth signs a real connection, reconnect, and exec without reading a private key in SshService', { timeout: 15_000 }, async () => {
  const fixture = await startFixture({ privateKeyAuth: true })
  const agent = await startAgentFixture(fixture.privateKeyPath!, fixture.passphrase!)
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-heaven-agent-service-'))
  const store = new AppStore(path.join(temporary, 'settings.json')); await store.load()
  let service!: SshService
  service = new SshService(store, { data() {}, status() {}, hostKey(owner, event) { service.resolveHostKey(owner, event.requestId, true) } }, undefined, { agentPath: () => agent.path })
  const profile = { id: 'agent-profile', name: 'Agent fixture', host: fixture.host, port: fixture.port, username: fixture.username, authType: 'agent' as const }
  try {
    await service.connect({ sessionId: 'agent-session', profile, password: 'unused', passphrase: 'unused' }, 204)
    assert.ok(agent.signatures >= 1); assert.ok(agent.identities >= 1)
    service.disconnect(204, 'agent-session')
    await service.connect({ sessionId: 'agent-reconnect', profile }, 204)
    const output: string[] = []
    const result = await service.execute(204, { sessionId: 'agent-exec', profile, command: 'echo agent-exec' }, new AbortController().signal, { phase() {}, data(data) { output.push(Buffer.from(data).toString()) } })
    assert.equal(result.exitCode, 0); assert.equal(output.join(''), 'agent-exec\n')
    assert.ok(agent.signatures >= 3)
    assert.equal(store.listProfiles().some((item) => item.privateKeyPath), false)
  } finally { service.dispose(); await agent.close(); await fixture.close(); await fs.rm(temporary, { recursive: true, force: true }) }
})

test('service rejects unknown host keys without saving trust and expires the challenge', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const rejected = assert.rejects(h.service.connect(h.request('rejected-host'), 101), /verification|host|closed/i)
    const { ownerId, event } = await h.challenge(0)
    assert.equal(ownerId, 101)
    assert.equal(event.sessionId, 'rejected-host')
    assert.equal(event.previousFingerprint, undefined)
    assert.match(event.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/)
    assert.throws(() => h.service.resolveHostKey(999, event.requestId, true), /expired/)
    h.service.resolveHostKey(101, event.requestId, false)
    await rejected
    assert.equal(h.store.getFingerprint(h.fixture.host, h.fixture.port), undefined)
    assert.throws(() => h.service.resolveHostKey(101, event.requestId, true), /expired/)
    assert.throws(() => h.service.write(101, 'rejected-host', 'echo forbidden\r'), /no longer connected/)
    const reloaded = new AppStore(h.settingsFile)
    await reloaded.load()
    assert.equal(reloaded.getFingerprint(h.fixture.host, h.fixture.port), undefined)
    assert.ok(h.statuses.some((item) => item.event.sessionId === 'rejected-host' && item.event.status === 'error'))
  } finally { await h.close() }
})

test('service remembers approved host fingerprints across store reloads and reconnects', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const info = await h.connectTrusted(102, 'trusted-host')
    assert.deepEqual(info, { sessionId: 'trusted-host', host: h.fixture.host, username: h.fixture.username })
    const approved = h.challenges[0].event.fingerprint
    assert.equal(h.store.getFingerprint(h.fixture.host, h.fixture.port), approved)
    h.service.disconnect(102, 'trusted-host')
    const reloaded = new AppStore(h.settingsFile)
    await reloaded.load()
    assert.equal(reloaded.getFingerprint(h.fixture.host, h.fixture.port), approved)
    const secondService = new SshService(reloaded, {
      data() {}, status() {},
      hostKey() { assert.fail('A remembered fingerprint must not prompt again') },
    })
    try {
      await secondService.connect(h.request('trusted-again'), 102)
      assert.equal(h.challenges.length, 1)
    } finally { secondService.dispose() }
    const saved = await fs.readFile(h.settingsFile, 'utf8')
    assert.equal(saved.includes(h.fixture.password), false, 'Passwords must not reach settings storage')
  } finally { await h.close() }
})

test('service asks again for changed host keys and preserves the old key when rejected', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const oldFingerprint = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    await h.store.trustFingerprint(h.fixture.host, h.fixture.port, oldFingerprint)
    const rejected = assert.rejects(h.service.connect(h.request('changed-rejected'), 103), /verification|host|closed/i)
    const first = await h.challenge(0)
    assert.equal(first.event.previousFingerprint, oldFingerprint)
    assert.notEqual(first.event.fingerprint, oldFingerprint)
    h.service.resolveHostKey(103, first.event.requestId, false)
    await rejected
    assert.equal(h.store.getFingerprint(h.fixture.host, h.fixture.port), oldFingerprint)
    await h.connectTrusted(103, 'changed-accepted')
    assert.equal(h.challenges[1].event.previousFingerprint, oldFingerprint)
    assert.equal(h.store.getFingerprint(h.fixture.host, h.fixture.port), h.challenges[1].event.fingerprint)
  } finally { await h.close() }
})

test('service isolates owners and carries terminal bytes and SFTP mutations end to end', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.connectTrusted(104, 'workspace-session')
    const id = 'workspace-session'
    assert.throws(() => h.service.write(999, id, 'echo unauthorized\r'), /another window/)
    assert.throws(() => h.service.resize(999, id, 120, 40), /another window/)
    assert.throws(() => h.service.disconnect(999, id), /another window/)
    await assert.rejects(h.service.listDirectory(999, id, '.'), /another window/)
    await assert.rejects(h.service.mkdir(999, id, '/unauthorized'), /another window/)
    h.service.disconnectOwner(999)
    h.service.resize(104, id, 120, 40)
    h.service.write(104, id, 'echo service-terminal-marker\r')
    await h.waitUntil('data', () => h.terminalText(id).includes('\r\nservice-terminal-marker\r\n'))
    assert.ok(h.terminal.length > 0)
    assert.ok(h.terminal.every((item) => item.ownerId === 104 && item.event.data instanceof Uint8Array))

    const initial = await h.service.listDirectory(104, id, '.')
    assert.equal(initial.path, '/')
    assert.equal(initial.entries[0].type, 'directory', 'Directories appear before files')
    assert.ok(initial.entries.some((entry) => entry.name === 'welcome.txt' && entry.type === 'file' && entry.path === '/welcome.txt'))
    await h.service.mkdir(104, id, '/service-created')
    await h.service.rename(104, id, '/service-created', '/service-renamed')
    assert.ok((await h.service.listDirectory(104, id, '/')).entries.some((entry) => entry.name === 'service-renamed' && entry.type === 'directory'))
    await h.service.remove(104, id, '/service-renamed', 'directory')
    await h.service.rename(104, id, '/welcome.txt', '/renamed.txt')
    await h.service.remove(104, id, '/renamed.txt', 'file')
    const remaining = await h.service.listDirectory(104, id, '/')
    assert.deepEqual(remaining.entries.map((entry) => entry.name), ['documents'])
    await assert.rejects(h.service.remove(104, id, '/', 'directory'), /Select a file or subdirectory/)
    h.service.disconnectOwner(104)
    assert.throws(() => h.service.write(104, id, 'echo after-disconnect\r'), /no longer connected/)
    await assert.rejects(h.service.listDirectory(104, id, '/'), /no longer connected/)
    assert.deepEqual(h.statuses.filter((item) => item.event.sessionId === id).map((item) => item.event.status), ['connecting', 'connected', 'disconnected'])
    assert.ok(h.statuses.every((item) => item.ownerId === 104))
  } finally { await h.close() }
})

test('service cleans up canceled verification and authentication failures so session IDs can be reused', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const canceled = assert.rejects(h.service.connect(h.request('reusable-session'), 105), /closed/)
    const pending = await h.challenge(0)
    h.service.disconnect(105, 'reusable-session')
    await canceled
    assert.throws(() => h.service.resolveHostKey(105, pending.event.requestId, true), /expired/)
    const wrongPassword = assert.rejects(h.service.connect(h.request('reusable-session', 'incorrect-password'), 105), /authentication/i)
    const retry = await h.challenge(1)
    h.service.resolveHostKey(105, retry.event.requestId, true)
    await wrongPassword
    assert.throws(() => h.service.write(105, 'reusable-session', 'echo failed\r'), /no longer connected/)
    assert.ok(h.statuses.some((item) => item.event.sessionId === 'reusable-session' && item.event.status === 'error'))
    await h.service.connect(h.request('reusable-session'), 105)
    assert.equal(h.challenges.length, 2, 'Authentication failure does not discard an explicitly trusted host key')
    h.service.disconnect(105, 'reusable-session')
    h.service.disconnect(105, 'reusable-session')
  } finally { await h.close() }
})

test('service authenticates with an encrypted private key and rejects invalid key credentials', { timeout: 15_000 }, async () => {
  const h = await harness({ privateKeyAuth: true })
  try {
    assert.ok(h.fixture.privateKeyPath)
    assert.ok(h.fixture.passphrase)
    const keyRequest: ConnectRequest = {
      ...h.request('encrypted-key-session'),
      profile: { ...h.request('encrypted-key-session').profile, authType: 'privateKey', privateKeyPath: h.fixture.privateKeyPath },
      password: undefined,
      passphrase: h.fixture.passphrase,
    }
    await h.connectTrusted(106, keyRequest.sessionId, keyRequest)
    h.service.write(106, keyRequest.sessionId, 'echo encrypted-key-authenticated\r')
    await h.waitUntil('data', () => h.terminalText(keyRequest.sessionId).includes('\r\nencrypted-key-authenticated\r\n'))
    await h.store.saveProfile(keyRequest.profile)
    const saved = await fs.readFile(h.settingsFile, 'utf8')
    assert.equal(saved.includes(h.fixture.passphrase), false, 'Key passphrases must not be persisted')
    assert.equal(saved.includes('BEGIN RSA PRIVATE KEY'), false, 'Private key material must not be persisted')
    assert.deepEqual((await h.service.listDirectory(106, keyRequest.sessionId, '/')).entries.map((entry) => entry.name), ['documents', 'welcome.txt'])
    h.service.disconnect(106, keyRequest.sessionId)

    await assert.rejects(h.service.connect({ ...keyRequest, passphrase: 'wrong-key-passphrase' }, 106), /private.?key|passphrase|parse|decrypt/i)
    assert.throws(() => h.service.write(106, keyRequest.sessionId, 'echo invalid\r'), /no longer connected/)
    await assert.rejects(h.service.connect({ ...keyRequest, profile: { ...keyRequest.profile, privateKeyPath: path.join(h.fixture.root, 'missing-private-key') } }, 106), /ENOENT/)
    await assert.rejects(h.service.connect({ ...keyRequest, profile: { ...keyRequest.profile, privateKeyPath: undefined } }, 106), /Choose a private key file/)
    await h.service.connect(keyRequest, 106)
    assert.equal(h.challenges.length, 1, 'A key parsing failure must not remove remembered host trust')
    h.service.disconnect(106, keyRequest.sessionId)
  } finally { await h.close() }
})
