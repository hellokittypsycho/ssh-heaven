import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CredentialVault } from '../electron/credentials'
import { GroupCommandManager, MAX_COMMAND_OUTPUT_BYTES } from '../electron/group-commands'
import { SshService } from '../electron/ssh-service'
import { AppStore } from '../electron/store'
import type { GroupCommandEvent, HostProfile, SessionStatus } from '../shared/types'
import { startFixture } from './fixture'

async function harness(count = 1, options: { rejectHost?: boolean; privateKey?: boolean; holdHost?: boolean } = {}) {
  const fixture = await startFixture({ privateKeyAuth: options.privateKey })
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-group-'))
  const key = randomBytes(32)
  const store = new AppStore(path.join(directory, 'settings.json'))
  const vault = new CredentialVault(path.join(directory, 'credentials.json'), {
    available: () => true,
    encrypt(password) {
      const iv = randomBytes(12)
      const encryptor = createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([encryptor.update(password, 'utf8'), encryptor.final()])
      return Buffer.concat([iv, encryptor.getAuthTag(), bytes])
    },
    decrypt(bytes) {
      const decryptor = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decryptor.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decryptor.update(bytes.subarray(28)), decryptor.final()]).toString('utf8')
    }
  })
  await store.load(); await vault.load()
  const profiles: HostProfile[] = []
  for (let index = 0; index < count; index++) {
    const profile: HostProfile = { id: `group_host_${index}`, name: `Host ${index}`, host: fixture.host, port: fixture.port, username: fixture.username, group: 'Fleet', authType: options.privateKey ? 'privateKey' : 'password', ...(options.privateKey ? { privateKeyPath: fixture.privateKeyPath } : {}) }
    await store.saveProfile(profile)
    if (!options.privateKey) await vault.save(profile, fixture.password)
    profiles.push(profile)
  }
  const notifications = new EventEmitter()
  const events: GroupCommandEvent[] = []
  const challenges: string[] = []
  const challengeSessions: string[] = []
  const statuses: SessionStatus[] = []
  let terminal = ''
  const owner = 701
  const ssh = new SshService(store, {
    hostKey(ownerId, challenge) {
      challenges.push(challenge.requestId); challengeSessions.push(challenge.sessionId); notifications.emit('change')
      if (!options.holdHost) queueMicrotask(() => ssh.resolveHostKey(ownerId, challenge.requestId, !options.rejectHost))
    },
    status(_owner, event) { statuses.push(event); notifications.emit('change') },
    data(_owner, event) { terminal += Buffer.from(event.data).toString('utf8'); notifications.emit('change') }
  })
  const manager = new GroupCommandManager(store, vault, ssh, (ownerId, event) => { assert.equal(ownerId, owner); events.push({ ...event }); notifications.emit('change') })
  function until(predicate: () => boolean): Promise<void> {
    if (predicate()) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const changed = () => { if (predicate()) { cleanup(); resolve() } }
      const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for group-command state')) }, 10_000)
      const cleanup = () => { clearTimeout(timer); notifications.off('change', changed) }
      notifications.on('change', changed)
    })
  }
  return {
    fixture, directory, store, vault, profiles, ssh, manager, owner, events, challenges, challengeSessions, statuses, until,
    terminal: () => terminal,
    start(runId: string, command: string, profileIds = profiles.map((profile) => profile.id), extra = {}) { manager.start(owner, { runId, command, group: 'Fleet', profileIds, ...extra }) },
    finished(runId: string) { return events.filter((event) => event.runId === runId && event.finishedAt !== undefined) },
    async close() { await manager.dispose(); ssh.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }) }
  }
}

test('reviewed group commands use saved credentials and normal host-key checks without adding unreviewed targets', { timeout: 15_000 }, async () => {
  const h = await harness(3)
  try {
    h.start('reviewed-run', 'echo reviewed-target-marker', h.profiles.slice(0, 2).map((profile) => profile.id))
    assert.equal(h.events.filter((event) => event.status === 'queued').length, 2, 'The start API should return immediately with queued reviewed targets')
    await h.until(() => h.finished('reviewed-run').length === 2)
    const results = h.finished('reviewed-run')
    assert.ok(results.every((event) => event.status === 'completed' && event.exitCode === 0 && event.output?.includes('reviewed-target-marker')))
    assert.deepEqual(results.map((event) => event.profileId).sort(), h.profiles.slice(0, 2).map((profile) => profile.id).sort())
    assert.ok(h.challenges.length > 0)
    assert.ok(h.store.getFingerprint(h.fixture.host, h.fixture.port))
    assert.equal((await readFile(path.join(h.directory, 'settings.json'), 'utf8')).includes(h.fixture.password), false)
    assert.throws(() => h.start('invalid-target', 'echo no', ['unknown-host']), /review|changed/i)
    await h.store.saveProfile({ ...h.profiles[0], group: 'Moved' })
    assert.throws(() => h.start('moved-target', 'echo no', [h.profiles[0].id]), /review|changed/i)
  } finally { await h.close() }
})

