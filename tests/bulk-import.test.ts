import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BulkImportService } from '../electron/bulk-import'
import { CredentialVault, type CredentialCipher } from '../electron/credentials'
import { AppStore } from '../electron/store'
import type { HostProfile } from '../shared/types'

function cipher(options: { available?: boolean; failPassword?: string } = {}): CredentialCipher {
  const key = randomBytes(32)
  return {
    available: () => options.available !== false,
    encrypt(password) {
      if (password === options.failPassword) throw new Error('Encryption unavailable for this entry')
      const iv = randomBytes(12)
      const encryption = createCipheriv('aes-256-gcm', key, iv)
      const content = Buffer.concat([encryption.update(password, 'utf8'), encryption.final()])
      return Buffer.concat([iv, encryption.getAuthTag(), content])
    },
    decrypt(content) {
      const decryption = createDecipheriv('aes-256-gcm', key, content.subarray(0, 12))
      decryption.setAuthTag(content.subarray(12, 28))
      return Buffer.concat([decryption.update(content.subarray(28)), decryption.final()]).toString('utf8')
    }
  }
}

test('bulk imports preserve root defaults and encrypted passwords while skipping existing hosts and duplicates', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-bulk-'))
  try {
    const store = new AppStore(path.join(directory, 'settings.json'))
    const vault = new CredentialVault(path.join(directory, 'credentials.json'), cipher())
    await store.load(); await vault.load()
    const existing: HostProfile = { id: 'existing', name: 'Preserved nickname', host: 'existing.example.test', port: 2222, username: 'root', authType: 'password', group: 'Old group' }
    await store.saveProfile(existing)
    await vault.save(existing, 'OLD_SAVED_SECRET')
    const importer = new BulkImportService(store, vault, () => false)
    const [result] = await Promise.all([
      importer.import({ text: 'alpha.example.test:alice:ALPHA_SECRET\nbeta.example.test:BETA_SECRET\nALPHA.example.test:alice:IGNORED_DUPLICATE_SECRET\nexisting.example.test:IGNORED_EXISTING_SECRET', group: 'Production', port: 2222, authType: 'password' }),
      store.recordConnection(existing)
    ])
    assert.deepEqual(result, { imported: 2, skipped: 2 })
    assert.equal(store.listProfiles().length, 3)
    assert.equal(store.listRecentHosts().length, 1, 'Concurrent history persistence must not lose the imported batch')
    const alpha = store.listProfiles().find((profile) => profile.host === 'alpha.example.test')!
    const beta = store.listProfiles().find((profile) => profile.host === 'beta.example.test')!
    assert.equal(alpha.username, 'alice'); assert.equal(beta.username, 'root')
    assert.equal(alpha.group, 'Production'); assert.equal(alpha.port, 2222)
    assert.equal(await vault.get(alpha), 'ALPHA_SECRET')
    assert.equal(await vault.get(beta), 'BETA_SECRET')
    assert.equal(await vault.get(existing), 'OLD_SAVED_SECRET')
    assert.equal(store.listProfiles().find((profile) => profile.id === existing.id)?.name, existing.name)
    const source = `${await readFile(path.join(directory, 'settings.json'), 'utf8')}\n${await readFile(path.join(directory, 'credentials.json'), 'utf8')}`
    assert.equal(source.includes('SECRET'), false, 'No imported password may reach a plaintext settings file')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('bulk validation and encryption failures commit no partial hosts or credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-bulk-failure-'))
  try {
    const store = new AppStore(path.join(directory, 'settings.json'))
    const vault = new CredentialVault(path.join(directory, 'credentials.json'), cipher({ failPassword: 'FAIL_ENCRYPT' }))
    await store.load(); await vault.load()
    const importer = new BulkImportService(store, vault, () => false)
    await assert.rejects(importer.import({ text: 'valid.example.test:FIRST_SECRET\nnot a host:SECOND_SECRET', port: 22, authType: 'password' }), /Fix the import errors/)
    await assert.rejects(importer.import({ text: 'first.example.test:FIRST_SECRET\nsecond.example.test:FAIL_ENCRYPT', port: 22, authType: 'password' }), /Encryption unavailable/)
    assert.deepEqual(store.listProfiles(), [])
    assert.deepEqual((await vault.status([])).profileIds, [])
    await assert.rejects(readFile(path.join(directory, 'credentials.json')), /ENOENT/)
    const unavailable = new BulkImportService(store, new CredentialVault(path.join(directory, 'other-vault.json'), cipher({ available: false })), () => false)
    await assert.rejects(unavailable.import({ text: 'first.example.test:FIRST_SECRET', port: 22, authType: 'password' }), /unavailable/)
    assert.deepEqual(store.listProfiles(), [])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('metadata commit failure rolls back only newly imported encrypted credentials', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-bulk-rollback-'))
  try {
    class FailingStore extends AppStore { override async importProfiles(): Promise<HostProfile[]> { throw new Error('Simulated metadata write failure') } }
    const store = new FailingStore(path.join(directory, 'settings.json'))
    const vault = new CredentialVault(path.join(directory, 'credentials.json'), cipher())
    await store.load(); await vault.load()
    const existing: HostProfile = { id: 'existing', name: 'Existing', host: 'existing.example.test', port: 22, username: 'root', authType: 'password' }
    await store.saveProfile(existing); await vault.save(existing, 'EXISTING_SECRET')
    const importer = new BulkImportService(store, vault, () => false)
    await assert.rejects(importer.import({ text: 'new.example.test:NEW_SECRET', port: 22, authType: 'password' }), /metadata write failure/)
    assert.deepEqual(store.listProfiles(), [existing])
    assert.equal(await vault.get(existing), 'EXISTING_SECRET')
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(directory, 'credentials.json'), 'utf8')).entries), [existing.id])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('shared-key bulk import needs a selected regular key and discards every unused password', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-bulk-key-'))
  try {
    const key = path.join(directory, 'selected-key')
    await writeFile(key, 'PRIVATE KEY FILE IS REFERENCED, NEVER COPIED INTO SETTINGS')
    const store = new AppStore(path.join(directory, 'settings.json'))
    const vault = new CredentialVault(path.join(directory, 'credentials.json'), cipher({ available: false }))
    await store.load(); await vault.load()
    const unapproved = new BulkImportService(store, vault, () => false)
    await assert.rejects(unapproved.import({ text: 'first.example.test', port: 22, authType: 'privateKey', privateKeyPath: key }), /file picker/)
    const importer = new BulkImportService(store, vault, (filename) => filename === key)
    assert.deepEqual(await importer.import({ text: 'first.example.test\nsecond.example.test:deploy:DISCARDED_SECRET', port: 2222, group: 'Key hosts', authType: 'privateKey', privateKeyPath: key }), { imported: 2, skipped: 0 })
    assert.ok(store.listProfiles().every((profile) => profile.authType === 'privateKey' && profile.privateKeyPath === key && profile.group === 'Key hosts'))
    assert.deepEqual(store.listProfiles().map((profile) => profile.username), ['root', 'deploy'])
    assert.equal((await readFile(path.join(directory, 'settings.json'), 'utf8')).includes('DISCARDED_SECRET'), false)
    await assert.rejects(readFile(path.join(directory, 'credentials.json')), /ENOENT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('valid long hostnames import with a bounded nickname while preserving the full connection address', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-bulk-long-host-'))
  try {
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.example.test`
    const store = new AppStore(path.join(directory, 'settings.json'))
    const vault = new CredentialVault(path.join(directory, 'credentials.json'), cipher())
    await store.load(); await vault.load()
    const importer = new BulkImportService(store, vault, () => false)
    assert.deepEqual(await importer.import({ text: `${host}:LONG_HOST_SECRET`, port: 22, authType: 'password' }), { imported: 1, skipped: 0 })
    const profile = store.listProfiles()[0]
    assert.equal(profile.host, host)
    assert.equal(profile.name.length, 100)
    assert.equal(profile.name, host.slice(0, 100))
    assert.equal(await vault.get(profile), 'LONG_HOST_SECRET')
    const restored = new AppStore(path.join(directory, 'settings.json'))
    await restored.load()
    assert.equal(restored.listProfiles()[0].host, host)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
