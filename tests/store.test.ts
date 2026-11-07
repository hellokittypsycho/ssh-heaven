import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AppStore, validateProfile } from '../electron/store'
import { childLocalPath, localDownloadName } from '../electron/validation'
import type { HostProfile } from '../shared/types'

const profile: HostProfile = { id: 'host_1', name: 'Dev server', host: 'localhost', port: 22, username: 'demo', authType: 'password' }

test('profile persistence discards credentials and survives concurrent metadata writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-store-'))
  try {
    const filename = path.join(directory, 'settings.json')
    const store = new AppStore(filename)
    await store.load()
    await Promise.all([
      store.saveProfile({ ...profile, password: 'SECRET_PASSWORD', passphrase: 'SECRET_PASSPHRASE' }),
      store.trustFingerprint('localhost', 22, 'SHA256:abcdefghijklmnop')
    ])
    const source = await readFile(filename, 'utf8')
    assert.ok(!source.includes('SECRET_'))
    const restored = new AppStore(filename)
    await restored.load()
    assert.deepEqual(restored.listProfiles(), [profile])
    assert.equal(restored.getFingerprint('LOCALHOST', 22), 'SHA256:abcdefghijklmnop')
    const copies = restored.listProfiles()
    copies[0].host = 'changed'
    assert.equal(restored.listProfiles()[0].host, 'localhost')
    await restored.deleteProfile(profile.id)
    const afterDelete = new AppStore(filename)
    await afterDelete.load()
    assert.deepEqual(afterDelete.listProfiles(), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('profile validation rejects malformed ports and hosts', () => {
  assert.throws(() => validateProfile({ ...profile, port: 0 }))
  assert.throws(() => validateProfile({ ...profile, port: 1.5 }))
  assert.throws(() => validateProfile({ ...profile, port: 65536 }))
  assert.throws(() => validateProfile({ ...profile, host: 'server\ninjection' }))
  assert.throws(() => validateProfile({ ...profile, username: '' }))
  assert.throws(() => validateProfile({ ...profile, id: '../profile' }))
})

test('download filenames cannot escape the chosen directory or target Windows special files', () => {
  for (const filename of ['..', '.', '../outside', 'dir/file', 'dir\\file', 'CON', 'nul.txt', 'COM1', 'file:secret', 'trailing.', 'trailing ', 'bad\0file']) {
    assert.throws(() => localDownloadName(filename), filename)
  }
  const directory = path.resolve('downloads')
  assert.equal(childLocalPath(directory, 'report.txt'), path.join(directory, 'report.txt'))
  assert.equal(localDownloadName('notes-你好.txt'), 'notes-你好.txt')
})

test('invalid settings are reported instead of silently overwriting user profiles', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-bad-store-'))
  try {
    const filename = path.join(directory, 'settings.json')
    await writeFile(filename, '{bad json')
    await assert.rejects(new AppStore(filename).load())
    assert.equal(await readFile(filename, 'utf8'), '{bad json')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('recent connections migrate, deduplicate by endpoint, preserve nicknames, and never persist credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-recents-'))
  try {
    const filename = path.join(directory, 'settings.json')
    // Existing version-one settings have no history field.
    await writeFile(filename, JSON.stringify({ version: 1, profiles: [], knownHosts: {} }))
    const store = new AppStore(filename)
    await store.load()
    assert.deepEqual(store.listRecentHosts(), [])
    await store.recordConnection({ ...profile, password: 'RECENT_SECRET_PASSWORD', passphrase: 'RECENT_SECRET_PHRASE' })
    await store.recordConnection({ ...profile, id: 'another-id', host: 'LOCALHOST', name: 'Latest nickname' })
    assert.equal(store.listRecentHosts().length, 1)
    assert.equal(store.listRecentHosts()[0].profile.name, 'Latest nickname')
    const timestamp = store.listRecentHosts()[0].lastConnectedAt
    await store.saveProfile({ ...profile, name: 'Production nickname', group: 'Servers', favorite: true })
    assert.equal(store.listRecentHosts()[0].profile.name, 'Production nickname')
    assert.equal(store.listRecentHosts()[0].profile.group, 'Servers')
    assert.equal(store.listRecentHosts()[0].profile.favorite, true)
    assert.equal(store.listRecentHosts()[0].lastConnectedAt, timestamp)
    await store.saveProfile({ ...profile, host: 'moved.example.test', name: 'Moved profile' })
    assert.equal(store.listRecentHosts()[0].profile.host, 'LOCALHOST', 'Changing a saved endpoint must not rewrite where the user previously connected')
    assert.equal(store.listRecentHosts()[0].profile.name, 'Production nickname')
    const copy = store.listRecentHosts()
    copy[0].profile.name = 'Mutated copy'
    assert.equal(store.listRecentHosts()[0].profile.name, 'Production nickname')
    await store.deleteProfile(profile.id)
    assert.equal(store.listRecentHosts().length, 0)
    for (let index = 0; index < 25; index++) await store.recordConnection({ ...profile, id: `recent_${index}`, host: `node${index}.example.test` })
    assert.equal(store.listRecentHosts().length, 20)
    assert.equal(store.listRecentHosts()[0].profile.host, 'node24.example.test')
    assert.equal(store.listRecentHosts().at(-1)?.profile.host, 'node5.example.test')
    assert.equal((await readFile(filename, 'utf8')).includes('RECENT_SECRET'), false)
    const reloaded = new AppStore(filename)
    await reloaded.load()
    assert.deepEqual(reloaded.listRecentHosts(), store.listRecentHosts())
    await reloaded.clearRecentHosts()
    const cleared = new AppStore(filename)
    await cleared.load()
    assert.deepEqual(cleared.listRecentHosts(), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
