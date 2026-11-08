import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type { ClientRequest, IncomingMessage } from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import type { UpdateState } from '../shared/types'
import { MAX_INSTALLER_BYTES, selectUpdateAsset } from '../electron/update-download'
import { UpdateService, type UpdateOptions } from '../electron/updates'

const api = 'https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest'
const page = 'https://github.com/hellokittypsycho/ssh-heaven/releases/latest'
const config = { enabled: true, provider: 'github', manifestUrl: api, downloadUrl: page }
const bytes = Buffer.from('MZ\0SSH Heaven inert unit-test installer bytes.\n'.repeat(5000))
const digest = createHash('sha256').update(bytes).digest('hex')
function metadata(version = '0.10.0', name = `SSH.Heaven.Setup.${version}.exe`): Record<string, unknown> {
  return { tag_name: `v${version}`, draft: false, prerelease: false, assets: [{ id: 123, name, state: 'uploaded', size: bytes.length, digest: `sha256:${digest}`, browser_download_url: `https://github.com/hellokittypsycho/ssh-heaven/releases/download/v${version}/${encodeURIComponent(name)}` }] }
}
function asset(value: Record<string, unknown>) { return (value.assets as Record<string, unknown>[])[0] }
interface Reply { status?: number; headers?: Record<string, string>; body?: Buffer; hold?: boolean; error?: boolean }
function network(context: TestContext) {
  const requests: { url: string; headers: Record<string, string> }[] = []
  const responses: PassThrough[] = []
  let route: (url: string) => Reply = () => ({ body: bytes, headers: { 'content-length': String(bytes.length) } })
  context.mock.method(https, 'get', ((url: string | URL, options: { signal?: AbortSignal; headers: Record<string, string> }, callback: (response: IncomingMessage) => void) => {
    requests.push({ url: String(url), headers: options.headers })
    const request = new EventEmitter() as ClientRequest
    let incoming: PassThrough | undefined
    request.destroy = ((error?: Error) => { if (error) queueMicrotask(() => request.emit('error', error)); incoming?.destroy(error); return request }) as typeof request.destroy
    const abort = () => request.destroy(new Error('Fixture request canceled'))
    options.signal?.addEventListener('abort', abort, { once: true })
    queueMicrotask(() => {
      if (options.signal?.aborted) { abort(); return }
      const reply = route(String(url))
      if (reply.error) { request.emit('error', new Error('Fixture network failure')); return }
      incoming = Object.assign(new PassThrough(), { statusCode: reply.status ?? 200, headers: reply.headers ?? {} })
      incoming.once('close', () => options.signal?.removeEventListener('abort', abort))
      responses.push(incoming)
      callback(incoming as unknown as IncomingMessage)
      if (reply.hold) incoming.write(reply.body ?? bytes.subarray(0, 128))
      else incoming.end(reply.body ?? bytes)
    })
    return request
  }) as typeof https.get)
  return { requests, responses, set(next: (url: string) => Reply) { route = next } }
}
async function fixture(options: Partial<UpdateOptions> = {}, initial = metadata()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-update-download-'))
  const configPath = path.join(directory, 'release.json'), cache = path.join(directory, 'updates')
  await writeFile(configPath, JSON.stringify(config))
  const states: UpdateState[] = [], launched: string[] = [], opened: string[] = []
  let release = initial, checks = 0
  const service = new UpdateService('0.9.0', (state) => states.push(state), async (url) => { opened.push(url) }, async () => { checks++; return release }, {
    directory: cache, platform: 'win32', arch: 'x64', launchInstaller: async (filename) => { launched.push(filename) }, ...options,
  })
  await service.initialize(configPath)
  return {
    service, cache, directory, configPath, states, launched, opened,
    get checks() { return checks }, set metadata(value: Record<string, unknown>) { release = value },
    async files() {
      const children = await readdir(cache).catch(() => [])
      const result: string[] = []
      for (const child of children) for (const name of await readdir(path.join(cache, child)).catch(() => [])) result.push(path.join(cache, child, name))
      return result
    },
    async close() { service.dispose(); await service.cancelDownload(); await rm(directory, { recursive: true, force: true }) },
  }
}
async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(label)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

