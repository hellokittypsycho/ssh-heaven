import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, createPublicKey, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import ssh2 from 'ssh2'
import { generateKeyFiles, validateKeyRequest } from '../electron/keygen'

const sshModulePath = createRequire(import.meta.url).resolve('ssh2')
const executeFile = promisify(execFile)

test('offline Ed25519 generation writes an encrypted OpenSSH pair with a correct fingerprint and private permissions', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-keygen-'))
  try {
    const privateKeyPath = path.join(directory, 'id_ed25519')
    const passphrase = 'Only the local key owner knows this passphrase.'
    const result = await generateKeyFiles({ type: 'ed25519', comment: 'SSH Heaven test identity', passphrase }, privateKeyPath, sshModulePath)
    assert.equal(result.privateKeyPath, privateKeyPath)
    assert.equal(result.publicKeyPath, `${privateKeyPath}.pub`)
    assert.match(result.publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ SSH Heaven test identity$/)
    assert.equal(await readFile(result.publicKeyPath, 'utf8'), `${result.publicKey}\n`)
    const secret = await readFile(privateKeyPath, 'utf8')
    assert.match(secret, /^-----BEGIN OPENSSH PRIVATE KEY-----/)
    assert.ok(ssh2.utils.parseKey(secret) instanceof Error)
    assert.ok(ssh2.utils.parseKey(secret, 'incorrect passphrase') instanceof Error)
    const parsed = ssh2.utils.parseKey(secret, passphrase)
    if (parsed instanceof Error) throw parsed
    assert.equal(parsed.type, 'ssh-ed25519')
    assert.equal(parsed.comment, 'SSH Heaven test identity')
    const publicKey = ssh2.utils.parseKey(result.publicKey)
    if (publicKey instanceof Error) throw publicKey
    const challenge = randomBytes(64)
    const signature = parsed.sign(challenge)
    if (signature instanceof Error) throw signature
    assert.equal(publicKey.verify(challenge, signature), true)
    assert.equal(result.fingerprint, `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`)
    assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false)
    assert.equal(JSON.stringify(result).includes(passphrase), false)
    if (process.platform === 'win32') {
      const { stdout } = await executeFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [privateKeyPath], { windowsHide: true })
      assert.equal(stdout.includes('(I)'), false, 'The private key must not inherit folder read permissions')
      assert.equal((stdout.match(/:\(F\)/g) ?? []).length, 1, 'Only the current user receives full control')
    } else assert.equal((await stat(privateKeyPath)).mode & 0o777, 0o600)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('RSA generation uses 3072 bits and produces an interoperable unencrypted OpenSSH identity', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-keygen-rsa-'))
  try {
    const result = await generateKeyFiles({ type: 'rsa', comment: 'rsa test' }, path.join(directory, 'id_rsa'), sshModulePath)
    const parsed = ssh2.utils.parseKey(await readFile(result.privateKeyPath, 'utf8'))
    if (parsed instanceof Error) throw parsed
    assert.equal(parsed.type, 'ssh-rsa')
    assert.equal(createPublicKey(parsed.getPublicPEM()).asymmetricKeyDetails?.modulusLength, 3072)
    assert.match(result.publicKey, /^ssh-rsa /)
    const publicKey = ssh2.utils.parseKey(result.publicKey)
    if (publicKey instanceof Error) throw publicKey
    assert.deepEqual(parsed.getPublicSSH(), publicKey.getPublicSSH())
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('key generation never overwrites an existing private or public key', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-keygen-existing-'))
  try {
    const privateKeyPath = path.join(directory, 'id_existing')
    await writeFile(privateKeyPath, 'ORIGINAL PRIVATE KEY')
    await assert.rejects(generateKeyFiles({ type: 'ed25519' }, privateKeyPath, sshModulePath), /already exists/)
    assert.equal(await readFile(privateKeyPath, 'utf8'), 'ORIGINAL PRIVATE KEY')
    assert.deepEqual(await readdir(directory), ['id_existing'])
    const publicOnly = path.join(directory, 'id_public_only')
    await writeFile(`${publicOnly}.pub`, 'ORIGINAL PUBLIC KEY')
    await assert.rejects(generateKeyFiles({ type: 'ed25519' }, publicOnly, sshModulePath), /already exists/)
    assert.equal(await readFile(`${publicOnly}.pub`, 'utf8'), 'ORIGINAL PUBLIC KEY')
    await assert.rejects(stat(publicOnly), /ENOENT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a public-key destination created during generation is preserved and the new private file is cleaned up', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-keygen-race-'))
  try {
    const privateKeyPath = path.join(directory, 'id_race')
    const generation = generateKeyFiles({ type: 'ed25519', passphrase: 'worker thread bcrypt prevents a UI stall' }, privateKeyPath, sshModulePath)
    const rejected = assert.rejects(generation, /already exists/)
    await new Promise((resolve) => setTimeout(resolve, 30))
    await writeFile(`${privateKeyPath}.pub`, 'PUBLIC FILE CREATED BY ANOTHER OPERATION', { flag: 'wx' })
    await rejected
    assert.equal(await readFile(`${privateKeyPath}.pub`, 'utf8'), 'PUBLIC FILE CREATED BY ANOTHER OPERATION')
    await assert.rejects(stat(privateKeyPath), /ENOENT/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('key generation rejects unsupported algorithms, multiline comments, and excessive passphrases', () => {
  assert.throws(() => validateKeyRequest({ type: 'dsa' }), /Ed25519 or RSA/)
  assert.throws(() => validateKeyRequest({ type: 'ed25519', comment: 'first\nsecond' }), /single line/)
  assert.throws(() => validateKeyRequest({ type: 'rsa', comment: 'x'.repeat(257) }), /256/)
  assert.throws(() => validateKeyRequest({ type: 'ed25519', passphrase: 'x'.repeat(8193) }), /8192/)
})
