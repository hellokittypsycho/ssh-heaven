import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { TransferJob, TransferResult } from '../shared/types'
import { childLocalPath, errorMessage, identifier, remoteFilename, remotePath } from './validation'
import { ensureLocalDirectory, ensureRemoteDirectory, scanLocalTree, scanRemoteTree } from './transfer-tree'

export type ConfirmReplacement = (destination: string, signal: AbortSignal) => Promise<boolean>

interface Task {
  ownerId: number
  event: TransferJob
  controller: AbortController
  action: (task: Task) => Promise<void>
  complete: (job: TransferJob) => void
  promise: Promise<TransferJob>
  committing: boolean
  lastProgress: number
  parent?: Task
  progressBase?: number
}

function rpc<T>(invoke: (callback: (error: Error | null | undefined, result: T) => void) => void, timeout = 15_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The SFTP server did not respond in time.')), timeout)
    const callback = (error: Error | null | undefined, result: T) => {
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    try { invoke(callback) } catch (error) { clearTimeout(timer); reject(error) }
  })
}

async function remoteStat(sftp: SFTPWrapper, filename: string, follow = false): Promise<Stats | null> {
  try {
    return await rpc<Stats>((callback) => follow ? sftp.stat(filename, callback) : sftp.lstat(filename, callback))
  } catch (error) {
    if ((error as Error & { code?: number }).code === 2) return null
    throw error
  }
}

async function localStat(filename: string) {
  try { return await lstat(filename) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
    if (signal.aborted) aborted()
  })
}

export function waitForStreamClose(stream: Readable | Writable, timeout = 3_000): Promise<boolean> {
  if (stream.closed) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (closed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poll)
      stream.off('close', check)
      stream.off('error', check)
      resolve(closed)
    }
    const check = () => { if (stream.closed) finish(true) }
    const timer = setTimeout(() => finish(stream.closed), timeout)
    // ssh2 deliberately suppresses the close event on some error paths. Node's
    // closed flag is set after its asynchronous _destroy callback completes,
    // which happens after the remote file handle has actually been closed.
    const poll = setInterval(check, 20)
    stream.on('close', check)
    stream.on('error', check)
    check()
  })
}

export async function finalizeUpload(sftp: SFTPWrapper, temporary: string, destination: string, replacing: boolean): Promise<void> {
  if (replacing) {
    try {
      await rpc<void>((callback) => sftp.ext_openssh_rename(temporary, destination, callback))
      return
    } catch (error) {
      // ssh2 throws synchronously when the extension was not advertised. Some
      // servers advertise it but return SSH_FX_OP_UNSUPPORTED (8).
      if ((error as Error & { code?: number }).code !== 8 && !/does not support this extended request/i.test(errorMessage(error))) throw error
    }
  }
  try {
    // Standard SFTP rename either succeeds atomically or leaves the original
    // untouched. In particular, never unlink the original to make this work.
    await rpc<void>((callback) => sftp.rename(temporary, destination, callback))
  } catch (error) {
    if (replacing) throw new Error(`This server could not safely replace ${path.posix.basename(destination)}. The original file was preserved. ${errorMessage(error)}`)
    throw error
  }
}

function validateBatch(values: unknown, label: string): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 200) throw new Error(`Choose between 1 and 200 ${label}.`)
  return [...new Set(values.map((value) => remotePath(value)))]
}
function transferError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return 'A transfer path is no longer available. Check the source and destination, then retry.'
  if (code === 'EACCES' || code === 'EPERM') return 'Access denied. Check the file and folder permissions, then retry.'
  if (code === 'ENOSPC') return 'The destination has run out of space.'
  return errorMessage(error)
}

/** Streamed, cancellable jobs; each SSH session has one independently drained queue. */
export class TransferManager {
  private readonly jobs = new Map<string, Task>()
  private readonly queues = new Map<string, Task[]>()
  private readonly draining = new Set<string>()

  constructor(
    private readonly getSftp: (ownerId: number, sessionId: string) => Promise<SFTPWrapper>,
    private readonly notify: (ownerId: number, job: TransferJob) => void
  ) {}

  async upload(ownerId: number, sessionValue: unknown, sourceValues: unknown, directoryValue: unknown, confirm: ConfirmReplacement): Promise<TransferResult> {
    const sessionId = identifier(sessionValue, 'session identifier')
    const directory = remotePath(directoryValue)
    const sources = validateBatch(sourceValues, 'files')
    if (sources.some((source) => !path.isAbsolute(source))) throw new Error('Upload sources must be selected local files.')
    this.ensureCapacity(sources.length)
    const promises = sources.map((source) => {
      const name = remoteFilename(path.basename(source))
      const destination = path.posix.join(directory, name)
      return this.enqueue(ownerId, sessionId, 'upload', source, destination, name, (task) => this.runTree(task, confirm))
    })
    return this.batch(promises)
  }

