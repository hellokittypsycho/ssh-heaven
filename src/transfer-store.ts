import { useSyncExternalStore } from 'react'
import type { TransferJob } from '../shared/types'

const jobs = new Map<string, TransferJob>()
const listeners = new Set<() => void>()
let snapshot: TransferJob[] = []
function publish() {
  snapshot = [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
  for (const listener of listeners) listener()
}
// Keep listening while the file browser is hidden, so active transfers remain discoverable.
const stop = window.sshHeaven.onTransfer((job) => {
  jobs.set(job.id, job)
  const finished = [...jobs.values()].filter((item) => !['running', 'queued'].includes(item.status))
  for (const item of finished.slice(0, Math.max(0, jobs.size - 150))) jobs.delete(item.id)
  publish()
})
if (import.meta.hot) import.meta.hot.dispose(stop)

export function useTransfers(sessionId: string) {
  const all = useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => snapshot)
  return all.filter((job) => job.sessionId === sessionId)
}
export function clearFinishedTransfers(sessionId: string) {
  for (const job of jobs.values()) if (job.sessionId === sessionId && !['running', 'queued'].includes(job.status)) jobs.delete(job.id)
  publish()
}
