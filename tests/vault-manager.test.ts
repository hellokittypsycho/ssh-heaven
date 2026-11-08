import assert from 'node:assert/strict'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CredentialVault, type CredentialCipher } from '../electron/credentials'
import { AppStore } from '../electron/store'
import { VaultManager } from '../electron/vault-manager'
import type { HostProfile, VaultState } from '../shared/types'

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-pin-vault-'))
  const key = randomBytes(32)
  const hooks: { encrypt?: (text: string) => Promise<void>; decrypt?: (text: string) => Promise<void> } = {}
  let available = true, clipboard = '', now = Date.now()
  const cipher: CredentialCipher = {
    available: () => available,
    encrypt() { throw new Error('Test cipher not initialized.') },
    async decrypt(bytes) {
      const decryptor = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decryptor.setAuthTag(bytes.subarray(12, 28))
      const text = Buffer.concat([decryptor.update(bytes.subarray(28)), decryptor.final()]).toString('utf8')
      await hooks.decrypt?.(text)
      return text
    }
  }
  cipher.encrypt = async (text) => {
    await hooks.encrypt?.(text)
    const iv = randomBytes(12), encryptor = createCipheriv('aes-256-gcm', key, iv)
    const bytes = Buffer.concat([encryptor.update(text, 'utf8'), encryptor.final()])
    return Buffer.concat([iv, encryptor.getAuthTag(), bytes])
  }
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const profile: HostProfile = { id: 'vault-host', name: 'Vault host', host: 'fixture.invalid', port: 22, username: 'demo', authType: 'password' }
  await store.saveProfile(profile)
  const vault = new CredentialVault(path.join(directory, 'credentials.json'), cipher)
  await vault.load(); await vault.save(profile, 'saved-server-password')
  const filename = path.join(directory, 'vault-lock.json')
  const allowed = new Set<string>(), states: { owner: number; state: VaultState }[] = []
  const managers: VaultManager[] = []
  const create = async () => {
    const manager = new VaultManager(filename, { store, vault, cipher, keyAllowed: (name) => allowed.has(name), clipboard: { readText: async () => clipboard, writeText: async (value) => { clipboard = value } }, onState: (owner, state) => states.push({ owner, state }), clock: () => now, clipboardTimeoutMs: 25 })
    await manager.load(); managers.push(manager); return manager
  }
  const manager = await create()
  return { directory, filename, manager, create, store, vault, cipher, profile, hooks, allowed, states,
    available(value: boolean) { available = value }, advance(milliseconds: number) { now += milliseconds }, now: () => now,
    clipboard: () => clipboard, setClipboard(value: string) { clipboard = value },
    async close() { await Promise.all(managers.map((manager) => manager.dispose())); await rm(directory, { recursive: true, force: true }) }
  }
}
function latch() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const waiting = new Promise<void>((resolve) => { release = resolve })
  return { entered, release, async hold() { enter(); await waiting } }
}

test('vault management requires a five-digit PIN, uses encrypted salted verification, and scopes unlocks to one owner while quick-connect remains available', async () => {
  const h = await fixture()
  try {
    assert.equal(h.manager.getState(1).pinEnabled, false)
    await assert.rejects(h.manager.snapshot(1), /Unlock/)
    assert.equal(await h.vault.get(h.profile), 'saved-server-password')
    for (const pin of ['1234', '123456', '１２３４５', '12a45', '1234\n', '12345\n', '12345\r\n']) await assert.rejects(async () => h.manager.setup(1, pin), /five digits/)
    const state = await h.manager.setup(1, '12345')
    assert.equal(state.pinEnabled, true); assert.equal(state.unlocked, true)
    assert.equal(h.manager.getState(2).unlocked, false)
    await assert.rejects(h.manager.revealPassword(2, h.profile.id), /Unlock/)
    const snapshot = await h.manager.snapshot(1)
    assert.deepEqual(snapshot.passwordProfileIds, [h.profile.id])
    assert.equal(JSON.stringify(snapshot).includes('saved-server-password'), false)
    assert.equal(await h.manager.revealPassword(1, h.profile.id), 'saved-server-password')
    const persisted = await readFile(h.filename, 'utf8')
    assert.equal(persisted.includes('12345'), false)
    assert.equal(persisted.includes('salt'), false)
    assert.equal(persisted.includes('hash'), false)
    h.manager.lock(1)
    const restarted = await h.create()
    assert.equal(restarted.getState(1).unlocked, false)
    assert.equal((await restarted.unlock(1, '12345')).unlocked, true)
    assert.equal(await h.vault.get(h.profile), 'saved-server-password')
  } finally { await h.close() }
})

