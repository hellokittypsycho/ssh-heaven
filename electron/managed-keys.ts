import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import type { GeneratedKey, KeyGenerationRequest } from '../shared/types'
import { generateKeyFiles, restrictPrivateKeyDirectory, validateKeyRequest } from './keygen'
import { textValue } from './validation'

export const MAX_PRIVATE_KEY_BYTES = 2 * 1024 * 1024
export interface KeyContents { publicKey: string; privateKey: string }

export function validateManagedKeyRequest(value: unknown): KeyGenerationRequest {
  const request = validateKeyRequest(value)
  if (!request.passphrase || request.passphrase.trim().length === 0 || [...request.passphrase].length < 12 || request.passphrase.includes('\0')) {
    throw new Error('Protect the SSH key with a password of at least 12 characters; it cannot contain only spaces.')
  }
  return request
}

function viewPassword(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 8192 || value.includes('\0')) throw new Error('Enter the SSH key password (up to 8192 characters).')
  return value
}

/** bcrypt and imported key parsing never run on Electron's SSH/UI host thread. */
function decryptInWorker(source: Buffer, password: string, sshModulePath: string): Promise<KeyContents> {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { utils } = require(workerData.sshModulePath);
    const source = Buffer.from(workerData.source);
    try {
      const withoutPassword = utils.parseKey(source);
      if (!(withoutPassword instanceof Error)) {
        parentPort.postMessage({ error: 'unencrypted' });
      } else {
        const key = utils.parseKey(source, workerData.password);
        if (key instanceof Error || Array.isArray(key) || !key.isPrivateKey()) parentPort.postMessage({ error: 'password' });
        else {
          const privateKey = key.getPrivatePEM();
          const publicKey = key.type + ' ' + key.getPublicSSH().toString('base64');
          if (typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY-----')) parentPort.postMessage({ error: 'format' });
          else parentPort.postMessage({ result: { privateKey, publicKey } });
        }
      }
    } catch { parentPort.postMessage({ error: 'password' }); }
    finally { source.fill(0); }
  `, { eval: true, workerData: { source, password, sshModulePath } })
  return new Promise<KeyContents>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, result?: KeyContents) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error)
      else resolve(result!)
    }
    const timer = setTimeout(() => finish(new Error('Unlocking the SSH key timed out. Try again.')), 30_000)
    worker.once('error', () => finish(new Error('The SSH key could not be unlocked. Try again.')))
    worker.once('exit', () => { if (!settled) finish(new Error('The SSH key viewer stopped unexpectedly.')) })
    worker.once('message', (message: { error?: string; result?: KeyContents }) => {
      if (message.error === 'unencrypted') return finish(new Error('This key has no password protection. Import a password-encrypted private key before viewing it.'))
      if (message.error) return finish(new Error('The SSH key password is incorrect or this private-key format is unsupported.'))
      const result = message.result
      if (!result || typeof result.privateKey !== 'string' || typeof result.publicKey !== 'string' || Buffer.byteLength(result.privateKey) > MAX_PRIVATE_KEY_BYTES || Buffer.byteLength(result.publicKey) > MAX_PRIVATE_KEY_BYTES || !/^ssh-|^ecdsa-/.test(result.publicKey)) return finish(new Error('The SSH key viewer returned an invalid result.'))
      finish(undefined, result)
    })
  })
}

async function boundedRead(handle: FileHandle): Promise<Buffer> {
  const value = Buffer.alloc(MAX_PRIVATE_KEY_BYTES + 1)
  let length = 0
  try {
    while (length < value.length) {
      const { bytesRead } = await handle.read(value, length, value.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (!length || length > MAX_PRIVATE_KEY_BYTES) throw new Error('Choose a private key file no larger than 2 MiB.')
    return Buffer.from(value.subarray(0, length))
  } finally { value.fill(0) }
}

/** Main resolves saved-key IDs to trusted paths. This class has no arbitrary-path IPC. */
export class ManagedKeyService {
  private readonly directory: string
  private activeView = false

  constructor(directory: string, private readonly sshModulePath: string) {
    if (!path.isAbsolute(directory)) throw new Error('The managed SSH key directory must be absolute.')
    this.directory = path.resolve(directory)
  }

  isManagedPath(value: string): boolean {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return false
    const relative = path.relative(this.directory, value)
    return /^(?:ed25519|rsa)-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(relative)
  }

  private async prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const metadata = await lstat(this.directory)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('The managed SSH key folder is unavailable or unsafe.')
    await restrictPrivateKeyDirectory(this.directory)
  }

  async generate(value: unknown, guard?: () => void): Promise<GeneratedKey> {
    guard?.()
    const request = validateManagedKeyRequest(value)
    await this.prepareDirectory()
    guard?.()
    return generateKeyFiles(request, path.join(this.directory, `${request.type}-${randomUUID()}`), this.sshModulePath, guard)
  }

  async view(filenameValue: unknown, passwordValue: unknown, guard: () => void): Promise<KeyContents> {
    if (typeof guard !== 'function') throw new Error('Unlock the vault before viewing SSH keys.')
    guard()
    const filename = textValue(filenameValue, 'saved SSH key path', 32768)
    if (!path.isAbsolute(filename)) throw new Error('The saved SSH key path must be absolute.')
    const password = viewPassword(passwordValue)
    if (this.activeView) throw new Error('Another SSH key is being unlocked. Wait for it to finish.')
    this.activeView = true
    let handle: FileHandle | undefined, source: Buffer | undefined, result!: KeyContents
    try {
      const selected = await lstat(filename)
      if (!selected.isFile() || selected.isSymbolicLink() || selected.size < 1 || selected.size > MAX_PRIVATE_KEY_BYTES) throw new Error('Choose a regular private key file no larger than 2 MiB.')
      handle = await open(filename, 'r')
      const metadata = await handle.stat()
      if (!metadata.isFile() || metadata.dev !== selected.dev || metadata.ino !== selected.ino || metadata.size > MAX_PRIVATE_KEY_BYTES) throw new Error('The SSH key changed while opening it. Try again.')
      source = await boundedRead(handle)
      guard()
      result = await decryptInWorker(source, password, this.sshModulePath)
      guard()
      const current = await lstat(filename)
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino || current.size !== metadata.size || current.mtimeMs !== metadata.mtimeMs || current.ctimeMs !== metadata.ctimeMs) throw new Error('The SSH key file changed while it was being unlocked. Try again.')
    } finally {
      source?.fill(0)
      await handle?.close().catch(() => {})
      this.activeView = false
    }
    guard()
    return result
  }
}
