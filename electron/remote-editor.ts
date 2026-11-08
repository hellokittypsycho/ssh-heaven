import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { RemoteFile } from '../shared/types'
import { finalizeUpload } from './transfer-manager'
import { identifier, remotePath } from './validation'

export const MAX_EDITOR_BYTES = 2 * 1024 * 1024

function interrupted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason ?? new Error('The file operation was canceled.')) }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}

function rpc<T>(invoke: (callback: (error: Error | null | undefined, value: T) => void) => void, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (error: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      if (error) reject(error); else resolve(value as T)
    }
    const timer = setTimeout(() => finish(new Error('The SFTP server did not respond in time.')), 15_000)
    const aborted = () => finish(signal?.reason ?? new Error('The file operation was canceled.'))
    signal?.addEventListener('abort', aborted, { once: true })
    try {
      if (signal?.aborted) { aborted(); return }
      invoke((error, value) => finish(error, value))
    } catch (error) { finish(error) }
  })
}

function decodeText(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error('This file contains binary data. The editor supports UTF-8 text files only.')
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch {
    throw new Error('This file is not valid UTF-8 text. Download it to edit with the correct encoding.')
  }
}

async function metadata(sftp: SFTPWrapper, filename: string, follow: boolean, signal?: AbortSignal): Promise<Stats> {
  return rpc<Stats>((callback) => follow ? sftp.stat(filename, callback) : sftp.lstat(filename, callback), signal)
}

async function readFile(sftp: SFTPWrapper, filename: string, signal?: AbortSignal): Promise<RemoteFile> {
  signal?.throwIfAborted()
  const source = await metadata(sftp, filename, true, signal)
  signal?.throwIfAborted()
  if (!source.isFile()) throw new Error('Only regular UTF-8 text files can be opened in the editor.')
  if (source.size > MAX_EDITOR_BYTES) throw new Error('This file is too large for the editor (2 MiB limit). Download it instead.')
  const handle = await rpc<Buffer>((callback) => sftp.open(filename, 'r', callback))
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = Buffer.allocUnsafe(64 * 1024)
      const bytesRead = await rpc<number>((callback) => sftp.read(handle, chunk, 0, chunk.length, length, (error, count) => callback(error, count)), signal)
      signal?.throwIfAborted()
      if (!bytesRead) break
      length += bytesRead
      if (length > MAX_EDITOR_BYTES) throw new Error('This file grew beyond the editor limit (2 MiB). Download it instead.')
      chunks.push(chunk.subarray(0, bytesRead))
    }
  } finally { await rpc<void>((callback) => sftp.close(handle, callback)) }
  const bytes = Buffer.concat(chunks, length)
  return { path: filename, content: decodeText(bytes), version: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, modified: source.mtime }
}

/** All operations remain on the owner-scoped SSH connection; no remote code runs. */
export class RemoteEditorService {
  private readonly versions = new WeakMap<object, Buffer>()
  constructor(private readonly getSftp: (ownerId: number, sessionId: string) => Promise<SFTPWrapper>, private readonly getConnection?: (ownerId: number, sessionId: string) => object) {}

  private binding(ownerId: number, sessionId: string) {
    const client = this.getConnection?.(ownerId, sessionId)
    let secret = client && this.versions.get(client)
    if (client && !secret) { secret = randomBytes(32); this.versions.set(client, secret) }
    return {
      check: () => { if (client && this.getConnection!(ownerId, sessionId) !== client) throw new Error('Save conflict: the SSH connection changed. Reload this file from the current connection before saving your draft.') },
      version: (hash: string) => secret ? createHmac('sha256', secret).update(hash).digest('hex') : hash
    }
  }