test('failed PIN counters and escalating lockouts survive restarts and correct PINs cannot bypass an active lockout', async () => {
  const h = await fixture()
  try {
    await h.manager.setup(1, '12345'); h.manager.lock()
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(h.manager.unlock(1, '00000'), /Incorrect|temporarily locked/)
    assert.equal(h.manager.getState(1).remainingAttempts, 0)
    assert.equal(h.manager.getState(1).lockedUntil, h.now() + 30_000)
    const restarted = await h.create()
    assert.equal(restarted.getState(1).lockedUntil, h.now() + 30_000)
    await assert.rejects(restarted.unlock(1, '12345'), /lockout/)
    h.advance(30_001)
    assert.equal(restarted.getState(1).remainingAttempts, 5)
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(restarted.unlock(1, '00000'), /Incorrect|temporarily locked/)
    assert.equal(restarted.getState(1).lockedUntil, h.now() + 60_000)
    h.advance(60_001)
    assert.equal((await restarted.unlock(1, '12345')).unlocked, true)
    assert.equal(restarted.getState(1).remainingAttempts, 5)
  } finally { await h.close() }
})

test('PIN changes/disabling require an unlocked owner and correct current PIN; timeout and lock invalidate in-flight unlocks', async () => {
  const h = await fixture()
  try {
    await h.manager.setup(1, '12345')
    h.advance(5 * 60_000 + 1)
    assert.equal(h.manager.getState(1).unlocked, false)
    await assert.rejects(h.manager.changePin(1, '12345', '67890'), /Unlock/)
    await h.manager.unlock(1, '12345')
    await assert.rejects(h.manager.changePin(1, '00000', '67890'), /Incorrect/)
    await h.manager.changePin(1, '12345', '67890')
    h.manager.lock()
    await assert.rejects(h.manager.unlock(1, '12345'), /Incorrect/)
    await h.manager.unlock(1, '67890')
    await assert.rejects(h.manager.disablePin(1, '00000'), /Incorrect/)
    await h.manager.disablePin(1, '67890')
    assert.equal(h.manager.getState(1).pinEnabled, false)
    await assert.rejects(h.manager.snapshot(1), /Unlock/)
    await h.manager.setup(1, '12345'); h.manager.lock()
    const pending = h.manager.unlock(1, '12345')
    h.manager.lock(1)
    await assert.rejects(pending, /locked while/)
    assert.equal(h.manager.getState(1).unlocked, false)
  } finally { await h.close() }
})

test('locking during secret decrypt or password encryption prevents reveal/update; endpoint changes also reject stale password updates', async () => {
  const h = await fixture()
  try {
    await h.manager.setup(1, '12345')
    const reading = latch()
    h.hooks.decrypt = (text) => text === 'saved-server-password' ? reading.hold() : Promise.resolve()
    const reveal = h.manager.revealPassword(1, h.profile.id)
    await reading.entered; h.manager.lock(1); reading.release()
    await assert.rejects(reveal, /Unlock|locked/)
    h.hooks.decrypt = undefined
    await h.manager.unlock(1, '12345')
    const writing = latch()
    h.hooks.encrypt = (text) => text === 'replacement-password' ? writing.hold() : Promise.resolve()
    const save = h.manager.savePassword(1, h.profile.id, 'replacement-password')
    await writing.entered; h.manager.lock(1); writing.release()
    await assert.rejects(save, /Unlock|locked/)
    assert.equal(await h.vault.get(h.profile), 'saved-server-password')
    h.hooks.encrypt = undefined
    await h.manager.unlock(1, '12345')
    const changed = latch()
    h.hooks.encrypt = (text) => text === 'stale-password' ? changed.hold() : Promise.resolve()
    const stale = h.manager.savePassword(1, h.profile.id, 'stale-password')
    await changed.entered
    const updated = await h.store.saveProfile({ ...h.profile, host: 'new-target.invalid' })
    changed.release()
    await assert.rejects(stale, /host changed/)
    assert.equal(await h.vault.get(updated), undefined)
    assert.equal(await h.vault.get(h.profile), 'saved-server-password')
  } finally { await h.close() }
})

test('guarded credential commits and forgets cannot publish canceled encrypted temporary writes', async () => {
  const h = await fixture()
  try {
    const prepared = await h.vault.prepare([{ profile: h.profile, password: 'canceled-replacement' }])
    let checks = 0
    await assert.rejects(h.vault.commitPrepared(prepared, false, true, () => { if (++checks === 2) throw new Error('Vault locked before rename.') }), /locked before rename/)
    assert.equal(await h.vault.get(h.profile), 'saved-server-password')
    checks = 0
    await assert.rejects(h.vault.forget(h.profile.id, () => { if (++checks === 2) throw new Error('Vault locked before rename.') }), /locked before rename/)
    assert.equal(await h.vault.get(h.profile), 'saved-server-password')
    assert.equal((await readdir(h.directory)).some((name) => name.endsWith('.tmp')), false)
  } finally { await h.close() }
})

