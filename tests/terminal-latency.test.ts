import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import test from 'node:test'
import ssh2, { type Connection, type ServerChannel } from 'ssh2'
import { SshService } from '../electron/ssh-service'
import { AppStore } from '../electron/store'

async function harness(delay = 0) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-latency-'))
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
  const clients = new Set<Connection>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let silent = false
  let remoteShell: ServerChannel | undefined
  let input = ''
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client)
    // ssh2 exposes this server method at runtime, but its Connection typings
    // omit it. Control only our fixture's physical socket, never app internals.
    ;(client as Connection & { setNoDelay(value: boolean): void }).setNoDelay(true)
    client.on('close', () => clients.delete(client))
    client.on('error', () => {})
    client.on('authentication', (ctx) => ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'fixture-secret' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (accepted) => accepted?.())
      session.on('shell', (accepted) => {
        const channel = accepted()
        remoteShell = channel
        channel.on('data', (data: Buffer) => {
          input += data.toString('utf8')
          if (silent) return
          if (['OUTPUT_FLOOD', 'OUTPUT_FLOOD_CLOSE'].includes(data.toString())) {
            for (let index = 0; index < 2000; index++) channel.write('x')
            channel.write('\0done\0')
            if (data.toString() === 'OUTPUT_FLOOD_CLOSE') { channel.exit(0); channel.end() }
            return
          }
          if (!delay) channel.write(data)
          else {
            const timer = setTimeout(() => { timers.delete(timer); if (!channel.destroyed) channel.write(data) }, delay)
            timers.add(timer)
          }
        })
      })
    }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  let received = ''
  let events = 0
  const listeners = new Set<() => void>()
  const owner = 1401, sessionId = 'latency-session'
  const ordering: string[] = []
  const service = new SshService(store, {
    data(_owner, event) { events++; ordering.push('data'); received += Buffer.from(event.data).toString('utf8'); for (const listener of listeners) listener() },
    status(_owner, event) { ordering.push(event.status) }, hostKey(ownerId, challenge) { queueMicrotask(() => service.resolveHostKey(ownerId, challenge.requestId, true)) }
  })
  await service.connect({ sessionId, profile: { id: 'latency-fixture', name: 'Latency fixture', host: '127.0.0.1', port: address.port, username: 'test', authType: 'password' }, password: 'fixture-secret' }, owner)
  const wait = async (expected: string) => {
    if (received === expected) return
    await new Promise<void>((resolve, reject) => {
      const done = () => { if (received === expected) { clearTimeout(timer); listeners.delete(done); resolve() } }
      const timer = setTimeout(() => { listeners.delete(done); reject(new Error(`Echo did not match: ${JSON.stringify(received)}.`)) }, 2000)
      listeners.add(done)
    })
  }
  return {
    service, owner, sessionId, wait, ordering,
    silent(value: boolean) { silent = value },
    pauseInput() { remoteShell?.pause() },
    resumeInput() { remoteShell?.resume() },
    received: () => received,
    async finishScript(code = 0) {
      const deadline = Date.now() + 2000
      while (!input.endsWith('\r')) { assert.ok(Date.now() < deadline, 'queued script did not reach the remote channel'); await new Promise((resolve) => setTimeout(resolve, 5)) }
      const encoded = input.match(/ssh-heaven;((?:\\[0-7]{3})+);%s/)!?.[1]
      assert.ok(encoded, 'the remote fixture must read the actual nonce from the received wrapper')
      const nonce = Buffer.from(Array.from(encoded.matchAll(/\\([0-7]{3})/g), (match) => parseInt(match[1], 8))).toString('ascii')
      remoteShell!.write(`\x1b]777;ssh-heaven;${nonce};${code}\x07`)
      while (service.listScriptRuns(owner).some((run) => run.status === 'running')) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5)) }
      input = ''
    },
    async flood(close = false) {
      received = ''; events = 0
      service.write(owner, sessionId, close ? 'OUTPUT_FLOOD_CLOSE' : 'OUTPUT_FLOOD')
      await wait('x'.repeat(2000) + '\0done\0')
      return events
    },
    async burst(noDelay?: boolean, count = 4) {
      received = ''
      if (noDelay !== undefined) service.getClient(owner, sessionId).setNoDelay(noDelay)
      const started = performance.now()
      for (let i = 0; i < count; i++) service.write(owner, sessionId, String.fromCharCode(65 + i))
      await wait(Array.from({ length: count }, (_, i) => String.fromCharCode(65 + i)).join(''))
      return performance.now() - started
    },
    async close() {
      service.dispose()
      for (const timer of timers) clearTimeout(timer)
      for (const client of clients) client.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }
}

test('interactive SSH bursts preserve immediate server-driven echo with TCP_NODELAY and no app input timer', { timeout: 20_000 }, async (context) => {
  const h = await harness(25)
  try {
    const nagle: number[] = [], immediate: number[] = []
    for (let i = 0; i < 8; i++) {
      nagle.push(await h.burst(false))
      immediate.push(await h.burst(true))
    }
    context.diagnostic(`Nagle enabled burst RTT ms: ${nagle.map((value) => value.toFixed(2)).join(', ')}`)
    context.diagnostic(`TCP_NODELAY burst RTT ms: ${immediate.map((value) => value.toFixed(2)).join(', ')}`)
    // The fixture intentionally waits 25ms before echo. Allow scheduling noise
    // while catching an accidental 100ms+ app-side batching timer.
    assert.ok(immediate.sort((a, b) => a - b)[4] < 100, 'interactive echo has excessive app-added delay')
  } finally { await h.close() }
})

