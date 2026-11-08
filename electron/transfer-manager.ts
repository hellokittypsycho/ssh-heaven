import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper, Stats } from 'ssh2'
import type { TransferJob, TransferResult } from '../shared/types'
import { childLocalPath, errorMessage, identifier, remoteFilename, remotePath } from './validation'
import { ensureLocalDirectory, ensureRemoteDirectory, scanLocalTree, scanRemoteTree } from './transfer-tree'
import { TransferBandwidth, TransferGate } from './transfer-flow'

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
  gate: TransferGate
  started: boolean
  activeChild?: Task
  activeSince?: number
  activeMilliseconds: number
  samples: { time: number; bytes: number }[]
  failure?: Error
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
  private readonly bandwidth = new Map<number, TransferBandwidth>()
  private readonly ownerCapabilities = new Map<number, object>()
  private readonly sessionCapabilities = new Map<string, object>()
  private readonly closingOwners = new Map<number, number>()
  private readonly closingSessions = new Map<string, number>()
  private disposed = false

  constructor(
    private readonly getSftp: (ownerId: number, sessionId: string) => Promise<SFTPWrapper>,
    private readonly notify: (ownerId: number, job: TransferJob) => void
  ) {}

  async upload(ownerId: number, sessionValue: unknown, sourceValues: unknown, directoryValue: unknown, confirm: ConfirmReplacement): Promise<TransferResult> {
    const sessionId = identifier(sessionValue, 'session identifier')
    this.admit(ownerId, sessionId)
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
    this.admit(ownerId, sessionId)
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
    const { sessionId, direction, source, destination, name } = previous.event
    this.admit(ownerId, sessionId)
    this.ensureCapacity(1)
    return this.batch([this.enqueue(ownerId, sessionId, direction, source, destination, name, (task) => this.runTree(task, confirm))])
  }

  cancel(ownerId: number, value: unknown): void {
    const id = identifier(value, 'transfer identifier')
    const task = this.jobs.get(id)
    if (!task || task.ownerId !== ownerId) throw new Error('This transfer is unavailable or belongs to another window.')
    this.cancelTask(task)
  }

  getBandwidthLimit(ownerId: number): number { return this.ownerBandwidth(ownerId).limit }

  setBandwidthLimit(ownerId: number, value: unknown): void {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value !== 0 && (value < 1024 || value > 1024 ** 3)) throw new Error('Use 0 for unlimited bandwidth, or between 1 KiB/s and 1 GiB/s.')
    this.ownerBandwidth(ownerId).set(value)
    for (const task of this.jobs.values()) if (task.ownerId === ownerId && this.pending(task)) this.emit(task)
  }

  pause(ownerId: number, value: unknown): void {
    const task = this.owned(ownerId, value)
    if (!['running', 'queued'].includes(task.event.status) || task.committing || task.activeChild?.committing) return
    if (task.activeSince !== undefined) task.activeMilliseconds += performance.now() - task.activeSince
    task.activeSince = undefined
    task.gate.set(true)
    task.event.status = 'paused'
    this.emit(task)
  }

  resume(ownerId: number, value: unknown): void {
    const task = this.owned(ownerId, value)
    if (task.event.status !== 'paused') return
    task.event.status = task.started ? 'running' : 'queued'
    if (task.started) {
      task.activeSince = performance.now()
      task.samples = [{ time: task.activeMilliseconds, bytes: task.event.transferred }]
    }
    task.gate.set(false)
    this.emit(task)
    queueMicrotask(() => { void this.drain(this.key(task)) })
  }

  move(ownerId: number, value: unknown, direction: unknown): void {
    const task = this.owned(ownerId, value)
    if (direction !== -1 && direction !== 1) throw new Error('Choose whether to move the transfer up or down.')
    if (task.started || !this.pending(task)) throw new Error('Only waiting transfers can be reordered.')
    const key = this.key(task), queue = this.queues.get(key)
    const index = queue?.indexOf(task) ?? -1
    if (!queue || index < 0) throw new Error('This transfer is no longer waiting in the queue.')
    const next = index + direction
    if (next < 0 || next >= queue.length) return
    ;[queue[index], queue[next]] = [queue[next], queue[index]]
    this.refreshQueue(key)
  }

  private owned(ownerId: number, value: unknown): Task {
    const task = this.jobs.get(identifier(value, 'transfer identifier'))
    if (!task || task.ownerId !== ownerId) throw new Error('This transfer is unavailable or belongs to another window.')
    return task
  }
  private pending(task: Task): boolean { return ['queued', 'running', 'paused'].includes(task.event.status) }
  private key(task: Task): string { return `${task.ownerId}:${task.event.sessionId}` }
  private admit(ownerId: number, sessionId: string): void {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('Invalid transfer window.')
    if (this.disposed) throw new Error('The transfer manager is shutting down.')
    if (this.closingOwners.has(ownerId) || this.closingSessions.has(`${ownerId}:${sessionId}`)) throw new Error('Previous transfers are still closing. Wait for cleanup before starting another transfer.')
  }

  /** Capture before a file picker/await. Old operations cannot revive when a
   * renderer reload or reconnect reuses the same owner/session identifiers. */
  capture(ownerId: number, sessionValue: unknown): () => void {
    const sessionId = identifier(sessionValue, 'session identifier'), key = `${ownerId}:${sessionId}`
    this.admit(ownerId, sessionId)
    let owner = this.ownerCapabilities.get(ownerId), session = this.sessionCapabilities.get(key)
    if (!owner) { owner = {}; this.ownerCapabilities.set(ownerId, owner) }
    if (!session) {
      // Valid UI use has at most 20 live sessions. Bound failed/abandoned
      // captures too; evicted pickers must be selected again rather than revive.
      if (this.sessionCapabilities.size >= 512) this.sessionCapabilities.delete(this.sessionCapabilities.keys().next().value!)
      session = {}; this.sessionCapabilities.set(key, session)
    }
    return () => {
      this.admit(ownerId, sessionId)
      if (this.ownerCapabilities.get(ownerId) !== owner || this.sessionCapabilities.get(key) !== session) throw new Error('The connection or window changed. Select the files again before starting a transfer.')
    }
  }
  private ownerBandwidth(ownerId: number): TransferBandwidth {
    if (!Number.isSafeInteger(ownerId) || ownerId < 1) throw new Error('Invalid transfer window.')
    let bandwidth = this.bandwidth.get(ownerId)
    if (!bandwidth) { bandwidth = new TransferBandwidth(); this.bandwidth.set(ownerId, bandwidth) }
    return bandwidth
  }

  private refreshQueue(key: string): void {
    const waiting = (this.queues.get(key) ?? []).filter((task) => !task.started && this.pending(task))
    if (waiting.length) this.queues.set(key, waiting)
    else this.queues.delete(key)
    const changed = waiting.filter((task, index) => task.event.queuePosition !== index + 1)
    waiting.forEach((task, index) => { task.event.queuePosition = index + 1 })
    for (const task of changed) if (this.pending(task)) this.emit(task)
  }

  async cancelSession(ownerId: number, sessionValue: unknown): Promise<void> {
    const sessionId = identifier(sessionValue, 'session identifier')
    const key = `${ownerId}:${sessionId}`
    this.sessionCapabilities.delete(key)
    this.closingSessions.set(key, (this.closingSessions.get(key) ?? 0) + 1)
    try { await this.cancelMatching((task) => task.ownerId === ownerId && task.event.sessionId === sessionId) }
    finally {
      const remaining = this.closingSessions.get(key)! - 1
      if (remaining) this.closingSessions.set(key, remaining); else this.closingSessions.delete(key)
    }
  }

  async cancelOwner(ownerId: number): Promise<void> {
    this.ownerCapabilities.delete(ownerId)
    for (const key of this.sessionCapabilities.keys()) if (key.startsWith(`${ownerId}:`)) this.sessionCapabilities.delete(key)
    this.closingOwners.set(ownerId, (this.closingOwners.get(ownerId) ?? 0) + 1)
    try { await this.cancelMatching((task) => task.ownerId === ownerId) }
    finally {
      this.bandwidth.delete(ownerId)
      const remaining = this.closingOwners.get(ownerId)! - 1
      if (remaining) this.closingOwners.set(ownerId, remaining); else this.closingOwners.delete(ownerId)
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.ownerCapabilities.clear(); this.sessionCapabilities.clear()
    await this.cancelMatching(() => true)
    this.bandwidth.clear()
  }

  private async cancelMatching(matches: (task: Task) => boolean): Promise<void> {
    const tasks = [...this.jobs.values()].filter((task) => matches(task) && this.pending(task))
    for (const task of tasks) this.cancelTask(task)
    await Promise.all(tasks.map((task) => task.promise))
  }

  private cancelTask(task: Task): void {
    if (task.committing || !this.pending(task)) return
    task.controller.abort()
    if (!task.started) this.finish(task, 'canceled', 'Canceled before starting.')
  }

  private ensureCapacity(count: number): void {
    const pending = [...this.jobs.values()].filter((task) => this.pending(task)).length
    if (pending + count > 200) throw new Error('The transfer queue is full (200 pending files).')
    // Keep completed metadata bounded. Active jobs are never discarded.
    for (const [id, task] of this.jobs) {
      if (this.jobs.size + count <= 500) break
      if (!this.pending(task)) this.jobs.delete(id)
    }
  }

  private enqueue(ownerId: number, sessionId: string, direction: TransferJob['direction'], source: string, destination: string, name: string, action: Task['action']): Promise<TransferJob> {
    let complete!: Task['complete']
    const promise = new Promise<TransferJob>((resolve) => { complete = resolve })
    const task: Task = {
      ownerId, action, complete, promise, controller: new AbortController(), committing: false, lastProgress: 0,
      gate: new TransferGate(), started: false, activeMilliseconds: 0, samples: [],
      event: { id: randomUUID(), sessionId, direction, source, destination, name, transferred: 0, total: 0, status: 'queued', startedAt: Date.now() }
    }
    this.jobs.set(task.event.id, task)
    const key = `${ownerId}:${sessionId}`
    const queue = this.queues.get(key) ?? []
    queue.push(task)
    this.queues.set(key, queue)
    this.refreshQueue(key)
    queueMicrotask(() => { void this.drain(key) })
    return promise
  }

  private async drain(key: string): Promise<void> {
    if (this.draining.has(key)) return
    this.draining.add(key)
    try {
      while (true) {
        const queue = this.queues.get(key)
        const next = queue?.findIndex((task) => task.event.status === 'queued') ?? -1
        if (!queue || next < 0) break
        const task = queue.splice(next, 1)[0]
        task.started = true
        task.event.queuePosition = undefined
        task.event.status = 'running'
        task.event.startedAt = Date.now()
        task.activeSince = performance.now()
        task.samples = [{ time: 0, bytes: 0 }]
        this.refreshQueue(key)
        this.emit(task)
        try {
          await task.action(task)
          this.finish(task, 'completed')
        } catch (error) {
          this.finish(task, task.failure || !task.controller.signal.aborted ? 'failed' : 'canceled', task.failure ? transferError(task.failure) : task.controller.signal.aborted ? 'Transfer canceled.' : transferError(error))
        }
      }
    } finally {
      this.refreshQueue(key)
      this.draining.delete(key)
    }
  }

  private emit(task: Task): void {
    const root = task.parent ?? task
    if (task.parent) root.event.transferred = (task.progressBase ?? 0) + task.event.transferred
    root.event.bandwidthLimit = this.ownerBandwidth(root.ownerId).limit
    root.event.bytesPerSecond = 0
    root.event.etaSeconds = undefined
    if (root.event.status === 'running' && root.event.transferred > 0) {
      const now = root.activeMilliseconds + (root.activeSince === undefined ? 0 : performance.now() - root.activeSince)
      const samples = root.samples
      const previous = samples.at(-1)
      if (!previous || now !== previous.time || root.event.transferred !== previous.bytes) samples.push({ time: now, bytes: root.event.transferred })
      while (samples.length > 64 || samples.length > 2 && samples[1].time < now - 3000) samples.shift()
      const first = samples[0]
      root.event.bytesPerSecond = Math.max(0, Math.round((root.event.transferred - first.bytes) / Math.max(0.2, (now - first.time) / 1000)))
      if (root.event.bytesPerSecond > 0 && root.event.total >= root.event.transferred) root.event.etaSeconds = Math.ceil((root.event.total - root.event.transferred) / root.event.bytesPerSecond)
    }
    this.notify(root.ownerId, { ...root.event })
  }

  private finish(task: Task, status: 'completed' | 'failed' | 'canceled', message?: string): void {
    task.event.status = status
    task.event.message = message
    task.event.finishedAt = Date.now()
    task.event.queuePosition = undefined
    this.emit(task)
    task.complete({ ...task.event })
    this.refreshQueue(this.key(task))
  }

  private async batch(promises: Promise<TransferJob>[]): Promise<TransferResult> {
    const jobs = await Promise.all(promises)
    const failures = jobs.filter((job) => job.status === 'failed')
    if (failures.length) throw new Error(`${failures.length} ${failures.length === 1 ? 'file could' : 'files could'} not be transferred. ${failures[0].message ?? 'See transfer details.'}`)
    const files = jobs.filter((job) => job.status === 'completed').map((job) => job.destination)
    return { canceled: files.length === 0, files }
  }

  private progress(task: Task): Transform {
    const manager = this
    const bandwidth = this.ownerBandwidth(task.ownerId)
    return new Transform({
      highWaterMark: 64 * 1024,
      transform(chunk: Buffer, _encoding, callback) {
        const send = async () => {
          let offset = 0
          while (offset < chunk.length) {
            const length = await bandwidth.acquire(chunk.length - offset, task.gate, task.controller.signal)
            await task.gate.wait(task.controller.signal)
            this.push(chunk.subarray(offset, offset + length))
            offset += length
            task.event.transferred += length
            const now = Date.now()
            if (now - task.lastProgress >= 80 || task.event.transferred >= task.event.total) {
              task.lastProgress = now
              manager.emit(task)
            }
          }
        }
        void send().then(() => callback(), (error: Error) => callback(error))
      }
    })
  }

  private async checkpoint(task: Task): Promise<void> { await task.gate.wait(task.controller.signal) }

  private fail(task: Task, error: unknown): void {
    const root = task.parent ?? task
    if (root.controller.signal.aborted) return
    root.failure = error instanceof Error ? error : new Error(errorMessage(error))
    // A failed pipeline can otherwise leave its asynchronous transform waiting
    // forever on a paused gate, retaining a chunk and a limiter subscription.
    root.controller.abort(root.failure)
  }

  private async transfer(task: Task, reader: Readable, writer: Writable): Promise<void> {
    try {
      await pipeline(reader, this.progress(task), writer, { signal: task.controller.signal })
    } catch (error) {
      this.fail(task, error)
      throw error
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
    await this.checkpoint(task)
    const sftp = await abortable(this.getSftp(task.ownerId, task.event.sessionId), signal)
    const closed = () => this.fail(task, new Error('The SFTP channel closed during this transfer. Retry to open a new file channel.'))
    sftp.once('end', closed)
    sftp.once('close', closed)
    sftp.once('error', closed)
    try { await this.runTreeWithChannel(task, sftp, confirm) }
    finally { sftp.off('end', closed); sftp.off('close', closed); sftp.off('error', closed) }
  }

  private async runTreeWithChannel(task: Task, sftp: SFTPWrapper, confirm: ConfirmReplacement): Promise<void> {
    const signal = task.controller.signal
    await this.checkpoint(task)
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
      await this.checkpoint(task)
      const destination = task.event.direction === 'upload' ? path.posix.join(task.event.destination, entry.relative) : path.join(task.event.destination, ...entry.relative.split('/'))
      if (entry.directory) {
        if (task.event.direction === 'upload') await ensureRemoteDirectory(sftp, destination)
        else await ensureLocalDirectory(destination)
        continue
      }
      const child: Task = { ...task, parent: task, progressBase: completedBytes, committing: false, lastProgress: 0,
        event: { ...task.event, source: task.event.direction === 'upload' ? path.join(task.event.source, ...entry.relative.split('/')) : path.posix.join(task.event.source, entry.relative), destination, name: entry.relative, transferred: 0, total: entry.size } }
      task.activeChild = child
      try { if (task.event.direction === 'upload') await this.runUpload(child, confirm); else await this.runDownload(child, confirm) }
      catch (error) { throw new Error(`${entry.relative}: ${errorMessage(error)}`) }
      finally { task.activeChild = undefined }
      completedBytes += child.event.transferred
      task.event.transferred = completedBytes
      this.emit(task)
    }
  }

  private async runUpload(task: Task, confirm: ConfirmReplacement): Promise<void> {
    const { signal } = task.controller
    await this.checkpoint(task)
    const sftp = await abortable(this.getSftp(task.ownerId, task.event.sessionId), signal)
    await this.checkpoint(task)
    const source = await abortable(lstat(task.event.source), signal)
    if (!source.isFile()) throw new Error('Only regular local files can be uploaded.')
    if (task.parent && source.size !== task.event.total) throw new Error('The source file changed size after the folder was scanned. Retry after it stops changing.')
    task.event.total = source.size
    this.emit(task)
    await this.checkpoint(task)
    const existing = await abortable(remoteStat(sftp, task.event.destination), signal)
    if (existing?.isDirectory()) throw new Error('A directory with this name already exists on the server.')
    if (existing?.isSymbolicLink()) throw new Error('Rename the destination symbolic link before uploading.')
    if (existing && !(await confirm(task.event.destination, signal))) { task.controller.abort(); signal.throwIfAborted() }
    await this.checkpoint(task)
    const temporary = path.posix.join(path.posix.dirname(task.event.destination), `.ssh-heaven-${task.event.id}.part`)
    const mode = existing ? existing.mode & 0o777 : source.mode & 0o755
    let owned = false, ending = false, remoteHandle: Buffer | undefined
    try {
      // Observe exclusive OPEN itself: a failed 'wx' must never authorize
      // unlinking a pre-existing sibling, including on cancellation/error.
      remoteHandle = await rpc<Buffer>((callback) => sftp.open(temporary, 'wx', mode, (error, handle) => {
        if (!error && handle) {
          owned = true
          if (ending) {
            // An OPEN acknowledged after its timeout still owns its handle.
            // The failed job will not start another child at this random path.
            void rpc<void>((closed) => sftp.close(handle, closed), 3_000).then(() => rpc<void>((removed) => sftp.unlink(temporary, removed), 3_000)).catch(() => {})
            return
          }
        }
        callback(error, handle)
      }))
      try { await rpc<void>((callback) => sftp.fchmod(remoteHandle!, mode, callback)) }
      catch { await rpc<void>((callback) => sftp.chmod(temporary, mode, callback)) }
      await this.checkpoint(task)
      const writer = sftp.createWriteStream(temporary, { handle: remoteHandle, flags: 'w', mode })
      remoteHandle = undefined // The stream now owns and closes this handle.
      const reader = createReadStream(task.event.source, { highWaterMark: 64 * 1024 })
      await this.transfer(task, reader, writer)
      await this.checkpoint(task)
      if (task.event.transferred !== task.event.total) throw new Error('The source file changed size during upload. Retry after it stops changing.')
      const unchanged = await abortable(lstat(task.event.source), signal)
      if (!unchanged.isFile() || unchanged.dev !== source.dev || unchanged.ino !== source.ino || unchanged.size !== source.size || unchanged.mtimeMs !== source.mtimeMs) throw new Error('The source file changed during upload. The destination was preserved; retry after the source stops changing.')
      // An absent destination may have appeared during the stream. Ask again
      // before replacing it, rather than silently overwriting a new file.
      const current = await abortable(remoteStat(sftp, task.event.destination), signal)
      if (current?.isDirectory() || current?.isSymbolicLink()) throw new Error('The upload destination changed to a folder or symbolic link.')
      const changedDestination = current && (!existing || existing.size !== current.size || existing.mtime !== current.mtime || existing.mode !== current.mode)
      if (changedDestination && !(await confirm(task.event.destination, signal))) { task.controller.abort(); signal.throwIfAborted() }
      await this.checkpoint(task)
      task.committing = true
      await finalizeUpload(sftp, temporary, task.event.destination, Boolean(current))
    } finally {
      ending = true
      if (remoteHandle) await rpc<void>((callback) => sftp.close(remoteHandle!, callback), 3_000).catch(() => {})
      // Only an acknowledged exclusive creation grants cleanup permission.
      if (owned) await rpc<void>((callback) => sftp.unlink(temporary, callback), 3_000).catch(() => {})
    }
  }

  private async runDownload(task: Task, confirm: ConfirmReplacement): Promise<void> {
    const { signal } = task.controller
    await this.checkpoint(task)
    const sftp = await abortable(this.getSftp(task.ownerId, task.event.sessionId), signal)
    await this.checkpoint(task)
    const source = await abortable(remoteStat(sftp, task.event.source), signal)
    if (!source?.isFile()) throw new Error('Only regular remote files can be downloaded.')
    if (task.parent && source.size !== task.event.total) throw new Error('The source file changed size after the folder was scanned. Retry after it stops changing.')
    task.event.total = source.size
    this.emit(task)
    await this.checkpoint(task)
    const existing = await abortable(localStat(task.event.destination), signal)
    if (existing?.isSymbolicLink()) throw new Error('Rename the destination symbolic link before downloading.')
    if (existing?.isDirectory()) throw new Error('A folder with this name already exists in the download folder.')
    if (existing && !(await confirm(task.event.destination, signal))) { task.controller.abort(); signal.throwIfAborted() }
    await this.checkpoint(task)
    const temporary = path.join(path.dirname(task.event.destination), `.ssh-heaven-${task.event.id}.part`)
    let owned: { dev: number; ino: number } | undefined, handle: FileHandle | undefined
    try {
      handle = await open(temporary, 'wx', 0o600)
      owned = await handle.stat()
      await this.checkpoint(task)
      const reader = sftp.createReadStream(task.event.source, { highWaterMark: 64 * 1024 })
      const writer = handle.createWriteStream()
      await this.transfer(task, reader, writer)
      await this.checkpoint(task)
      if (task.event.transferred !== task.event.total) throw new Error('The source file changed size during download. Retry after it stops changing.')
      const unchanged = await abortable(remoteStat(sftp, task.event.source), signal)
      if (!unchanged?.isFile() || unchanged.size !== source.size || unchanged.mtime !== source.mtime) throw new Error('The remote source changed during download. The destination was preserved; retry after the source stops changing.')
      const current = await abortable(localStat(task.event.destination), signal)
      if (current?.isSymbolicLink()) throw new Error('The download destination changed to a symbolic link.')
      if (current?.isDirectory()) throw new Error('A folder appeared at the download destination.')
      const changedDestination = current && (!existing || existing.dev !== current.dev || existing.ino !== current.ino || existing.size !== current.size || existing.mtimeMs !== current.mtimeMs)
      if (changedDestination && !(await confirm(task.event.destination, signal))) { task.controller.abort(); signal.throwIfAborted() }
      await this.checkpoint(task)
      const partial = await abortable(localStat(temporary), signal)
      if (!partial?.isFile() || partial.isSymbolicLink() || partial.dev !== owned.dev || partial.ino !== owned.ino || partial.size !== task.event.total) throw new Error('The temporary download file changed. The destination was preserved.')
      await this.checkpoint(task)
      task.committing = true
      await rename(temporary, task.event.destination)
    } finally {
      await handle?.close().catch(() => {})
      const current = owned && await localStat(temporary).catch(() => null)
      if (current?.isFile() && !current.isSymbolicLink() && current.dev === owned!.dev && current.ino === owned!.ino) await unlink(temporary).catch(() => {})
    }
  }
}
