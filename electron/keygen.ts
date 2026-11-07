import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, open, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { Worker } from 'node:worker_threads'
import type { GeneratedKey, KeyGenerationRequest } from '../shared/types'
import { localDownloadName, record, textValue } from './validation'

const executeFile = promisify(execFile)
let currentSid: Promise<string> | undefined

export function validateKeyRequest(value: unknown): KeyGenerationRequest {
  const input = record(value, 'key generation request')
  if (input.type !== 'ed25519' && input.type !== 'rsa') throw new Error('Choose an Ed25519 or RSA key.')
  if (input.comment !== undefined && (typeof input.comment !== 'string' || input.comment.length > 256 || /[\r\n\0]/.test(input.comment))) throw new Error('The key comment must be a single line of at most 256 characters.')
  if (input.passphrase !== undefined && (typeof input.passphrase !== 'string' || input.passphrase.length > 8192)) throw new Error('The key passphrase is too long (8192 character limit).')
  return { type: input.type, comment: input.comment as string | undefined, passphrase: input.passphrase as string | undefined }
}

function systemExecutable(name: string): string {
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name)
}

export async function restrictPrivateKey(filename: string): Promise<void> {
  if (process.platform !== 'win32') return
  currentSid ??= executeFile(systemExecutable('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 10_000 }).then(({ stdout }) => {
    const sid = stdout.match(/\bS-1-\d+(?:-\d+)+\b/)?.[0]
    if (!sid) throw new Error('Could not identify the Windows account for private-key permissions.')
    return sid
  })
  const sid = await currentSid
  // Run before writing secret bytes. Only this freshly created, exclusively
  // opened file is targeted; existing keys are never chmodded or overwritten.
  await executeFile(systemExecutable('icacls.exe'), [filename, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true, timeout: 10_000 })
}

interface KeyPair { private: string; public: string }
interface OwnedFile { filename: string; handle: FileHandle; dev: number; ino: number }

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function sameOwnedFile(file: OwnedFile): Promise<boolean> {
  try {
    const metadata = await lstat(file.filename)
    return !metadata.isSymbolicLink() && metadata.dev === file.dev && metadata.ino === file.ino
  } catch { return false }
}

async function createOwnedFile(filename: string, mode: number): Promise<OwnedFile> {
  const handle = await open(filename, 'wx', mode)
  try {
    const metadata = await handle.stat()
    return { filename, handle, dev: metadata.dev, ino: metadata.ino }
  } catch (error) {
    await handle.close()
    throw error
  }
}

function generateInWorker(request: KeyGenerationRequest, sshModulePath: string): Promise<KeyPair> {
  // ssh2 uses asynchronous native key generation, but OpenSSH bcrypt key
  // encryption is synchronous JavaScript. Keep both off the SSH/UI host thread.
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { utils } = require(workerData.sshModulePath);
    const { type, comment, passphrase } = workerData.request;
    const options = { comment: comment || '', ...(type === 'rsa' ? { bits: 3072 } : {}), ...(passphrase ? { passphrase, cipher: 'aes256-ctr', rounds: 64 } : {}) };
    try {
      utils.generateKeyPair(type, options, (error, keys) => {
        if (error) parentPort.postMessage({ error: error.message });
        else parentPort.postMessage({ keys });
      });
    } catch (error) { parentPort.postMessage({ error: error.message }); }
  `, { eval: true, workerData: { request, sshModulePath } })
  return new Promise<KeyPair>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, keys?: KeyPair) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error)
      else resolve(keys!)
    }
    const timer = setTimeout(() => finish(new Error('SSH key generation timed out. Try again.')), 120_000)
    worker.once('error', (error) => finish(error))
    worker.once('exit', () => { if (!settled) finish(new Error('The SSH key generator exited unexpectedly.')) })
    worker.once('message', (message: { error?: string; keys?: KeyPair }) => {
      if (message.error) finish(new Error(message.error))
      else if (!message.keys || typeof message.keys.private !== 'string' || typeof message.keys.public !== 'string') finish(new Error('The SSH key generator returned an invalid result.'))
      else finish(undefined, message.keys)
    })
  })
}

/** Generates keys offline. Only public key data and file paths cross back to UI. */
export async function generateKeyFiles(value: unknown, privateValue: unknown, sshModulePath: string): Promise<GeneratedKey> {
  const request = validateKeyRequest(value)
  const privateKeyPath = textValue(privateValue, 'private key filename', 32768)
  if (!path.isAbsolute(privateKeyPath)) throw new Error('Choose an absolute path for the private key.')
  if (process.platform === 'win32') localDownloadName(path.basename(privateKeyPath))
  const publicKeyPath = `${privateKeyPath}.pub`
  if (await exists(privateKeyPath) || await exists(publicKeyPath)) throw new Error('The private key or its .pub file already exists. Choose a new filename; existing keys are never overwritten.')
  const keys = await generateInWorker(request, sshModulePath)
  const publicKey = keys.public.trim()
  const parts = publicKey.split(/\s+/)
  if (parts[0] !== (request.type === 'rsa' ? 'ssh-rsa' : 'ssh-ed25519') || !parts[1]) throw new Error('The generated public key is invalid.')
  const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(parts[1], 'base64')).digest('base64').replace(/=+$/, '')}`
  const owned: OwnedFile[] = []
  let completed = false
  try {
    const privateFile = await createOwnedFile(privateKeyPath, 0o600)
    owned.push(privateFile)
    if (!(await sameOwnedFile(privateFile))) throw new Error('The key destination changed while creating the file.')
    await restrictPrivateKey(privateKeyPath)
    if (!(await sameOwnedFile(privateFile))) throw new Error('The key destination changed while securing the file.')
    const publicFile = await createOwnedFile(publicKeyPath, 0o644)
    owned.push(publicFile)
    await privateFile.handle.writeFile(`${keys.private.trimEnd()}\n`, 'utf8')
    await publicFile.handle.writeFile(`${publicKey}\n`, 'utf8')
    await Promise.all(owned.map((file) => file.handle.sync()))
    completed = true
    return { type: request.type, privateKeyPath, publicKeyPath, publicKey, fingerprint }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('The private key or its .pub file already exists. Choose a new filename; existing keys are never overwritten.')
    throw error
  } finally {
    for (const file of owned) await file.handle.close().catch(() => {})
    if (!completed) {
      for (const file of owned) if (await sameOwnedFile(file)) await unlink(file.filename).catch(() => {})
    }
  }
}
