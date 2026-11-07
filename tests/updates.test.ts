import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { ClientRequest, IncomingMessage } from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { newerVersion, UpdateService, validateReleaseConfig } from '../electron/updates'
import type { UpdateState } from '../shared/types'

const githubConfig = { enabled: true, provider: 'github', manifestUrl: 'https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest', downloadUrl: 'https://github.com/hellokittypsycho/ssh-heaven/releases/latest' } as const
async function serviceFixture(fetch?: (url: string) => Promise<unknown>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ssh-heaven-github-updates-'))
  const config = path.join(directory, 'release.json')
  await writeFile(config, JSON.stringify(githubConfig))
  const opened: string[] = [], states: UpdateState[] = []
  const service = new UpdateService('0.8.0', (state) => states.push(state), async (url) => { opened.push(url) }, fetch)
  await service.initialize(config)
  return { directory, config, opened, states, service, async close() { await rm(directory, { recursive: true, force: true }) } }
}

test('update notifications compare numeric stable versions and reject untrusted release URLs', () => {
  assert.equal(newerVersion('0.10.0', '0.9.9'), true)
  assert.equal(newerVersion('0.5.0', '0.5.0'), false)
  assert.equal(newerVersion('0.4.99', '0.5.0'), false)
  assert.throws(() => newerVersion('latest', '0.5.0'), /stable version/)
  for (const url of ['http://example.com/version.json', 'javascript:alert(1)', 'https://user:password@example.com/version.json', 'https://example.com/version.json?token=secret']) {
    assert.throws(() => validateReleaseConfig({ enabled: true, manifestUrl: url, downloadUrl: 'https://example.com/releases' }), /HTTPS|URL/)
  }
})