test('native password clipboard copies clear only their owned value; key metadata never deletes or reveals private key files', async () => {
  const h = await fixture()
  try {
    await h.manager.setup(1, '12345')
    await h.manager.copyPassword(1, h.profile.id)
    assert.equal(h.clipboard(), 'saved-server-password')
    h.setClipboard('the user copied something else')
    await new Promise((resolve) => setTimeout(resolve, 75))
    assert.equal(h.clipboard(), 'the user copied something else')
    await h.manager.copyPassword(1, h.profile.id)
    await new Promise((resolve) => setTimeout(resolve, 75))
    assert.equal(h.clipboard(), '')
    await h.manager.copyPassword(1, h.profile.id)
    h.manager.lock(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(h.clipboard(), '')
    await h.manager.unlock(1, '12345')
    const key = path.join(h.directory, 'my-key')
    await writeFile(key, 'private-key-content-kept-on-disk')
    await assert.rejects(h.manager.saveKey(1, { id: 'key-one', name: 'My key', path: key }), /native file picker/)
    h.allowed.add(key)
    await h.manager.saveKey(1, { id: 'key-one', name: 'My key', path: key })
    const snapshot = await h.manager.snapshot(1)
    assert.equal(snapshot.keys[0].available, true)
    assert.equal(JSON.stringify(snapshot).includes('private-key-content-kept-on-disk'), false)
    await h.manager.deleteKey(1, 'key-one')
    assert.equal(await readFile(key, 'utf8'), 'private-key-content-kept-on-disk')
    await h.manager.savePassword(1, h.profile.id, 'updated-password')
    assert.equal(await h.manager.revealPassword(1, h.profile.id), 'updated-password')
    await h.manager.forgetPassword(1, h.profile.id)
    assert.equal(await h.vault.get(h.profile), undefined)
  } finally { await h.close() }
})

test('corrupt protected PIN state and unavailable OS encryption fail closed without damaging quick-connect credentials', async () => {
  const h = await fixture()
  try {
    await h.manager.setup(1, '12345')
    await writeFile(h.filename, '{corrupt')
    const corrupted = await h.create()
    assert.equal(corrupted.getState(1).pinEnabled, true)
    assert.match(corrupted.getState(1).error!, /could not be unlocked/)
    await assert.rejects(corrupted.setup(1, '67890'), /could not be unlocked/)
    await assert.rejects(corrupted.snapshot(1), /could not be unlocked/)
    assert.equal(await h.vault.get(h.profile), 'saved-server-password')
    h.available(false)
    await assert.rejects(h.manager.revealPassword(1, h.profile.id), /unavailable/)
    assert.equal(h.manager.getState(1).available, false)
    assert.equal(h.manager.getState(1).unlocked, false)
  } finally { await h.close() }
})

test('a manual/minimize lock during the atomic PIN-change rename cannot reopen the manager when that request finishes', async () => {
  const h = await fixture()
  const originalRename = fs.rename
  try {
    await h.manager.setup(1, '12345')
    let intercepted = false
    fs.rename = async (source, destination) => {
      await originalRename(source, destination)
      if (destination === h.filename) { intercepted = true; h.manager.lock(1) }
    }
    syncBuiltinESMExports()
    await assert.rejects(h.manager.changePin(1, '12345', '67890'), /Unlock|locked/)
    assert.equal(intercepted, true)
    assert.equal(h.manager.getState(1).unlocked, false)
    await assert.rejects(h.manager.snapshot(1), /Unlock/)
  } finally {
    fs.rename = originalRename; syncBuiltinESMExports()
    await h.close()
  }
})

test('external key-view guards belong to the exact unlocked owner grant and cannot revive after locking and unlocking again', async () => {
  const h = await fixture()
  try {
    assert.throws(() => h.manager.authorizeRequest(1), /Unlock/)
    await h.manager.setup(1, '12345')
    const guard = h.manager.authorizeRequest(1)
    assert.doesNotThrow(guard)
    assert.throws(() => h.manager.authorizeRequest(2), /Unlock/)
    h.manager.lock(1)
    assert.throws(guard, /Unlock|locked/)
    await h.manager.unlock(1, '12345')
    assert.throws(guard, /locked/)
    const fresh = h.manager.authorizeRequest(1)
    assert.doesNotThrow(fresh)
    h.advance(5 * 60_000 + 1)
    assert.throws(fresh, /Unlock|locked/)
  } finally { await h.close() }
})
