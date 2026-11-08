import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import ssh2 from 'ssh2'
import { generateKeyFiles } from '../electron/keygen'
import { ManagedKeyService, MAX_PRIVATE_KEY_BYTES, validateManagedKeyRequest } from '../electron/managed-keys'

const sshModulePath = createRequire(import.meta.url).resolve('ssh2')
const password = 'A private SSH key password for this fixture.'
const executeFile = promisify(execFile)

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-managed-key-'))
  const managed = path.join(directory, 'ssh-keys')
  const service = new ManagedKeyService(managed, sshModulePath)
  return { directory, managed, service, close: () => rm(directory, { recursive: true, force: true }) }
}
function latch() {
  let enter!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  return { entered, enter }
}

test('managed keys require a nonblank 12-character password while legacy key exports remain optional', () => {
  for (const passphrase of [undefined, '', 'short', ' '.repeat(12), '🔑'.repeat(6), 'x'.repeat(8193), `long-key-password\0`]) {
    assert.throws(() => validateManagedKeyRequest({ type: 'ed25519', passphrase }), /12 characters|8192/)
  }
  assert.equal(validateManagedKeyRequest({ type: 'rsa', passphrase: '🔑'.repeat(12) }).type, 'rsa')
  assert.equal(validateManagedKeyRequest({ type: 'ed25519', passphrase: 'one long password' }).passphrase, 'one long password')
})

test('managed Ed25519 keys use unique app-owned filenames, encrypted OpenSSH bytes, and private directory/file permissions', { timeout: 30_000 }, async () => {
  const h = await fixture()
  try {
    const key = await h.service.generate({ type: 'ed25519', comment: 'Managed identity', passphrase: password })
    assert.equal(path.dirname(key.privateKeyPath), h.managed)
    assert.match(path.basename(key.privateKeyPath), /^ed25519-[a-f0-9-]{36}$/)
    assert.equal(h.service.isManagedPath(key.privateKeyPath), true)
    for (const filename of [key.publicKeyPath, h.managed, path.join(h.directory, path.basename(key.privateKeyPath)), path.join(h.managed, 'nested', path.basename(key.privateKeyPath)), 'ed25519-key']) assert.equal(h.service.isManagedPath(filename), false)
    const original = await readFile(key.privateKeyPath, 'utf8')
    assert.match(original, /^-----BEGIN OPENSSH PRIVATE KEY-----/)
    assert.ok(ssh2.utils.parseKey(original) instanceof Error)
    const parsed = ssh2.utils.parseKey(original, password)
    if (parsed instanceof Error) throw parsed
    assert.equal(parsed.isPrivateKey(), true)
    assert.equal(parsed.comment, 'Managed identity')
    assert.equal(await readFile(key.publicKeyPath, 'utf8'), `${key.publicKey}\n`)
    assert.equal(JSON.stringify(key).includes(password), false)
    assert.equal(JSON.stringify(key).includes('PRIVATE KEY'), false)
    if (process.platform === 'win32') {
      const { stdout } = await executeFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [h.managed], { windowsHide: true })
      assert.equal(stdout.includes('(I)'), false, 'The managed directory must not inherit other accounts\' folder access')
      assert.equal((stdout.match(/:\(OI\)\(CI\)\(F\)/g) ?? []).length, 1, 'Only the current user receives inherited managed-folder access')
    } else {
      assert.equal((await stat(h.managed)).mode & 0o777, 0o700)
      assert.equal((await stat(key.privateKeyPath)).mode & 0o777, 0o600)
    }
    const second = await h.service.generate({ type: 'rsa', passphrase: password })
    assert.notEqual(second.privateKeyPath, key.privateKeyPath)
    assert.equal(h.service.isManagedPath(second.privateKeyPath), true)
    const parsedRsa = ssh2.utils.parseKey(await readFile(second.privateKeyPath, 'utf8'), password)
    if (parsedRsa instanceof Error) throw parsedRsa
    assert.equal(createPublicKey(parsedRsa.getPublicPEM()).asymmetricKeyDetails?.modulusLength, 3072)
    assert.equal(await readFile(key.privateKeyPath, 'utf8'), original)
    assert.equal((await readdir(h.managed)).length, 4)
  } finally { await h.close() }
})

test('viewing checks the password on every request, returns interoperable decrypted PEM, and never changes the stored encrypted pair', { timeout: 30_000 }, async () => {
  const h = await fixture()
  try {
    const key = await h.service.generate({ type: 'ed25519', passphrase: password })
    const original = await readFile(key.privateKeyPath)
    const result = await h.service.view(key.privateKeyPath, password, () => {})
    assert.equal(result.publicKey, key.publicKey)
    assert.match(result.privateKey, /^-----BEGIN PRIVATE KEY-----/)
    const privateKey = createPrivateKey(result.privateKey)
    assert.equal(privateKey.asymmetricKeyType, 'ed25519')
    const signature = sign(null, Buffer.from('A real fixture challenge'), privateKey)
    const parsedPublic = ssh2.utils.parseKey(result.publicKey)
    if (parsedPublic instanceof Error) throw parsedPublic
    assert.equal(verify(null, Buffer.from('A real fixture challenge'), createPublicKey(parsedPublic.getPublicPEM()), signature), true)
    await assert.rejects(h.service.view(key.privateKeyPath, 'Incorrect key password', () => {}), /password is incorrect/)
    assert.equal((await h.service.view(key.privateKeyPath, password, () => {})).publicKey, result.publicKey)
    assert.deepEqual(await readFile(key.privateKeyPath), original)
    assert.deepEqual((await readdir(h.managed)).sort(), [path.basename(key.privateKeyPath), path.basename(key.publicKeyPath)].sort())
  } finally { await h.close() }
})

