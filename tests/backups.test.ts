import assert from 'node:assert/strict'
import test from 'node:test'
import { decryptBackup, encryptBackup } from '../electron/backups'

const passphrase = 'portable backup test passphrase'
const payload = { version: 1, profiles: [{ id: 'profile', host: 'vps.example', name: 'Production' }], passwords: { profile: 'SECRET_SERVER_PASSWORD' }, privateKeys: [{ id: 'key', contents: 'SECRET_PRIVATE_KEY_MATERIAL' }], preferences: { theme: 'daylight' } }

test('portable backups encrypt all metadata/secrets and use distinct random envelopes', { timeout: 15_000 }, async () => {
  const first = await encryptBackup(payload, passphrase)
  const second = await encryptBackup(payload, passphrase)
  assert.notDeepEqual(first, second)
  assert.equal(first.includes(Buffer.from('vps.example')), false)
  assert.equal(first.includes(Buffer.from('SECRET_SERVER_PASSWORD')), false)
  assert.equal(first.includes(Buffer.from('SECRET_PRIVATE_KEY_MATERIAL')), false)
  assert.deepEqual(await decryptBackup(first, passphrase), payload)
})

test('portable backups reject wrong passphrases and ciphertext/tag/header tampering', { timeout: 20_000 }, async () => {
  const encrypted = await encryptBackup(payload, passphrase)
  await assert.rejects(decryptBackup(encrypted, 'an incorrect backup passphrase'), /incorrect|damaged/)
  for (const index of [35, 50, encrypted.length - 1]) {
    const altered = Buffer.from(encrypted)
    altered[index] ^= 1
    await assert.rejects(decryptBackup(altered, passphrase), /incorrect|damaged/)
  }
  const alteredHeader = Buffer.from(encrypted)
  alteredHeader[0] ^= 1
  await assert.rejects(decryptBackup(alteredHeader, passphrase), /supported/)
  await assert.rejects(decryptBackup(encrypted.subarray(0, 30), passphrase), /valid/)
})

test('portable backups require a substantial passphrase without silently changing Unicode', { timeout: 10_000 }, async () => {
  await assert.rejects(encryptBackup(payload, 'short'), /12/)
  const unicode = 'café ☁ backup passphrase'
  const encrypted = await encryptBackup(payload, unicode)
  assert.deepEqual(await decryptBackup(encrypted, unicode), payload)
  await assert.rejects(decryptBackup(encrypted, unicode.normalize('NFD')), /incorrect|damaged/)
})