  async download(ownerId: number, sessionValue: unknown, sourceValues: unknown, localDirectory: string, confirm: ConfirmReplacement): Promise<TransferResult> {
    const sessionId = identifier(sessionValue, 'session identifier')
    const sources = validateBatch(sourceValues, 'files')
    if (!path.isAbsolute(localDirectory)) throw new Error('Choose a local download folder.')
    // Validate the complete batch before enqueuing, including Windows reserved
    // names and names that could escape the selected local directory.
    const destinations = sources.map((source) => childLocalPath(localDirectory, path.posix.basename(source)))
    const uniqueDestinations = new Set(destinations.map((destination) => process.platform === 'win32' ? destination.toLowerCase() : destination))
    if (uniqueDestinations.size !== destinations.length) throw new Error('Two selected remote files have the same local filename. Download them separately.')
    this.ensureCapacity(sources.length)
    return this.batch(sources.map((source, index) => this.enqueue(ownerId, sessionId, 'download', source, destinations[index], path.posix.basename(source), (task) => this.runTree(task, confirm))))
  }

  async retry(ownerId: number, value: unknown, confirm: ConfirmReplacement): Promise<TransferResult> {
    const id = identifier(value, 'transfer identifier')
    const previous = this.jobs.get(id)
    if (!previous || previous.ownerId !== ownerId || !['failed', 'canceled'].includes(previous.event.status)) throw new Error('Only failed or canceled transfers from this window can be retried.')
    this.ensureCapacity(1)
    const { sessionId, direction, source, destination, name } = previous.event
    return this.batch([this.enqueue(ownerId, sessionId, direction, source, destination, name, (task) => this.runTree(task, confirm))])
  }

  cancel(ownerId: number, value: unknown): void {
    const id = identifier(value, 'transfer identifier')
    const task = this.jobs.get(id)
    if (!task || task.ownerId !== ownerId) throw new Error('This transfer is unavailable or belongs to another window.')
    this.cancelTask(task)
  }

  async cancelSession(ownerId: number, sessionValue: unknown): Promise<void> {
    const sessionId = identifier(sessionValue, 'session identifier')
    await this.cancelMatching((task) => task.ownerId === ownerId && task.event.sessionId === sessionId)
  }

  async cancelOwner(ownerId: number): Promise<void> {
    await this.cancelMatching((task) => task.ownerId === ownerId)
  }

  async dispose(): Promise<void> {
    await this.cancelMatching(() => true)
  }

  private async cancelMatching(matches: (task: Task) => boolean): Promise<void> {
    const tasks = [...this.jobs.values()].filter((task) => matches(task) && (task.event.status === 'queued' || task.event.status === 'running'))
    for (const task of tasks) this.cancelTask(task)
    await Promise.all(tasks.map((task) => task.promise))
  }

  private cancelTask(task: Task): void {
    if (task.committing || (task.event.status !== 'queued' && task.event.status !== 'running')) return
    task.controller.abort()
    if (task.event.status === 'queued') this.finish(task, 'canceled', 'Canceled before starting.')
  }

  private ensureCapacity(count: number): void {
    const pending = [...this.jobs.values()].filter((task) => task.event.status === 'queued' || task.event.status === 'running').length
    if (pending + count > 200) throw new Error('The transfer queue is full (200 pending files).')
    // Keep completed metadata bounded. Active jobs are never discarded.
    for (const [id, task] of this.jobs) {
      if (this.jobs.size + count <= 500) break
      if (task.event.status !== 'queued' && task.event.status !== 'running') this.jobs.delete(id)
    }
  }

  private enqueue(ownerId: number, sessionId: string, direction: TransferJob['direction'], source: string, destination: string, name: string, action: Task['action']): Promise<TransferJob> {
    let complete!: Task['complete']
    const promise = new Promise<TransferJob>((resolve) => { complete = resolve })
    const task: Task = {
      ownerId, action, complete, promise, controller: new AbortController(), committing: false, lastProgress: 0,
      event: { id: randomUUID(), sessionId, direction, source, destination, name, transferred: 0, total: 0, status: 'queued', startedAt: Date.now() }
    }
    this.jobs.set(task.event.id, task)
    const key = `${ownerId}:${sessionId}`
    const queue = this.queues.get(key) ?? []
    queue.push(task)
    this.queues.set(key, queue)
    this.emit(task)
    queueMicrotask(() => { void this.drain(key) })
    return promise
  }