  async read(ownerId: number, sessionValue: unknown, value: unknown, signal?: AbortSignal): Promise<RemoteFile> {
    signal?.throwIfAborted()
    const sessionId = identifier(sessionValue, 'session identifier')
    const filename = remotePath(value)
    const binding = this.binding(ownerId, sessionId)
    const sftp = await interrupted(this.getSftp(ownerId, sessionId), signal)
    binding.check()
    // Cancellation returns promptly while a pending OPEN/CLOSE finishes its
    // bounded cleanup; cancellation does not discard an in-flight OPEN handle.
    const result = await interrupted(readFile(sftp, filename, signal), signal)
    binding.check()
    return { ...result, version: binding.version(result.version) }
  }

  async save(ownerId: number, sessionValue: unknown, value: unknown, content: unknown, expectedValue: unknown, signal?: AbortSignal): Promise<RemoteFile> {
    signal?.throwIfAborted()
    const sessionId = identifier(sessionValue, 'session identifier')
    const filename = remotePath(value)
    if (typeof expectedValue !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedValue)) throw new Error('Reload this file before saving: its original version is missing.')
    if (typeof content !== 'string') throw new Error('Invalid editor content.')
    if (content.length > MAX_EDITOR_BYTES) throw new Error('The edited file exceeds the 2 MiB editor limit.')
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > MAX_EDITOR_BYTES) throw new Error('The edited file exceeds the 2 MiB editor limit.')
    if (decodeText(bytes) !== content) throw new Error('The edited file contains invalid Unicode text.')
    const binding = this.binding(ownerId, sessionId)
    const sftp = await interrupted(this.getSftp(ownerId, sessionId), signal)
    binding.check()
    const existing = await metadata(sftp, filename, false)
    if (!existing.isFile()) throw new Error('Saving symbolic links and folders is disabled. Open the actual regular file instead.')
    const expected = expectedValue.toLowerCase()
    const current = await readFile(sftp, filename, signal)
    signal?.throwIfAborted()
    binding.check()
    if (binding.version(current.version) !== expected) throw new Error('Save conflict: this file or its SSH connection changed. Reload it before saving your changes.')
    const temporary = path.posix.join(path.posix.dirname(filename), `.ssh-heaven-edit-${randomUUID()}.part`)
    let ownsTemporary = false
    try {
      const handle = await rpc<Buffer>((callback) => sftp.open(temporary, 'wx', existing.mode & 0o777, callback))
      ownsTemporary = true
      try {
        let written = 0
        while (written < bytes.length) {
          signal?.throwIfAborted()
          binding.check()
          const length = Math.min(64 * 1024, bytes.length - written)
          await rpc<void>((callback) => sftp.write(handle, bytes, written, length, written, (error) => callback(error, undefined)))
          written += length
        }
      } finally { await rpc<void>((callback) => sftp.close(handle, callback)) }
      // SFTP has no compare-and-swap rename. Check again immediately before
      // commit to catch changes that occurred while the sibling was written.
      const latest = await readFile(sftp, filename, signal)
      signal?.throwIfAborted()
      binding.check()
      if (binding.version(latest.version) !== expected) throw new Error('Save conflict: this file changed on the server while saving. Reload it before saving your changes.')
      if (!(await metadata(sftp, filename, false)).isFile()) throw new Error('The remote file changed to a symbolic link or folder. Reload before saving.')
      const mode = existing.mode & 0o777
      // The server's umask may have removed bits passed to OPEN. Preserve the
      // existing mode explicitly before the temporary sibling becomes visible.
      if (((await metadata(sftp, temporary, false)).mode & 0o777) !== mode) {
        await rpc<void>((callback) => sftp.chmod(temporary, mode, callback))
        if (((await metadata(sftp, temporary, false)).mode & 0o777) !== mode) throw new Error('The server could not preserve the original file permissions. The original file was preserved.')
      }
      signal?.throwIfAborted()
      binding.check()
      await finalizeUpload(sftp, temporary, filename, true)
      const result = await readFile(sftp, filename, signal)
      binding.check()
      return { ...result, version: binding.version(result.version) }
    } finally {
      if (ownsTemporary) await rpc<void>((callback) => sftp.unlink(temporary, callback)).catch(() => {})
    }
  }
}
