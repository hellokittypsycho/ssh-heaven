import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CredentialVault, type CredentialCipher } from '../electron/credentials'
import { SshService } from '../electron/ssh-service'
import { AppStore } from '../electron/store'
import type { HostProfile } from '../shared/types'
import { startFixture } from './fixture'

function codec() {
  const key = randomBytes(32)
  let available = true
  const cipher: CredentialCipher = {
    available: () => available,
    encrypt(plaintext) {
      const iv = randomBytes(12)
      const encryptor = createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([encryptor.update(plaintext, 'utf8'), encryptor.final()])
      return Buffer.concat([iv, encryptor.getAuthTag(), encrypted])
    },
    decrypt(encrypted) {
      const decryptor = createDecipheriv('aes-256-gcm', key, encrypted.subarray(0, 12))
      decryptor.setAuthTag(encrypted.subarray(12, 28))
      return Buffer.concat([decryptor.update(encrypted.subarray(28)), decryptor.final()]).toString('utf8')
    }
  }
  return { cipher, setAvailable(value: boolean) { available = value } }
}

const profile: HostProfile = { id: 'saved-host', name: 'My server', host: 'server.example.test', port: 22, username: 'deploy', authType: 'password' }

test('encrypted credentials persist without plaintext and stay bound to the saved host identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-vault-'))
  try {
    const filename = path.join(directory, 'credentials.json')
    const secure = codec()
    const vault = new CredentialVault(filename, secure.cipher)
    await vault.load()
    const password = 'Password-is-only-in-the-OS-encrypted-vault-你好-92742'
    await vault.save(profile, password)
    const source = await readFile(filename, 'utf8')
    assert.equal(source.includes(password), false)
    assert.equal(source.includes(Buffer.from(password).toString('base64')), false)
    const restored = new CredentialVault(filename, secure.cipher)
    await restored.load()
    assert.deepEqual(await restored.status([profile]), { available: true, profileIds: [profile.id] })
    assert.equal(await restored.get({ ...profile, name: 'Renamed host', group: 'Production', favorite: true }), password)
    assert.equal(await restored.get({ ...profile, host: profile.host.toUpperCase() }), password)
    for (const changed of [
      { ...profile, host: 'other.example.test' }, { ...profile, port: 2222 },
      { ...profile, username: 'root' }, { ...profile, authType: 'privateKey' as const }, { ...profile, id: 'another-host' }
    ]) {
      assert.equal(await restored.get(changed), undefined, 'A saved password must never reach a different endpoint/user/authentication identity')
      assert.deepEqual((await restored.status([changed])).profileIds, [])
    }
    await restored.reconcile([{ ...profile, host: 'other.example.test' }])
    const invalidated = new CredentialVault(filename, secure.cipher)
    await invalidated.load()
    assert.equal(await invalidated.get(profile), undefined)
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')).entries, {})
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('unavailable secure storage disables saving and retrieval while forgetting still removes encrypted data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-vault-unavailable-'))
  try {
    const filename = path.join(directory, 'credentials.json')
    const secure = codec()
    const vault = new CredentialVault(filename, secure.cipher)
    await vault.load()
    await vault.save(profile, 'Remembered locally')
    secure.setAvailable(false)
    assert.deepEqual(await vault.status([profile]), { available: false, profileIds: [] })
    await assert.rejects(vault.get(profile), /unavailable/)
    await assert.rejects(vault.save(profile, 'Never write plaintext as a fallback'), /unavailable/)
    await vault.forget(profile.id)
    secure.setAvailable(true)
    assert.equal(await vault.get(profile), undefined)
    const restored = new CredentialVault(filename, secure.cipher)
    await restored.load()
    assert.deepEqual((await restored.status([profile])).profileIds, [])
    await vault.save(profile, '')
    assert.equal(await vault.get(profile), '', 'Empty successful passwords are represented without confusing them with a missing credential')
    await vault.reconcile([])
    assert.equal(await vault.get(profile), undefined, 'Deleting a saved profile invalidates its credential')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('remembering a password runs only after successful SSH authentication and before connected status', { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-vault-auth-'))
  const fixture = await startFixture()
  const saved: HostProfile = { ...profile, host: fixture.host, port: fixture.port, username: fixture.username }
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  await store.saveProfile(saved)
  const vault = new CredentialVault(path.join(directory, 'credentials.json'), codec().cipher)
  await vault.load()
  let authenticated = 0
  let connected = false
  const service = new SshService(store, {
    data() {},
    hostKey(owner, challenge) { queueMicrotask(() => service.resolveHostKey(owner, challenge.requestId, true)) },
    status(eventOwner, event) {
      assert.equal(eventOwner, 501)
      if (event.status === 'connected') { connected = true; assert.equal(authenticated, 1) }
    }
  })
  try {
    await assert.rejects(service.connect({ sessionId: 'bad-password', profile: saved, password: 'incorrect' }, 501, async () => { authenticated++; await vault.save(saved, 'incorrect') }), /authentication/i)
    assert.equal(authenticated, 0)
    assert.deepEqual((await vault.status([saved])).profileIds, [])
    await service.connect({ sessionId: 'good-password', profile: saved, password: fixture.password }, 501, async () => { authenticated++; await vault.save(saved, fixture.password) })
    assert.equal(connected, true)
    assert.equal(await vault.get(saved), fixture.password)
    assert.equal((await readFile(path.join(directory, 'settings.json'), 'utf8')).includes(fixture.password), false)
    assert.equal((await readFile(path.join(directory, 'credentials.json'), 'utf8')).includes(fixture.password), false)
  } finally {
    service.dispose()
    await fixture.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('stale credential reconciliation cannot delete a newly imported credential after its pending protection is released', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-vault-reconcile-race-'))
  try {
    const secure = codec()
    const filename = path.join(directory, 'credentials.json')
    const vault = new CredentialVault(filename, secure.cipher)
    await vault.load()
    await vault.save(profile, 'Obsolete credential')
    const imported: HostProfile = { ...profile, id: 'newly-imported-host', host: 'new.example.test' }
    const prepared = await vault.prepare([{ profile: imported, password: 'NEW_IMPORTED_SECRET' }])
    const commit = vault.commitPrepared(prepared, true, false)
    // All three operations use the public API. The intervening disk mutation
    // makes the stale reconciliation execute after import protection releases.
    const intervening = vault.forget('unrelated-host')
    const staleReconcile = vault.reconcile([])
    await commit
    vault.releasePrepared([imported.id])
    await Promise.all([intervening, staleReconcile])
    assert.equal(await vault.get(profile), undefined, 'The old obsolete candidate should still be removed')
    assert.equal(await vault.get(imported), 'NEW_IMPORTED_SECRET', 'An earlier profile snapshot must not remove a newer imported credential')
    const restored = new CredentialVault(filename, secure.cipher)
    await restored.load()
    assert.equal(await restored.get(imported), 'NEW_IMPORTED_SECRET')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