test('installer metadata grants only an unambiguous Windows x64 asset from the configured repository and stable tag', () => {
  for (const name of ['SSH.Heaven.Setup.0.10.0.exe', 'SSH Heaven Setup 0.10.0.exe']) assert.equal(selectUpdateAsset(metadata('0.10.0', name), api, '0.10.0', 'win32', 'x64')?.sha256, digest)
  for (const change of [
    { id: 0 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { size: 0 }, { size: MAX_INSTALLER_BYTES + 1 }, { size: 10.5 }, { state: 'new' },
    { digest: null }, { digest: `md5:${digest}` }, { digest: 'sha256:123' }, { name: 'SSH.Heaven.Setup.0.10.0-arm64.exe' }, { name: 'SSH.Heaven.Setup.0.9.0.exe' },
    ...['http://github.com/hellokittypsycho/ssh-heaven/releases/download/v0.10.0/SSH.Heaven.Setup.0.10.0.exe',
      'https://github.com/other/ssh-heaven/releases/download/v0.10.0/SSH.Heaven.Setup.0.10.0.exe',
      'https://github.com/hellokittypsycho/other/releases/download/v0.10.0/SSH.Heaven.Setup.0.10.0.exe',
      'https://github.com/hellokittypsycho/ssh-heaven/releases/download/v0.10.0/SSH.Heaven.Setup.0.10.0.exe?x=1',
      'https://github.com/hellokittypsycho/ssh-heaven/releases/download/v0.10.0/SSH.Heaven.Setup.0.10.0.exe#x',
      'https://user:password@github.com/hellokittypsycho/ssh-heaven/releases/download/v0.10.0/SSH.Heaven.Setup.0.10.0.exe',
      'https://github.com.evil.example/hellokittypsycho/ssh-heaven/releases/download/v0.10.0/SSH.Heaven.Setup.0.10.0.exe',
      'https://github.com/hellokittypsycho/ssh-heaven/releases/download/v0.10.1/SSH.Heaven.Setup.0.10.0.exe',
    ].map((browser_download_url) => ({ browser_download_url })),
  ]) {
    const value = metadata(); Object.assign(asset(value), change)
    assert.equal(selectUpdateAsset(value, api, '0.10.0', 'win32', 'x64'), undefined)
  }
  for (const change of [{ draft: true }, { prerelease: true }, { tag_name: 'v0.10.0-beta' }, { tag_name: 'v0.10.1' }, { assets: [asset(metadata()), asset(metadata())] }]) assert.equal(selectUpdateAsset({ ...metadata(), ...change }, api, '0.10.0', 'win32', 'x64'), undefined)
  assert.equal(selectUpdateAsset(metadata(), api, '0.10.0', 'linux', 'x64'), undefined)
  assert.equal(selectUpdateAsset(metadata(), api, '0.10.0', 'win32', 'arm64'), undefined)
})

test('metadata checks fetch no installer bytes; an explicit download follows GitHub redirects, verifies bytes, and waits for explicit install', async (context) => {
  const net = network(context), h = await fixture()
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=fixture-only'
  net.set((url): Reply => url.startsWith('https://github.com/') ? { status: 302, headers: { location: cdn }, body: Buffer.alloc(0) } : { body: bytes, headers: { 'content-length': String(bytes.length) } })
  try {
    await assert.rejects(h.service.install(), /Download and verify/)
    assert.equal((await h.service.check()).downloadAvailable, true)
    assert.equal(net.requests.length, 0)
    assert.equal(await stat(h.cache).catch(() => null), null)
    const result = await h.service.download()
    assert.equal(result.status, 'downloaded'); assert.equal(result.progress, 100)
    assert.equal(result.downloadedBytes, bytes.length); assert.equal(result.totalBytes, bytes.length)
    assert.equal(net.requests.length, 2)
    assert.equal(net.requests[1].url, cdn)
    assert.deepEqual(net.requests[0].headers, { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'SSH-Heaven-Update-Download' })
    assert.ok(net.requests.every((request) => !Object.keys(request.headers).some((name) => /authorization|cookie/i.test(name))))
    const files = await h.files(); assert.equal(files.length, 1); assert.ok(files[0].endsWith('.exe'))
    assert.deepEqual(await readFile(files[0]), bytes)
    assert.deepEqual(h.launched, []); assert.deepEqual(h.opened, [])
    assert.equal((await h.service.check()).status, 'downloaded', 'checking must not invalidate a ready installer')
    assert.equal(h.checks, 1)
    assert.equal(JSON.stringify(h.service.getState()).includes(h.directory), false)
    assert.equal(JSON.stringify(h.service.getState()).includes('signature='), false)
    await Promise.all([h.service.install(), h.service.install()])
    assert.deepEqual(h.launched, files)
    await h.service.install(); assert.equal(h.launched.length, 1, 'an installer that started must never be launched twice')
    h.service.dispose(); assert.deepEqual(await readFile(files[0]), bytes, 'quit must not delete an executable that may still be running')
  } finally { await h.close() }
})

test('short, oversized, corrupt, compressed, and mismatched-length installers fail closed and clean temporary files', async (context) => {
  const net = network(context)
  const failures: Reply[] = [
    { body: bytes.subarray(0, bytes.length - 1) },
    { body: Buffer.concat([bytes, Buffer.from('extra')]) },
    { body: Buffer.alloc(bytes.length, 1) },
    { body: bytes, headers: { 'content-length': String(bytes.length + 1) } },
    { body: bytes, headers: { 'content-encoding': 'gzip' } },
    { status: 500, body: Buffer.alloc(0) }, { error: true },
  ]
  for (const reply of failures) {
    const h = await fixture(); net.set(() => reply)
    try {
      await h.service.check()
      const result = await h.service.download()
      assert.equal(result.status, 'available'); assert.equal(result.downloadAvailable, true)
      assert.ok(result.message)
      assert.deepEqual(await h.files(), [])
      assert.deepEqual(await readdir(h.cache), [])
      await assert.rejects(h.service.install(), /Download and verify/)
      assert.deepEqual(h.launched, [])
    } finally { await h.close() }
  }
})

test('download redirects cannot escape exact approved HTTPS GitHub CDN hosts or exceed five hops', async (context) => {
  const net = network(context)
  for (const target of ['http://release-assets.githubusercontent.com/payload', 'https://release-assets.githubusercontent.com.evil.example/payload', 'https://user:password@release-assets.githubusercontent.com/payload', 'https://release-assets.githubusercontent.com:8443/payload', 'https://release-assets.githubusercontent.com/payload#x', 'https://evil.example/payload', 'https://127.0.0.1/payload', 'https://github.com/other/repo/releases/download/v1/payload.exe']) {
    const h = await fixture(); net.set(() => ({ status: 302, headers: { location: target }, body: Buffer.alloc(0) }))
    const count = net.requests.length
    try {
      await h.service.check(); assert.equal((await h.service.download()).status, 'available')
      assert.equal(net.requests.length, count + 1, 'an unapproved redirect must not receive any request')
      assert.deepEqual(await h.files(), [])
    } finally { await h.close() }
  }
  const h = await fixture(); let hop = 0
  net.set(() => ({ status: 302, headers: { location: `https://release-assets.githubusercontent.com/${++hop}` }, body: Buffer.alloc(0) }))
  const before = net.requests.length
  try {
    await h.service.check(); assert.match((await h.service.download()).message!, /too many/)
    assert.equal(net.requests.length, before + 6)
    assert.deepEqual(await h.files(), [])
  } finally { await h.close() }
})

test('cancel and duplicate download calls share one transfer; partial bytes are removed and retry succeeds', async (context) => {
  const net = network(context), h = await fixture()
  net.set(() => ({ hold: true }))
  try {
    await h.service.check()
    const first = h.service.download(), second = h.service.download()
    assert.equal(first, second)
    await eventually(() => (h.service.getState().downloadedBytes ?? 0) > 0, 'waiting for a streamed partial download')
    assert.equal((await h.service.check()).status, 'downloading'); assert.equal(h.checks, 1)
    assert.equal(net.requests.length, 1)
    assert.equal((await h.service.cancelDownload()).status, 'available')
    await first
    assert.deepEqual(await h.files(), [])
    assert.deepEqual(await readdir(h.cache), [])
    net.set(() => ({ body: bytes }))
    assert.equal((await h.service.download()).status, 'downloaded')
    assert.deepEqual(h.launched, [])
  } finally { await h.close() }
})

test('quit aborts partial downloads without later status notifications or an installer launch', async (context) => {
  const net = network(context), h = await fixture(); net.set(() => ({ hold: true }))
  try {
    await h.service.check(); const downloading = h.service.download()
    await eventually(() => (h.service.getState().downloadedBytes ?? 0) > 0, 'waiting for partial bytes')
    const notifications = h.states.length
    h.service.dispose(); await downloading
    assert.equal(h.states.length, notifications)
    assert.deepEqual(await h.files(), [])
    await assert.rejects(h.service.install(), /Download and verify/)
    assert.deepEqual(h.launched, [])
  } finally { await h.close() }
})

test('installer tampering is caught before cleanup and again after awaited cleanup', async (context) => {
  network(context)
  let cleanup = 0
  const h = await fixture({ beforeInstall: async () => { cleanup++ } })
  try {
    await h.service.check(); await h.service.download()
    await writeFile((await h.files())[0], Buffer.alloc(bytes.length, 0))
    await assert.rejects(h.service.install(), /failed verification/)
    assert.equal(cleanup, 0); assert.deepEqual(h.launched, [])
    assert.equal(h.service.getState().status, 'available'); assert.deepEqual(await h.files(), [])
  } finally { await h.close() }
  let next!: Awaited<ReturnType<typeof fixture>>
  next = await fixture({ beforeInstall: async () => { await writeFile((await next.files())[0], Buffer.alloc(bytes.length, 0)) } })
  try {
    await next.service.check(); await next.service.download()
    await assert.rejects(next.service.install(), /failed verification/)
    assert.deepEqual(next.launched, []); assert.equal(next.service.getState().status, 'available')
  } finally { await next.close() }
})

test('cleanup or launch failure keeps the verified installer ready for an explicit retry', async (context) => {
  network(context)
  let failCleanup = true, failLaunch = true, launches = 0
  const h = await fixture({ beforeInstall: async () => { if (failCleanup) throw new Error('private native detail') }, launchInstaller: async () => { launches++; if (failLaunch) throw new Error('private native path') } })
  try {
    await h.service.check(); await h.service.download()
    await assert.rejects(h.service.install(), /Active work could not be closed/)
    assert.equal(h.service.getState().status, 'downloaded'); assert.equal(launches, 0)
    failCleanup = false
    await assert.rejects(h.service.install(), /installer could not start/)
    assert.equal(h.service.getState().status, 'downloaded'); assert.equal(launches, 1)
    assert.equal(h.service.getState().message!.includes('private native'), false)
    assert.deepEqual(await readFile((await h.files())[0]), bytes)
    failLaunch = false
    await Promise.all([h.service.install(), h.service.install()])
    assert.equal(launches, 2)
  } finally { await h.close() }
})

test('disposal while cleanup is pending prevents launch and preserves the verified executable', async (context) => {
  network(context)
  let release!: () => void, entered = false
  const h = await fixture({ beforeInstall: async () => { entered = true; await new Promise<void>((resolve) => { release = resolve }) } })
  try {
    await h.service.check(); await h.service.download()
    const installing = h.service.install()
    await eventually(() => entered, 'waiting for install cleanup')
    const current = (await h.files())[0]
    h.service.dispose(); release()
    await assert.rejects(installing, /ended before/)
    assert.deepEqual(h.launched, [])
    assert.deepEqual(await readFile(current), bytes)
  } finally { await h.close() }
})

test('reconfiguring during a transfer cancels it and does not retain a stale installer capability', async (context) => {
  const net = network(context), h = await fixture(); net.set(() => ({ hold: true }))
  try {
    await h.service.check(); const downloading = h.service.download()
    await eventually(() => (h.service.getState().downloadedBytes ?? 0) > 0, 'waiting for download')
    await writeFile(h.configPath, JSON.stringify({ enabled: false }))
    await h.service.initialize(h.configPath); await downloading
    assert.equal(h.service.getState().status, 'unconfigured')
    await assert.rejects(h.service.download(), /No verified/)
    await assert.rejects(h.service.install(), /Download and verify/)
    assert.deepEqual(await h.files(), [])
  } finally { await h.close() }
})

test('unsupported architecture, custom manifests, and missing digests retain the fixed manual release-page fallback', async (context) => {
  const net = network(context)
  for (const options of [{ platform: 'darwin' as const }, { arch: 'arm64' }]) {
    const h = await fixture(options)
    try {
      assert.equal((await h.service.check()).downloadAvailable, false)
      await assert.rejects(h.service.download(), /No verified/)
      await h.service.openDownload(); assert.deepEqual(h.opened, [page])
      assert.equal(net.requests.length, 0)
    } finally { await h.close() }
  }
  const missing = metadata(); delete asset(missing).digest
  const h = await fixture({}, missing)
  try {
    assert.equal((await h.service.check()).downloadAvailable, false)
    await assert.rejects(h.service.download(), /No verified/)
    await writeFile(h.configPath, JSON.stringify({ enabled: true, provider: 'manifest', manifestUrl: 'https://updates.example.com/version.json', downloadUrl: 'https://downloads.example.com/releases' }))
    await h.service.initialize(h.configPath); h.metadata = { version: '0.10.0', ...metadata() }
    assert.equal((await h.service.check()).downloadAvailable, false)
    await h.service.openDownload(); assert.deepEqual(h.opened, ['https://downloads.example.com/releases'])
    assert.equal(net.requests.length, 0)
  } finally { await h.close() }
})

test('update cache junctions cannot redirect writes or allow a moved verified executable to launch', async (context) => {
  const net = network(context), h = await fixture()
  const outside = path.join(h.directory, 'outside'), moved = path.join(h.directory, 'moved-cache')
  await mkdir(outside); await writeFile(path.join(outside, 'keep.txt'), 'unrelated fixture file')
  await symlink(outside, h.cache, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    await h.service.check(); assert.equal((await h.service.download()).status, 'available')
    assert.equal(net.requests.length, 0)
    assert.deepEqual(await readdir(outside), ['keep.txt'])
    await rm(h.cache)
    assert.equal((await h.service.download()).status, 'downloaded')
    await rename(h.cache, moved)
    await symlink(moved, h.cache, process.platform === 'win32' ? 'junction' : 'dir')
    await assert.rejects(h.service.install(), /failed verification/)
    assert.deepEqual(h.launched, [])
    assert.deepEqual(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'unrelated fixture file')
    assert.ok((await readdir(moved)).length > 0, 'cleanup must not recurse through a substituted cache junction')
  } finally { await h.close() }
})