  private async drain(key: string): Promise<void> {
    if (this.draining.has(key)) return
    this.draining.add(key)
    try {
      const queue = this.queues.get(key)
      while (queue?.length) {
        const task = queue.shift()!
        if (task.event.status !== 'queued') continue
        task.event.status = 'running'
        task.event.startedAt = Date.now()
        this.emit(task)
        try {
          await task.action(task)
          this.finish(task, 'completed')
        } catch (error) {
          this.finish(task, task.controller.signal.aborted ? 'canceled' : 'failed', task.controller.signal.aborted ? 'Transfer canceled.' : transferError(error))
        }
      }
    } finally {
      this.queues.delete(key)
      this.draining.delete(key)
    }
  }

  private emit(task: Task): void {
    if (task.parent) {
      task.parent.event.transferred = (task.progressBase ?? 0) + task.event.transferred
      this.notify(task.parent.ownerId, { ...task.parent.event })
    } else this.notify(task.ownerId, { ...task.event })
  }

  private finish(task: Task, status: 'completed' | 'failed' | 'canceled', message?: string): void {
    task.event.status = status
    task.event.message = message
    task.event.finishedAt = Date.now()
    this.emit(task)
    task.complete({ ...task.event })
  }

  private async batch(promises: Promise<TransferJob>[]): Promise<TransferResult> {
    const jobs = await Promise.all(promises)
    const failures = jobs.filter((job) => job.status === 'failed')
    if (failures.length) throw new Error(`${failures.length} ${failures.length === 1 ? 'file could' : 'files could'} not be transferred. ${failures[0].message ?? 'See transfer details.'}`)
    const files = jobs.filter((job) => job.status === 'completed').map((job) => job.destination)
    return { canceled: files.length === 0, files }
  }

