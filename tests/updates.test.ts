import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { newerVersion, UpdateService, validateReleaseConfig } from '../electron/updates'
import type { UpdateState } from '../shared/types'

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
