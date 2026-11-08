import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { SFTPWrapper } from 'ssh2'
import { SshService } from '../electron/ssh-service'
import { AppStore } from '../electron/store'
import { ScriptCompletionParser } from '../electron/terminal-script'
import type { ScriptRun } from '../shared/types'
import { startFixture } from './fixture'

async function harness() {
  const fixture = await startFixture()
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-backend-lifecycle-'))
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const changes = new EventEmitter(), runs = new Map<string, ScriptRun>()
  let output = ''
  const owner = 307, sessionId = 'lifecycle-session'
  const service = new SshService(store, {
    hostKey(id, challenge) { queueMicrotask(() => service.resolveHostKey(id, challenge.requestId, true)) },
    status() {}, data(_owner, event) { output += Buffer.from(event.data).toString('utf8'); changes.emit('change') },
    scriptRun(_owner, run) { runs.set(run.id, run); changes.emit('change') }
  })
  const connect = () => service.connect({ sessionId, profile: { id: 'lifecycle-host', name: 'Lifecycle fixture', host: fixture.host, port: fixture.port, username: fixture.username, authType: 'password' }, password: fixture.password }, owner)
  await connect()
  async function until(predicate: () => boolean) {
    if (predicate()) return
    await new Promise<void>((resolve, reject) => {
      const changed = () => { if (predicate()) { clearTimeout(timer); changes.off('change', changed); resolve() } }
      const timer = setTimeout(() => { changes.off('change', changed); reject(new Error('Timed out waiting for the loopback lifecycle fixture.')) }, 5000)
      changes.on('change', changed)
    })
  }
  return { fixture, service, owner, sessionId, connect, runs, until, output: () => output,
    async close() { service.dispose(); await fixture.close(); assert.equal(path.dirname(directory), path.resolve(tmpdir())); await rm(directory, { recursive: true, force: true }) }
  }
}

test('closing only an SFTP channel permits a fresh channel on the same live SSH connection', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const client = h.service.getClient(h.owner, h.sessionId)
    const first = await h.service.getSftp(h.owner, h.sessionId)
    const closed = once(first, 'close')
    const timeout = setTimeout(() => h.service.disconnect(h.owner, h.sessionId), 3000)
    h.fixture.closeSftpChannels(); await closed
    clearTimeout(timeout)
    const second = await h.service.getSftp(h.owner, h.sessionId)
    assert.equal(first === second, false, 'A closed SFTP wrapper must not remain cached')
    assert.equal(h.service.getClient(h.owner, h.sessionId) === client, true, 'Reopening SFTP must keep the existing SSH terminal connection')
    assert.ok((await h.service.listDirectory(h.owner, h.sessionId, '/')).entries.some((entry) => entry.name === 'welcome.txt'))
    h.service.write(h.owner, h.sessionId, 'echo sftp-reopened-terminal-alive\r')
    await h.until(() => h.output().includes('\r\nsftp-reopened-terminal-alive\r\n'))
  } finally { await h.close() }
})

test('completed managed scripts stop scanning ordinary terminal output for their old private completion nonce', { timeout: 15_000 }, async (context) => {
  const h = await harness()
  const original = ScriptCompletionParser.prototype.consume
  let scans = 0
  context.mock.method(ScriptCompletionParser.prototype, 'consume', function(this: ScriptCompletionParser, chunk: Buffer) { scans++; return original.call(this, chunk) })
  try {
    const run = await h.service.runTerminalScript(h.owner, h.sessionId, "printf 'managed-lifecycle-done\\n'\n")
    await h.until(() => h.runs.get(run.id)?.status === 'completed')
    await h.until(() => h.output().endsWith(`${h.fixture.username}@ssh-heaven:/$ `))
    scans = 0
    h.service.write(h.owner, h.sessionId, 'echo ordinary-terminal-after-script\r')
    await h.until(() => h.output().includes('\r\nordinary-terminal-after-script\r\n'))
    assert.equal(scans, 0, 'A completed script must release its parser; normal echo should take the direct output path')
    const next = await h.service.runTerminalScript(h.owner, h.sessionId, 'exit 7\n')
    await h.until(() => h.runs.get(next.id)?.status === 'failed')
    assert.equal(h.service.getScriptRun(h.owner, next.id).exitCode, 7)
  } finally { await h.close() }
})

test('an SFTP open finishing after disconnect cannot return an old channel to a reused session ID', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const client = h.service.getClient(h.owner, h.sessionId), original = client.sftp.bind(client)
    let created!: () => void, delivered!: () => void, oldChannel: SFTPWrapper | undefined
    const hasChannel = new Promise<void>((resolve) => { created = resolve }), callbackDelivered = new Promise<void>((resolve) => { delivered = resolve })
    client.sftp = ((callback: (error: Error | undefined, channel: SFTPWrapper) => void) => original((error, channel) => {
      oldChannel = channel; created()
      setTimeout(() => { callback(error, channel); delivered() }, 80)
    })) as typeof client.sftp
    const opening = h.service.getSftp(h.owner, h.sessionId)
    const outcome = opening.then(() => 'unexpected success', (error: Error) => error.message)
    await hasChannel
    h.service.disconnect(h.owner, h.sessionId)
    await h.connect()
    assert.match(await outcome, /disconnected while opening SFTP/)
    const current = await h.service.getSftp(h.owner, h.sessionId)
    assert.equal(current === oldChannel, false)
    await callbackDelivered
    assert.equal(h.service.getClient(h.owner, h.sessionId) === client, false)
    assert.ok((await h.service.listDirectory(h.owner, h.sessionId, '/')).entries.some((entry) => entry.name === 'welcome.txt'))
  } finally { await h.close() }
})

test('a synchronous SFTP open error does not permanently cache a rejected promise', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const client = h.service.getClient(h.owner, h.sessionId), original = client.sftp
    client.sftp = ((callback: (error: Error) => void) => { callback(new Error('fixture immediate channel failure')); return client }) as typeof client.sftp
    await assert.rejects(h.service.getSftp(h.owner, h.sessionId), /immediate channel failure/)
    client.sftp = original
    assert.ok((await h.service.listDirectory(h.owner, h.sessionId, '/')).entries.some((entry) => entry.name === 'welcome.txt'))
  } finally { await h.close() }
})
