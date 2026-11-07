import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AppStore, emptyLibrary, validateLibraryItem, validateProfile } from '../electron/store'
import { CredentialVault, type CredentialCipher } from '../electron/credentials'
import { BackupService } from '../electron/backups'
import type { HostProfile } from '../shared/types'

function cipher() {
  const key = randomBytes(32)
  const control = { fail: false }
  const implementation: CredentialCipher = {
    available: () => true,
    encrypt(text) {
      if (control.fail) throw new Error('Test encryption failure')
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()])
    },
    decrypt(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(-16))
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8')
    },
  }
  return { implementation, control }
}
const profile = (id: string, host: string): HostProfile => ({ id, host, name: host, username: 'root', port: 22, authType: 'password' })

test('library metadata migrates old settings, validates limits, and persists defensive copies', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-library-'))
  try {
    const filename = path.join(directory, 'settings.json')
    await writeFile(filename, JSON.stringify({ version: 1, profiles: [], knownHosts: {} }))
    const store = new AppStore(filename); await store.load()
    assert.deepEqual(store.getLibrary(), emptyLibrary())
    await store.saveProfile({ ...profile('one', 'one.example'), autoReconnect: true, tmuxSession: 'work-1' })
    await store.saveLibraryItem('runbook', { id: 'r', name: 'Health', command: 'echo {{service}}' })
    await store.saveLibraryItem('workspace', { id: 'w', name: 'Daily', profileIds: ['one'], layout: 'split' })
    const copy = store.getLibrary(); copy.runbooks[0].command = 'mutated'
    assert.equal(store.getLibrary().runbooks[0].command, 'echo {{service}}')
    const reloaded = new AppStore(filename); await reloaded.load()
    assert.deepEqual(reloaded.getLibrary(), store.getLibrary())
    assert.equal(reloaded.listProfiles()[0].tmuxSession, 'work-1')
    assert.throws(() => validateLibraryItem('workspace', { id: 'empty', name: 'Empty', profileIds: [], layout: 'tabs' }), /1 to 20/)
    assert.throws(() => validateLibraryItem('workspace', { id: 'too-many', name: 'Large', profileIds: Array.from({ length: 21 }, (_, i) => `p${i}`), layout: 'grid' }), /1 to 20/)
    assert.throws(() => validateLibraryItem('key', { id: 'key', name: 'Relative', path: '../key' }), /absolute/)
    assert.throws(() => validateLibraryItem('toString' as 'runbook', {}), /valid/)
    assert.throws(() => validateProfile({ ...profile('one', 'one.example'), jumpHostId: 'one' }), /itself/)
    assert.throws(() => validateProfile({ ...profile('one', 'one.example'), tmuxSession: 'unsafe; command' }), /letters/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('encrypted restore is a dry preview then merges/remaps IDs, secrets, keys, and workspace references', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-backup-merge-'))
  const passphrase = 'portable encrypted backup test password'
  try {
    const source = new AppStore(path.join(directory, 'source.json'))
    const sourceCipher = cipher(), targetCipher = cipher()
    const sourceVault = new CredentialVault(path.join(directory, 'source-vault.json'), sourceCipher.implementation)
    const targetVault = new CredentialVault(path.join(directory, 'target-vault.json'), targetCipher.implementation)
    const sourceKey = path.join(directory, 'original-key')
    const { privateKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } })
    await writeFile(sourceKey, privateKey)
    const a = { ...profile('a', 'a.example'), jumpHostId: 'b' }
    const b: HostProfile = { ...profile('b', 'b.example'), authType: 'privateKey', privateKeyPath: sourceKey }
    await source.saveProfile(a); await source.saveProfile(b); await sourceVault.save(a, 'SOURCE_SERVER_SECRET')
    await source.saveLibraryItem('key', { id: 'k', name: 'Deployment', path: sourceKey })
    await source.saveLibraryItem('group', { id: 'g', group: 'Fleet', username: 'deploy', port: 2222, keyId: 'k' })
    await source.saveLibraryItem('workspace', { id: 'w', name: 'Fleet workspace', profileIds: ['a', 'b'], layout: 'split' })
    await source.saveLibraryItem('tunnel', { id: 't', name: 'DB', direction: 'local', bindPort: 15432, targetHost: 'localhost', targetPort: 5432, profileId: 'b' })
    await source.saveLibraryItem('runbook', { id: 'r', name: 'Health', command: 'uptime' })
    await source.trustFingerprint('a.example', 22, 'SHA256:SOURCE')
    const file = path.join(directory, 'portable.sshheaven')
    const sourceBackups = new BackupService(source, sourceVault, path.join(directory, 'source-keys'))
    await sourceBackups.export(file, { password: passphrase, includePasswords: true, includePrivateKeys: true, preferences: { 'ssh-heaven:theme': 'daylight', arbitrary: 'DO_NOT_INCLUDE' } })
    assert.equal((await readFile(file)).includes(Buffer.from('SOURCE_SERVER_SECRET')), false)
    const target = new AppStore(path.join(directory, 'target.json'))
    const existing = profile('a', 'existing.example'), sameEndpoint = profile('existing-b', 'b.example')
    await target.saveProfile(existing); await target.saveProfile(sameEndpoint)
    await targetVault.save(existing, 'KEEP_EXISTING_SECRET'); await targetVault.save(sameEndpoint, 'KEEP_ENDPOINT_SECRET')
    await target.saveLibraryItem('key', { id: 'k', name: 'Other key', path: path.join(directory, 'other-key') })
    await target.saveLibraryItem('workspace', { id: 'w', name: 'Existing workspace', profileIds: ['a'], layout: 'tabs' })
    await target.trustFingerprint('a.example', 22, 'SHA256:EXISTING')
    const managed = path.join(directory, 'managed-keys')
    const backups = new BackupService(target, targetVault, managed)
    const preview = await backups.preview(file, passphrase)
    assert.deepEqual({ hosts: preview.hosts, newHosts: preview.newHosts, skippedHosts: preview.skippedHosts, passwords: preview.passwords, keys: preview.keys }, { hosts: 2, newHosts: 1, skippedHosts: 1, passwords: 1, keys: 1 })
    assert.equal(JSON.stringify(preview).includes('SOURCE_SERVER_SECRET'), false)
    assert.equal(target.listProfiles().length, 2)
    await assert.rejects(readdir(managed), { code: 'ENOENT' })
    const restored = await backups.restore(preview.token)
    assert.equal(restored.hosts, 1); assert.equal(restored.keys, 1); assert.equal(restored.skippedHosts, 1)
    assert.deepEqual(restored.preferences, { 'ssh-heaven:theme': 'daylight' })
    const imported = target.listProfiles().find((item) => item.host === 'a.example')!
    assert.notEqual(imported.id, 'a'); assert.equal(imported.jumpHostId, 'existing-b')
    assert.equal(await targetVault.get(imported), 'SOURCE_SERVER_SECRET')
    assert.equal(await targetVault.get(existing), 'KEEP_EXISTING_SECRET')
    assert.equal(await targetVault.get(sameEndpoint), 'KEEP_ENDPOINT_SECRET')
    const library = target.getLibrary()
    const importedKey = library.keys.find((item) => item.name === 'Deployment')!
    assert.notEqual(importedKey.id, 'k'); assert.equal(path.dirname(importedKey.path), managed)
    assert.equal(await readFile(importedKey.path, 'utf8'), privateKey)
    assert.equal(library.groupDefaults[0].keyId, importedKey.id)
    assert.deepEqual(library.workspaces.find((item) => item.name === 'Fleet workspace')?.profileIds, [imported.id, 'existing-b'])
    assert.equal(library.tunnelRules[0].profileId, 'existing-b')
    assert.equal(target.getFingerprint('a.example', 22), 'SHA256:EXISTING')
    const repeated = await backups.restore((await backups.preview(file, passphrase)).token)
    assert.equal(repeated.hosts, 0); assert.equal(repeated.keys, 0)
    assert.equal(target.getLibrary().keys.length, 2); assert.equal(target.getLibrary().workspaces.length, 2)
    await assert.rejects(backups.restore(preview.token), /expired/)
    await assert.rejects(backups.preview(file, 'incorrect backup password'), /incorrect|damaged/)
    backups.dispose(); sourceBackups.dispose()
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('restore encryption failure rolls back metadata and newly created private keys', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-backup-rollback-'))
  try {
    const source = new AppStore(path.join(directory, 'source.json')), target = new AppStore(path.join(directory, 'target.json'))
    const sourceCipher = cipher(), targetCipher = cipher()
    const sourceVault = new CredentialVault(path.join(directory, 'source-vault.json'), sourceCipher.implementation)
    const targetVault = new CredentialVault(path.join(directory, 'target-vault.json'), targetCipher.implementation)
    const p = profile('source', 'server.example')
    await source.saveProfile(p); await sourceVault.save(p, 'SECRET')
    const key = path.join(directory, 'key'); await writeFile(key, 'PRIVATE_KEY_TEST_BYTES')
    await source.saveLibraryItem('key', { id: 'key', name: 'Key', path: key })
    const file = path.join(directory, 'backup')
    await new BackupService(source, sourceVault, path.join(directory, 'source-keys')).export(file, { password: 'strong portable passphrase', includePasswords: true, includePrivateKeys: true, preferences: {} })
    const managed = path.join(directory, 'managed')
    const backups = new BackupService(target, targetVault, managed)
    const preview = await backups.preview(file, 'strong portable passphrase')
    targetCipher.control.fail = true
    await assert.rejects(backups.restore(preview.token), /encryption failure/)
    assert.deepEqual(target.listProfiles(), []); assert.deepEqual(target.getLibrary(), emptyLibrary()); assert.deepEqual(await readdir(managed), [])
    targetCipher.control.fail = false
    assert.equal((await backups.restore(preview.token)).hosts, 1)
    assert.equal(await targetVault.get(p), 'SECRET')
    const orphanStore = new AppStore(path.join(directory, 'orphan-settings.json'))
    const orphanVault = new CredentialVault(path.join(directory, 'orphan-vault.json'), cipher().implementation)
    await orphanVault.save(p, 'PRESERVE_EXISTING_ORPHAN')
    const orphanBackups = new BackupService(orphanStore, orphanVault, path.join(directory, 'orphan-managed'))
    const orphanPreview = await orphanBackups.preview(file, 'strong portable passphrase')
    await assert.rejects(orphanBackups.restore(orphanPreview.token), /already exists/)
    assert.deepEqual(orphanStore.listProfiles(), [])
    assert.equal(await orphanVault.get(p), 'PRESERVE_EXISTING_ORPHAN', 'A rejected credential commit must not delete a pre-existing vault entry')
    orphanBackups.dispose()
    backups.dispose()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