test('update checks notify only and open the fixed download page solely after an explicit action', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ssh-heaven-update-test-'))
  try {
    const config = path.join(directory, 'release.json')
    await writeFile(config, JSON.stringify({ enabled: true, manifestUrl: 'https://updates.example.com/version.json', downloadUrl: 'https://downloads.example.com/releases' }))
    const states: UpdateState[] = []; const opened: string[] = []; let checks = 0
    const service = new UpdateService('0.5.0', (state) => states.push(state), async (url) => { opened.push(url) }, async (url) => {
      assert.equal(url, 'https://updates.example.com/version.json'); checks++
      return { version: '0.6.0', downloadUrl: 'https://untrusted.example/installer.exe' }
    })
    await service.initialize(config)
    assert.equal(checks, 0)
    await assert.rejects(service.openDownload(), /Check for a newer/)
    assert.equal((await service.check()).status, 'available')
    assert.equal(checks, 1)
    assert.deepEqual(opened, [], 'A version check must never download, navigate, or install anything')
    await service.openDownload()
    assert.deepEqual(opened, ['https://downloads.example.com/releases'], 'Ignore download destinations from remote manifests')
    assert.deepEqual(states.map((state) => state.status), ['idle', 'checking', 'available'])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unconfigured builds make no network request and failed checks can be retried', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ssh-heaven-update-test-'))
  try {
    const config = path.join(directory, 'release.json')
    await writeFile(config, JSON.stringify({ enabled: false }))
    let checks = 0
    const service = new UpdateService('0.5.0', () => {}, async () => {}, async () => { checks++; throw new Error('Offline') })
    await service.initialize(config)
    assert.equal((await service.check()).status, 'unconfigured')
    assert.equal(checks, 0)
    await writeFile(config, JSON.stringify({ enabled: true, manifestUrl: 'https://example.com/version.json', downloadUrl: 'https://example.com/releases' }))
    await service.initialize(config)
    assert.equal((await service.check()).status, 'error')
    assert.equal((await service.check()).status, 'error')
    assert.equal(checks, 2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('GitHub provider accepts only official latest-release metadata and the matching fixed repository page', () => {
  assert.equal(validateReleaseConfig(githubConfig).provider, 'github')
  assert.equal(validateReleaseConfig({ enabled: true, manifestUrl: 'https://updates.example.com/version.json', downloadUrl: 'https://downloads.example.com/releases' }).provider, 'manifest')
  for (const update of [
    { provider: 'unknown' },
    { manifestUrl: 'https://api.github.com.evil.example/repos/hellokittypsycho/ssh-heaven/releases/latest' },
    { manifestUrl: 'https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases' },
    { manifestUrl: 'https://api.github.com:8443/repos/hellokittypsycho/ssh-heaven/releases/latest' },
    { manifestUrl: 'https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest?token=example' },
    { manifestUrl: 'https://api.github.com/repos/hello%2fother/ssh-heaven/releases/latest' },
    { downloadUrl: 'https://github.com/other-owner/ssh-heaven/releases/latest' },
    { downloadUrl: 'https://github.com/hellokittypsycho/other-repo/releases/latest' },
    { downloadUrl: 'https://github.com/hellokittypsycho/ssh-heaven/releases/download/v0.9.0/installer.exe' },
    { downloadUrl: 'https://github.com/hellokittypsycho/ssh-heaven/releases/latest#installer' },
    { downloadUrl: 'https://github.com.evil.example/hellokittypsycho/ssh-heaven/releases/latest' }
  ]) assert.throws(() => validateReleaseConfig({ ...githubConfig, ...update }), /provider|GitHub|HTTPS|URL/)
})

test('GitHub tags compare older/same/new stable versions and remote assets never choose a download or open without a click', async () => {
  let tag = 'v0.7.99', checks = 0
  const h = await serviceFixture(async (url) => {
    assert.equal(url, githubConfig.manifestUrl); checks++
    return { tag_name: tag, draft: false, prerelease: false, version: '99.0.0', html_url: 'https://untrusted.example/release', downloadUrl: 'https://untrusted.example/installer.exe', assets: [{ browser_download_url: 'https://untrusted.example/payload.exe' }] }
  })
  try {
    assert.equal(checks, 0)
    await assert.rejects(h.service.openDownload(), /Check for a newer/)
    assert.equal((await h.service.check()).status, 'not-available')
    tag = 'v0.8.0'; assert.equal((await h.service.check()).status, 'not-available')
    tag = 'v0.8.1'; assert.equal((await h.service.check()).version, '0.8.1')
    assert.equal(h.service.getState().status, 'available')
    assert.deepEqual(h.opened, [])
    await h.service.openDownload()
    assert.deepEqual(h.opened, [githubConfig.downloadUrl])
    tag = '0.10.0'; assert.equal((await h.service.check()).version, '0.10.0')
    assert.equal(h.opened.length, 1, 'later checks must still never navigate or download')
  } finally { await h.close() }
})

test('GitHub checks reject drafts, prereleases, missing flags, and malformed tags rather than offering untrusted versions', async () => {
  let payload: unknown
  const h = await serviceFixture(async () => payload)
  try {
    for (const value of [
      { tag_name: 'v0.9.0', draft: true, prerelease: false },
      { tag_name: 'v0.9.0', draft: false, prerelease: true },
      { tag_name: 'v0.9.0', prerelease: false },
      { tag_name: 'v0.9.0', draft: false },
      { tag_name: 'v0.9.0', draft: 'false', prerelease: false },
      ...['v0.9.0-beta.1', 'v0.9.0+build', 'v01.9.0', 'v0.9', 'latest', 'v0.9.0\n', 9].map((tag_name) => ({ tag_name, draft: false, prerelease: false })),
      null, []
    ]) {
      payload = value
      assert.equal((await h.service.check()).status, 'error', `malformed release was accepted: ${JSON.stringify(value)}`)
      assert.equal(h.service.getState().version, undefined)
      await assert.rejects(h.service.openDownload(), /Check for a newer/)
    }
    assert.deepEqual(h.opened, [])
  } finally { await h.close() }
})

test('concurrent update clicks share one in-flight check and a later retry recovers from an offline error', async () => {
  let resolve!: (value: unknown) => void
  let checks = 0, offline = false
  const h = await serviceFixture(async () => {
    checks++
    if (offline) throw new Error('Offline fixture')
    return new Promise((done) => { resolve = done })
  })
  try {
    const pending = h.service.check()
    assert.equal((await h.service.check()).status, 'checking')
    assert.equal(checks, 1)
    await assert.rejects(h.service.openDownload(), /Check for a newer/)
    resolve({ tag_name: 'v0.9.0', draft: false, prerelease: false })
    assert.equal((await pending).status, 'available')
    offline = true
    assert.equal((await h.service.check()).status, 'error')
    offline = false
    const retried = h.service.check()
    resolve({ tag_name: 'v0.9.1', draft: false, prerelease: false })
    assert.equal((await retried).version, '0.9.1')
    assert.equal(checks, 3)
    assert.deepEqual(h.opened, [])
  } finally { await h.close() }
})

test('a disabled or invalid replacement configuration cannot be overwritten by an old in-flight check', async () => {
  let reject!: (error: Error) => void
  const h = await serviceFixture(async () => new Promise((_resolve, fail) => { reject = fail }))
  try {
    const pending = h.service.check()
    await writeFile(h.config, JSON.stringify({ enabled: false }))
    await h.service.initialize(h.config)
    reject(new Error('Old request failed'))
    assert.equal((await pending).status, 'unconfigured')
    await assert.rejects(h.service.openDownload(), /Check for a newer/)
    await writeFile(h.config, JSON.stringify({ ...githubConfig, downloadUrl: 'https://untrusted.example/releases' }))
    await h.service.initialize(h.config)
    assert.equal((await h.service.check()).status, 'error')
    assert.deepEqual(h.opened, [])
  } finally { await h.close() }
})

test('native HTTPS fetch uses fixed GitHub headers, no credentials/redirects, bounded bytes, and friendly retryable failures', async (context) => {
  let status = 200, body = '', headers: Record<string, string> = {}, requestError = false, drainError = false
  const requests: { url: unknown; options: { signal: AbortSignal; headers: Record<string, string> } }[] = []
  context.mock.method(https, 'get', ((url: unknown, options: { signal: AbortSignal; headers: Record<string, string> }, callback: (response: IncomingMessage) => void) => {
    requests.push({ url, options })
    const outgoing = new EventEmitter()
    queueMicrotask(() => {
      if (requestError) { outgoing.emit('error', new Error('Offline network fixture')); return }
      const response = Object.assign(new PassThrough(), { statusCode: status, headers })
      callback(response as unknown as IncomingMessage)
      if (drainError) response.destroy(new Error('Connection failed while draining HTTP error body'))
      else response.end(body)
    })
    return outgoing as ClientRequest
  }) as typeof https.get)
  const h = await serviceFixture()
  try {
    body = JSON.stringify({ tag_name: 'v0.9.0', draft: false, prerelease: false, body: 'notes'.repeat(5000) })
    assert.equal((await h.service.check()).status, 'available', 'GitHub responses larger than the previous 16KiB cap must work')
    assert.equal(requests[0].url, githubConfig.manifestUrl)
    assert.ok(requests[0].options.signal instanceof AbortSignal)
    assert.deepEqual(requests[0].options.headers, { Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity', 'User-Agent': 'SSH-Heaven-Update-Check', 'X-GitHub-Api-Version': '2026-03-10' })
    body = 'x'.repeat(64 * 1024 + 1)
    assert.equal((await h.service.check()).status, 'error')
    assert.match(h.service.getState().message!, /64 KiB|interrupted/)
    body = '{}'; status = 302; headers = { location: 'https://untrusted.example/installer.exe' }
    const beforeRedirect = requests.length
    assert.equal((await h.service.check()).status, 'error')
    assert.equal(requests.length, beforeRedirect + 1, 'redirect responses must never cause another request')
    status = 403; headers = { 'x-ratelimit-remaining': '0' }; drainError = true
    assert.equal((await h.service.check()).status, 'error')
    assert.match(h.service.getState().message!, /rate-limit.*Try Check for updates again later/)
    drainError = false; status = 429; headers = {}
    assert.match((await h.service.check()).message!, /rate-limit/)
    status = 404
    assert.match((await h.service.check()).message!, /No published stable GitHub release/)
    status = 200; body = '{'
    assert.match((await h.service.check()).message!, /invalid version manifest/)
    body = '{}'; headers = { 'content-encoding': 'gzip' }
    assert.match((await h.service.check()).message!, /unsupported compressed/)
    headers = {}; requestError = true
    assert.match((await h.service.check()).message!, /Offline/)
    requestError = false; body = JSON.stringify({ tag_name: 'v0.9.1', draft: false, prerelease: false })
    assert.equal((await h.service.check()).version, '0.9.1')
    assert.deepEqual(h.opened, [])
    await h.service.openDownload()
    assert.deepEqual(h.opened, [githubConfig.downloadUrl])
  } finally { await h.close() }
})