test('small-packet SSH output is coalesced without losing bytes or the final output before disconnect', { timeout: 10_000 }, async (context) => {
  const h = await harness()
  try {
    const events = await h.flood()
    context.diagnostic(`Terminal event callbacks for 2000 one-byte SSH packets: ${events} (baseline: 2001)`)
    assert.ok(events < 100, 'a server output burst flooded the IPC/renderer with tiny events')
    const closedEvents = await h.flood(true)
    assert.ok(closedEvents < 100)
    const deadline = Date.now() + 2000
    while (!h.ordering.includes('disconnected')) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5)) }
    assert.equal(h.ordering.at(-1), 'disconnected')
    assert.ok(h.ordering.lastIndexOf('data') < h.ordering.lastIndexOf('disconnected'))
  }
  finally { await h.close() }
})

test('localhost single-key echo has no batching delay and a silent remote password prompt stays silent', { timeout: 10_000 }, async (context) => {
  const h = await harness()
  try {
    const samples: number[] = []
    for (let sample = 0; sample < 25; sample++) samples.push(await h.burst(undefined, 1))
    samples.sort((a, b) => a - b)
    context.diagnostic(`Default transport single-key RTT: median=${samples[12].toFixed(2)}ms p95=${samples[23].toFixed(2)}ms`)
    assert.ok(samples[12] < 50, 'single-key server echo is waiting on an app timer')
    await h.burst(undefined, 0)
    h.silent(true)
    h.service.write(h.owner, h.sessionId, 'never-locally-echo-this-password')
    await new Promise((resolve) => setTimeout(resolve, 35))
    assert.equal(h.received(), '')
    h.silent(false)
    await h.burst(undefined, 1)
  } finally { await h.close() }
})

test('terminal scripts send printable ASCII through Readline, retain exact UTF-8/tabs/trailing LF, and reject control injection and disconnected owners', { timeout: 10_000 }, async () => {
  const h = await harness()
  try {
    const command = String.raw`echo 'hello';` + '\r\n\t' + String.raw`printf "%s\n" "$HOME ☁"` + '\r\n\r\n'
    await h.service.runTerminalScript(h.owner, h.sessionId, command)
    const deadline = Date.now() + 2000
    while (!h.received().endsWith('\r')) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 5)) }
    const payload = h.received()
    assert.match(payload, /^[\x20-\x7e]+\r$/)
    assert.match(payload, /^sh -c '/)
    assert.ok(payload.includes('printf .); trap '))
    assert.ok(payload.includes('sh -c "${s%.}"; exit $?'))
    const encodedScript = payload.match(/(?:\\[0-7]{3})+/)![0]
    const decoded = Buffer.from(Array.from(encodedScript.matchAll(/\\([0-7]{3})/g), (match) => parseInt(match[1], 8))).toString('utf8')
    assert.equal(decoded, command.replace(/\r\n/g, '\n'))
    assert.equal(decoded.endsWith('\n\n'), true)
    await h.finishScript()
    for (const script of ['', '   ', 'x'.repeat(32769), 'echo a\0bad', 'echo a\x1b[2J', 'echo a\x03bad', 'echo a\x7fbad', 'echo a\rbad', 'echo a\ud800']) await assert.rejects(h.service.runTerminalScript(h.owner, h.sessionId, script), /script|Script|control|Unicode/)
    await assert.rejects(h.service.runTerminalScript(h.owner + 1, h.sessionId, 'echo unauthorized'), /another window/)
    h.service.disconnect(h.owner, h.sessionId)
    await assert.rejects(h.service.runTerminalScript(h.owner, h.sessionId, 'echo disconnected'), /no longer connected/)
  } finally { await h.close() }
})

test('terminal script submission waits for SSH channel backpressure and reports disconnect instead of pretending a queued write succeeded', { timeout: 10_000 }, async () => {
  const h = await harness()
  try {
    h.silent(true)
    h.pauseInput()
    const fillWindow = () => { for (let index = 0; index < 3; index++) h.service.write(h.owner, h.sessionId, 'x'.repeat(1024 * 1024)) }
    fillWindow()
    let settled = false
    const submitting = h.service.runTerminalScript(h.owner, h.sessionId, 'echo queued-script').then(() => { settled = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false, 'submission resolved before the queued channel write drained')
    h.resumeInput()
    await submitting
    assert.equal(settled, true)
    await h.finishScript()
    // Fill another channel window and close while its script is still queued.
    h.pauseInput(); fillWindow()
    const disconnected = h.service.runTerminalScript(h.owner, h.sessionId, 'echo disconnected-while-queued')
    const rejected = assert.rejects(disconnected, /disconnected|closed|write/i)
    h.service.disconnect(h.owner, h.sessionId)
    await rejected
  } finally { await h.close() }
})