test('group commands limit concurrency to four and cancel queued/running channels without interrupting a terminal session', { timeout: 15_000 }, async () => {
  const h = await harness(7)
  try {
    await h.ssh.connect({ sessionId: 'existing-terminal', profile: h.profiles[0], password: h.fixture.password }, h.owner)
    h.start('cancel-run', 'wait-for-cancel')
    await h.until(() => h.events.filter((event) => event.runId === 'cancel-run' && event.status === 'running').length === 4)
    assert.equal(new Set(h.events.filter((event) => event.status === 'connecting').map((event) => event.profileId)).size, 4)
    assert.throws(() => h.manager.cancel(999, 'cancel-run'), /another window/)
    h.manager.cancel(h.owner, 'cancel-run')
    await h.until(() => h.finished('cancel-run').length === 7)
    assert.ok(h.finished('cancel-run').every((event) => event.status === 'canceled'))
    assert.equal(new Set(h.events.filter((event) => event.status === 'connecting').map((event) => event.profileId)).size, 4, 'Queued hosts must not connect after cancellation')
    h.ssh.write(h.owner, 'existing-terminal', 'echo terminal-survived-group-cancel\r')
    await h.until(() => h.terminal().includes('\r\nterminal-survived-group-cancel\r\n'))
    assert.ok((await h.ssh.listDirectory(h.owner, 'existing-terminal', '/')).entries.length > 0)
  } finally { await h.close() }
})

test('group commands cap cumulative output and report nonzero exits and timeouts as failures', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    h.start('large-run', 'large-output')
    await h.until(() => h.finished('large-run').length === 1)
    const large = h.finished('large-run')[0]
    assert.equal(large.status, 'completed'); assert.equal(large.truncated, true)
    assert.ok(Buffer.byteLength(large.output ?? '') <= MAX_COMMAND_OUTPUT_BYTES)
    assert.ok(h.events.filter((event) => event.runId === 'large-run').every((event) => Buffer.byteLength(event.output ?? '') <= MAX_COMMAND_OUTPUT_BYTES))
    h.start('exit-run', 'exit 7')
    await h.until(() => h.finished('exit-run').length === 1)
    assert.equal(h.finished('exit-run')[0].status, 'failed')
    assert.equal(h.finished('exit-run')[0].exitCode, 7)
    h.start('signal-run', 'signal-terminate')
    await h.until(() => h.finished('signal-run').length === 1)
    assert.equal(h.finished('signal-run')[0].status, 'failed')
    assert.match(h.finished('signal-run')[0].error ?? '', /remote signal (?:SIG)?TERM/)
    h.start('timeout-run', 'wait-for-cancel', undefined, { timeoutSeconds: 1 })
    await h.until(() => h.finished('timeout-run').length === 1)
    assert.equal(h.finished('timeout-run')[0].status, 'failed')
    assert.match(h.finished('timeout-run')[0].error ?? '', /timed out/)
  } finally { await h.close() }
})

test('group commands fail missing credentials and rejected host fingerprints without running remote code', { timeout: 15_000 }, async () => {
  const h = await harness(2, { rejectHost: true })
  try {
    await h.vault.forget(h.profiles[0].id)
    h.start('rejected-run', 'echo must-not-run')
    await h.until(() => h.finished('rejected-run').length === 2)
    assert.ok(h.finished('rejected-run').every((event) => event.status === 'failed'))
    assert.match(h.finished('rejected-run').find((event) => event.profileId === h.profiles[0].id)?.error ?? '', /no saved password/)
    assert.equal(h.events.some((event) => event.status === 'running'), false)
    assert.equal(h.store.getFingerprint(h.fixture.host, h.fixture.port), undefined)
    assert.equal(JSON.stringify(h.events).includes(h.fixture.password), false)
  } finally { await h.close() }
})

test('group commands support a shared encrypted SSH private key without persisting its passphrase', { timeout: 15_000 }, async () => {
  const h = await harness(2, { privateKey: true })
  try {
    h.start('key-run', 'echo shared-key-marker', undefined, { passphrase: h.fixture.passphrase })
    await h.until(() => h.finished('key-run').length === 2)
    assert.ok(h.finished('key-run').every((event) => event.status === 'completed' && event.output?.includes('shared-key-marker')))
    assert.equal((await readFile(path.join(h.directory, 'settings.json'), 'utf8')).includes(h.fixture.passphrase!), false)
  } finally { await h.close() }
})

test('canceling or timing out during group host verification expires the challenge and notifies the shared prompt queue', { timeout: 15_000 }, async () => {
  for (const mode of ['cancel', 'timeout'] as const) {
    const h = await harness(1, { holdHost: true })
    try {
      const runId = `verifying-${mode}`
      h.start(runId, 'echo must-not-run', undefined, { timeoutSeconds: mode === 'timeout' ? 1 : 30 })
      await h.until(() => h.challenges.length === 1)
      if (mode === 'cancel') h.manager.cancel(h.owner, runId)
      await h.until(() => h.finished(runId).length === 1)
      assert.equal(h.finished(runId)[0].status, mode === 'cancel' ? 'canceled' : 'failed')
      assert.ok(h.statuses.some((event) => event.sessionId === h.challengeSessions[0] && event.status === 'disconnected'), 'The global verification dialog must be told to remove its synthetic session')
      assert.throws(() => h.ssh.resolveHostKey(h.owner, h.challenges[0], true), /expired/)
      assert.equal(h.events.some((event) => event.status === 'running'), false)
      assert.equal(h.store.getFingerprint(h.fixture.host, h.fixture.port), undefined)
    } finally { await h.close() }
  }
})
