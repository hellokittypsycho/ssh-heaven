import { useSyncExternalStore } from 'react'
import type { TransferJob } from '../shared/types'

const jobs = new Map<string, TransferJob>()
const listeners = new Set<() => void>()
let snapshot: TransferJob[] = []
const active = (job: TransferJob) => ['running', 'queued', 'paused'].includes(job.status)
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
      await window.sshHeaven.setTransferBandwidthLimit(value)
      if (revision === bandwidthRevision) publishBandwidth(value)
    } else {
      const current = await window.sshHeaven.getTransferBandwidthLimit()
      if (revision === bandwidthRevision) publishBandwidth(current)
    }
  } catch { /* A later explicit change retries the native setting. */ }
}
void initializeBandwidth()
function publish() {
  const rank = (job: TransferJob) => active(job) ? job.queuePosition === undefined ? 0 : 1 : 2
  snapshot = [...jobs.values()].sort((a, b) => rank(a) - rank(b) || (a.queuePosition !== undefined && b.queuePosition !== undefined ? a.queuePosition - b.queuePosition : 0) || b.startedAt - a.startedAt)
  for (const listener of listeners) listener()
}
// Keep listening while the file browser is hidden, so active transfers remain discoverable.
const stop = window.sshHeaven.onTransfer((job) => {
  jobs.set(job.id, job)
  if (job.bandwidthLimit !== undefined && validLimit(job.bandwidthLimit)) publishBandwidth(job.bandwidthLimit)
  const finished = [...jobs.values()].filter((item) => !active(item))
  for (const item of finished.slice(0, Math.max(0, jobs.size - 150))) jobs.delete(item.id)
  publish()
})
if (import.meta.hot) import.meta.hot.dispose(stop)

export function useTransfers(sessionId: string) {
  const all = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => snapshot)
  return all.filter((job) => job.sessionId === sessionId)
}
export function clearFinishedTransfers(sessionId: string) {
  for (const job of jobs.values()) if (job.sessionId === sessionId && !active(job)) jobs.delete(job.id)
  publish()
}

export function useTransferBandwidthLimit(): number {
  return useSyncExternalStore((listener) => { bandwidthListeners.add(listener); return () => { bandwidthListeners.delete(listener) } }, () => bandwidthLimit)
}
export async function saveTransferBandwidthLimit(value: number): Promise<void> {
  if (!validLimit(value)) throw new Error('Choose unlimited bandwidth or a limit between 1 KiB/s and 1 GiB/s.')
  const revision = ++bandwidthRevision
  await window.sshHeaven.setTransferBandwidthLimit(value)
  if (revision !== bandwidthRevision) return
  publishBandwidth(value)
  try { localStorage.setItem(TRANSFER_BANDWIDTH_KEY, String(value)) } catch { /* Native throttling remains active if preferences cannot be saved. */ }
}
