import { useCallback, useSyncExternalStore } from 'react'
import type { TransferJob } from '../shared/types'

const active = (job: TransferJob) => ['running', 'queued', 'paused'].includes(job.status)
const EMPTY: TransferJob[] = []
const rank = (job: TransferJob) => active(job) ? job.queuePosition === undefined ? 0 : 1 : 2
const compare = (a: TransferJob, b: TransferJob) => rank(a) - rank(b) || (a.queuePosition !== undefined && b.queuePosition !== undefined ? a.queuePosition - b.queuePosition : 0) || b.startedAt - a.startedAt
interface SessionTransfers { jobs: Map<string, TransferJob>; snapshot: TransferJob[]; sort: boolean; listeners: Set<() => void> }
type Schedule = (notify: () => void) => () => void

/** Stable per-session snapshots avoid waking every hidden file browser. One
 * frame batches bursts; only membership/status/order changes sort the list. */
export class TransferStore {
  private readonly jobs = new Map<string, TransferJob>()
  private readonly sessions = new Map<string, SessionTransfers>()
  private readonly finished = new Set<string>()
  private readonly dirty = new Set<string>()
  private cancelFlush?: () => void
  constructor(private readonly schedule: Schedule = (notify) => { const timer = setTimeout(notify, 16); return () => clearTimeout(timer) }) {}
  private session(id: string): SessionTransfers {
    let state = this.sessions.get(id)
    if (!state) { state = { jobs: new Map(), snapshot: EMPTY, sort: false, listeners: new Set() }; this.sessions.set(id, state) }
    return state
  }
  private changed(id: string): void {
    this.dirty.add(id)
    this.cancelFlush ??= this.schedule(() => this.flush())
  }
  private remove(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.jobs.delete(id); this.finished.delete(id)
    const state = this.sessions.get(job.sessionId)
    if (state) { state.jobs.delete(id); state.sort = true; this.changed(job.sessionId) }
  }
  receive(job: TransferJob): void {
    let previous = this.jobs.get(job.id)
    if (previous) {
      const keys = Object.keys(job) as (keyof TransferJob)[]
      if (keys.length === Object.keys(previous).length && keys.every((key) => previous![key] === job[key])) return
      if (previous.sessionId !== job.sessionId) { this.remove(job.id); previous = undefined }
    }
    const updated = { ...job }, state = this.session(job.sessionId)
    state.sort ||= !previous || previous.status !== job.status || previous.queuePosition !== job.queuePosition || previous.startedAt !== job.startedAt
    state.jobs.set(job.id, updated); this.jobs.set(job.id, updated)
    if (active(job)) this.finished.delete(job.id); else this.finished.add(job.id)
    this.changed(job.sessionId)
    while (this.jobs.size > 150 && this.finished.size) this.remove(this.finished.values().next().value!)
  }
  getSnapshot(sessionId: string): TransferJob[] { return this.sessions.get(sessionId)?.snapshot ?? EMPTY }
  subscribe(sessionId: string, listener: () => void): () => void {
    const state = this.session(sessionId)
    state.listeners.add(listener)
    return () => { state.listeners.delete(listener); if (!state.listeners.size && !state.jobs.size) this.sessions.delete(sessionId) }
  }
  flush(): void {
    this.cancelFlush?.(); this.cancelFlush = undefined
    const changed = [...this.dirty]
    this.dirty.clear()
    for (const id of changed) {
      const state = this.sessions.get(id)
      if (!state) continue
      state.snapshot = !state.jobs.size ? EMPTY : state.sort ? [...state.jobs.values()].sort(compare) : state.snapshot.map((job) => state.jobs.get(job.id)!)
      state.sort = false
      for (const listener of [...state.listeners]) listener()
      if (!state.jobs.size && !state.listeners.size) this.sessions.delete(id)
    }
  }
  clearFinished(sessionId: string): void {
    for (const job of this.sessions.get(sessionId)?.jobs.values() ?? []) if (!active(job)) this.remove(job.id)
    this.flush()
  }
  dispose(): void {
    this.cancelFlush?.(); this.cancelFlush = undefined
    this.jobs.clear(); this.sessions.clear(); this.finished.clear(); this.dirty.clear()
  }
}
const store = new TransferStore()
const nativeApi = typeof window === 'undefined' ? undefined : window.sshHeaven
export const TRANSFER_BANDWIDTH_KEY = 'ssh-heaven:transfer-bandwidth-limit'
let bandwidthLimit = 0
let bandwidthRevision = 0
const bandwidthListeners = new Set<() => void>()
function publishBandwidth(value: number) {
  if (bandwidthLimit === value) return
  bandwidthLimit = value
  for (const listener of bandwidthListeners) listener()
}
function validLimit(value: number) { return Number.isSafeInteger(value) && (value === 0 || value >= 1024 && value <= 1024 ** 3) }
async function initializeBandwidth() {
  const revision = bandwidthRevision
  try {
    const saved = localStorage.getItem(TRANSFER_BANDWIDTH_KEY)
    const value = saved === null ? undefined : Number(saved)
    if (value !== undefined && validLimit(value)) {
      await nativeApi!.setTransferBandwidthLimit(value)
      if (revision === bandwidthRevision) publishBandwidth(value)
    } else {
      const current = await nativeApi!.getTransferBandwidthLimit()
      if (revision === bandwidthRevision) publishBandwidth(current)
    }
  } catch { /* A later explicit change retries the native setting. */ }
}
if (nativeApi) void initializeBandwidth()
// Keep listening while the file browser is hidden, so active transfers remain discoverable.
const stop = nativeApi?.onTransfer((job) => {
  if (job.bandwidthLimit !== undefined && validLimit(job.bandwidthLimit)) publishBandwidth(job.bandwidthLimit)
  store.receive(job)
})
if (import.meta.hot) import.meta.hot.dispose(() => { stop?.(); store.dispose() })

export function useTransfers(sessionId: string) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(sessionId, listener), [sessionId])
  const snapshot = useCallback(() => store.getSnapshot(sessionId), [sessionId])
  return useSyncExternalStore(subscribe, snapshot)
}
export function clearFinishedTransfers(sessionId: string) {
  store.clearFinished(sessionId)
}

export function useTransferBandwidthLimit(): number {
  return useSyncExternalStore((listener) => { bandwidthListeners.add(listener); return () => { bandwidthListeners.delete(listener) } }, () => bandwidthLimit)
}
export async function saveTransferBandwidthLimit(value: number): Promise<void> {
  if (!validLimit(value)) throw new Error('Choose unlimited bandwidth or a limit between 1 KiB/s and 1 GiB/s.')
  if (!nativeApi) throw new Error('The application transfer service is unavailable.')
  const revision = ++bandwidthRevision
  await nativeApi.setTransferBandwidthLimit(value)
  if (revision !== bandwidthRevision) return
  publishBandwidth(value)
  try { localStorage.setItem(TRANSFER_BANDWIDTH_KEY, String(value)) } catch { /* Native throttling remains active if preferences cannot be saved. */ }
}