test('imported password-encrypted RSA keys can be viewed without copying, rewriting, or registering the source file', { timeout: 30_000 }, async () => {
  const h = await fixture()
  try {
    const imported = path.join(h.directory, 'imported-rsa.pem')
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase: password }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    await writeFile(imported, pair.privateKey)
    const result = await h.service.view(imported, password, () => {})
    assert.match(result.publicKey, /^ssh-rsa /)
    assert.match(result.privateKey, /^-----BEGIN RSA PRIVATE KEY-----/)
    assert.deepEqual(createPublicKey(createPrivateKey(result.privateKey)).export({ type: 'spki', format: 'der' }), createPublicKey(pair.publicKey).export({ type: 'spki', format: 'der' }))
    assert.equal(h.service.isManagedPath(imported), false)
    assert.equal(await readFile(imported, 'utf8'), pair.privateKey)
    assert.deepEqual(await readdir(h.directory), ['imported-rsa.pem'])
  } finally { await h.close() }
})

test('the viewer fails closed for unencrypted keys, missing passwords, public keys, invalid paths, and files over 2 MiB', { timeout: 30_000 }, async () => {
  const h = await fixture()
  try {
    const plain = await generateKeyFiles({ type: 'ed25519' }, path.join(h.directory, 'legacy-unencrypted'), sshModulePath)
    await assert.rejects(h.service.view(plain.privateKeyPath, 'Any fake password', () => {}), /no password protection/)
    await assert.rejects(h.service.view(plain.publicKeyPath, password, () => {}), /no password protection/)
    for (const value of ['', 'x'.repeat(8193), `secret\0password`]) await assert.rejects(h.service.view(plain.privateKeyPath, value, () => {}), /SSH key password/)
    await assert.rejects(h.service.view('relative/key', password, () => {}), /absolute/)
    await assert.rejects(h.service.view(h.directory, password, () => {}), /regular private key/)
    await assert.rejects(h.service.view(plain.privateKeyPath, password, undefined as unknown as () => void), /Unlock the vault/)
    const tooLarge = path.join(h.directory, 'oversized')
    await writeFile(tooLarge, Buffer.alloc(MAX_PRIVATE_KEY_BYTES + 1, 65))
    await assert.rejects(h.service.view(tooLarge, password, () => {}), /2 MiB/)
    const malformed = path.join(h.directory, 'malformed')
    await writeFile(malformed, 'Not a private key')
    await assert.rejects(h.service.view(malformed, password, () => {}), /password is incorrect|unsupported/)
  } finally { await h.close() }
})

test('a vault lock during actual worker decryption prevents release, while bcrypt leaves the main event loop responsive', { timeout: 30_000 }, async () => {
  const h = await fixture()
  try {
    const key = await h.service.generate({ type: 'ed25519', passphrase: password })
    const decrypting = latch()
    let allowed = true, checks = 0
    const pending = h.service.view(key.privateKeyPath, password, () => {
      if (!allowed) throw new Error('The vault was locked during key viewing.')
      if (++checks === 2) decrypting.enter()
    })
    const rejected = assert.rejects(pending, /vault was locked/)
    await decrypting.entered
    const race = await Promise.race([pending.then(() => 'finished', () => 'finished'), new Promise<string>((resolve) => setTimeout(() => resolve('timer'), 5))])
    assert.equal(race, 'timer', 'bcrypt must run in a worker so terminal input can continue')
    allowed = false
    await rejected
    assert.ok(ssh2.utils.parseKey(await readFile(key.privateKeyPath)) instanceof Error)
  } finally { await h.close() }
})

test('key replacement during worker decryption is rejected and a revoked generation leaves no private/public files', { timeout: 30_000 }, async () => {
  const h = await fixture()
  try {
    const key = await h.service.generate({ type: 'ed25519', passphrase: password })
    const reading = latch()
    let checks = 0
    const pending = h.service.view(key.privateKeyPath, password, () => { if (++checks === 2) reading.enter() })
    const changed = assert.rejects(pending, /key file changed/)
    await reading.entered
    await writeFile(key.privateKeyPath, `${await readFile(key.privateKeyPath, 'utf8')}\n`)
    await changed
    const another = new ManagedKeyService(path.join(h.directory, 'canceled-keys'), sshModulePath)
    const generating = latch()
    let allowed = true
    checks = 0
    const generation = another.generate({ type: 'ed25519', passphrase: password }, () => {
      if (!allowed) throw new Error('The vault was locked during generation.')
      if (++checks === 3) generating.enter()
    })
    const canceled = assert.rejects(generation, /vault was locked/)
    await generating.entered
    allowed = false
    await canceled
    assert.deepEqual(await readdir(path.join(h.directory, 'canceled-keys')), [])
  } finally { await h.close() }
})