  private progress(task: Task): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        task.event.transferred += chunk.length
        const now = Date.now()
        if (now - task.lastProgress >= 80 || task.event.transferred >= task.event.total) {
          task.lastProgress = now
          this.emit(task)
        }
        callback(null, chunk)
      }
    })
  }

  private async transfer(task: Task, reader: Readable, writer: Writable): Promise<void> {
    try {
      await pipeline(reader, this.progress(task), writer, { signal: task.controller.signal })
    } finally {
      // pipeline can reject before a remote OPEN/CLOSE callback has settled.
      // Always await both file handles separately, even on abort, so temporary
      // cleanup cannot run ahead of a late-opening remote file or local writer.
      reader.destroy()
      writer.destroy()
      const closed = await Promise.all([waitForStreamClose(reader), waitForStreamClose(writer)])
      if (closed.some((value) => !value)) throw new Error('A file handle did not close in time. Temporary file cleanup could not be confirmed.')
    }
  }

  private async runTree(task: Task, confirm: ConfirmReplacement): Promise<void> {
    const signal = task.controller.signal
    signal.throwIfAborted()
    const sftp = await abortable(this.getSftp(task.ownerId, task.event.sessionId), signal)
    const source = task.event.direction === 'upload' ? await lstat(task.event.source) : await remoteStat(sftp, task.event.source)
    if (source?.isSymbolicLink()) throw new Error('Transfers do not follow symbolic links. Select the target directly instead.')
    if (!source?.isDirectory()) return task.event.direction === 'upload' ? this.runUpload(task, confirm) : this.runDownload(task, confirm)
    // Scan and validate every name before creating any destination. A folder
    // occupies one queue slot and reports aggregate progress over its files.
    const entries = task.event.direction === 'upload' ? await scanLocalTree(task.event.source, signal) : await scanRemoteTree(sftp, task.event.source, signal)
    task.event.total = entries.reduce((sum, entry) => sum + entry.size, 0)
    this.emit(task)
    let completedBytes = 0
    for (const entry of entries) {
      signal.throwIfAborted()
      const destination = task.event.direction === 'upload' ? path.posix.join(task.event.destination, entry.relative) : path.join(task.event.destination, ...entry.relative.split('/'))
      if (entry.directory) {
        if (task.event.direction === 'upload') await ensureRemoteDirectory(sftp, destination)
        else await ensureLocalDirectory(destination)
        continue
      }
      const child: Task = { ...task, parent: task, progressBase: completedBytes, committing: false, lastProgress: 0,
        event: { ...task.event, source: task.event.direction === 'upload' ? path.join(task.event.source, ...entry.relative.split('/')) : path.posix.join(task.event.source, entry.relative), destination, name: entry.relative, transferred: 0, total: entry.size } }
      try { if (task.event.direction === 'upload') await this.runUpload(child, confirm); else await this.runDownload(child, confirm) }
      catch (error) { throw new Error(`${entry.relative}: ${errorMessage(error)}`) }
      completedBytes += child.event.transferred
      task.event.transferred = completedBytes
      this.emit(task)
    }
  }

  private async runUpload(task: Task, confirm: ConfirmReplacement): Promise<void> {
    const { signal } = task.controller
    signal.throwIfAborted()
    const sftp = await abortable(this.getSftp(task.ownerId, task.event.sessionId), signal)
    const source = await abortable(lstat(task.event.source), signal)
    if (!source.isFile()) throw new Error('Only regular local files can be uploaded.')
    if (task.parent && source.size !== task.event.total) throw new Error('The source file changed size after the folder was scanned. Retry after it stops changing.')
    task.event.total = source.size
    this.emit(task)
    const existing = await abortable(remoteStat(sftp, task.event.destination), signal)
    if (existing?.isDirectory()) throw new Error('A directory with this name already exists on the server.')
    if (existing?.isSymbolicLink()) throw new Error('Rename the destination symbolic link before uploading.')
    if (existing && !(await confirm(task.event.destination, signal))) { task.controller.abort(); signal.throwIfAborted() }
    signal.throwIfAborted()
    const temporary = path.posix.join(path.posix.dirname(task.event.destination), `.ssh-heaven-${task.event.id}.part`)
    try {
      const reader = createReadStream(task.event.source, { highWaterMark: 64 * 1024 })
      const writer = sftp.createWriteStream(temporary, { flags: 'wx', mode: existing ? existing.mode & 0o777 : source.mode & 0o755 })
      await this.transfer(task, reader, writer)
      signal.throwIfAborted()
      if (task.event.transferred !== task.event.total) throw new Error('The source file changed size during upload. Retry after it stops changing.')
      // An absent destination may have appeared during the stream. Ask again
      // before replacing it, rather than silently overwriting a new file.
      const current = await abortable(remoteStat(sftp, task.event.destination), signal)
      if (current?.isDirectory() || current?.isSymbolicLink()) throw new Error('The upload destination changed to a folder or symbolic link.')
      if (!existing && current && !(await confirm(task.event.destination, signal))) { task.controller.abort(); signal.throwIfAborted() }
      signal.throwIfAborted()
      task.committing = true
      await finalizeUpload(sftp, temporary, task.event.destination, Boolean(current))
    } finally {
      // This only targets the random temporary sibling, never the destination.
      await rpc<void>((callback) => sftp.unlink(temporary, callback), 3_000).catch(() => {})
    }
  }

  private async runDownload(task: Task, confirm: ConfirmReplacement): Promise<void> {
    const { signal } = task.controller
    signal.throwIfAborted()
    const sftp = await abortable(this.getSftp(task.ownerId, task.event.sessionId), signal)
    const source = await abortable(remoteStat(sftp, task.event.source, true), signal)
    if (!source?.isFile()) throw new Error('Only regular remote files can be downloaded.')
    if (task.parent && source.size !== task.event.total) throw new Error('The source file changed size after the folder was scanned. Retry after it stops changing.')
    task.event.total = source.size
    this.emit(task)
    const existing = await abortable(localStat(task.event.destination), signal)
    if (existing?.isSymbolicLink()) throw new Error('Rename the destination symbolic link before downloading.')
    if (existing?.isDirectory()) throw new Error('A folder with this name already exists in the download folder.')
    if (existing && !(await confirm(task.event.destination, signal))) { task.controller.abort(); signal.throwIfAborted() }
    signal.throwIfAborted()
    const temporary = path.join(path.dirname(task.event.destination), `.ssh-heaven-${task.event.id}.part`)
    try {
      const reader = sftp.createReadStream(task.event.source, { highWaterMark: 64 * 1024 })
      const writer = createWriteStream(temporary, { flags: 'wx', mode: 0o600 })
      await this.transfer(task, reader, writer)
      signal.throwIfAborted()
      if (task.event.transferred !== task.event.total) throw new Error('The source file changed size during download. Retry after it stops changing.')
      const current = await abortable(localStat(task.event.destination), signal)
      if (current?.isSymbolicLink()) throw new Error('The download destination changed to a symbolic link.')
      if (current?.isDirectory()) throw new Error('A folder appeared at the download destination.')
      if (!existing && current && !(await confirm(task.event.destination, signal))) { task.controller.abort(); signal.throwIfAborted() }
      signal.throwIfAborted()
      task.committing = true
      await rename(temporary, task.event.destination)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
}
