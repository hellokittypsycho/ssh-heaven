import { useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronRight, CircleAlert, LoaderCircle, RefreshCw, Trash2, X } from 'lucide-react'
import type { SshHeavenApi, TransferJob } from '../../shared/types'
import { clearFinishedTransfers } from '../transfer-store'
import { errorMessage } from './Modal'

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
export function TransferPanel({ sessionId, jobs, api, onError, onRetryComplete }: { sessionId: string; jobs: TransferJob[]; api: SshHeavenApi; onError: (message: string) => void; onRetryComplete?: () => void }) {
  const [expanded, setExpanded] = useState(true)
  const [canceling, setCanceling] = useState<Set<string>>(new Set())
  const active = jobs.filter((job) => ['queued', 'running'].includes(job.status)).length
  async function cancel(id: string) {
    setCanceling((current) => new Set([...current, id]))
    try { await api.cancelTransfer(id) } catch (error) { onError(errorMessage(error)) }
    finally { setCanceling((current) => { const next = new Set(current); next.delete(id); return next }) }
  }
  async function retry(id: string) {
    setCanceling((current) => new Set([...current, id]))
    try { await api.retryTransfer(id); onRetryComplete?.() } catch (error) { onError(errorMessage(error)) }
    finally { setCanceling((current) => { const next = new Set(current); next.delete(id); return next }) }
  }
  return <section className="sftp-transfers" aria-label="File transfers">
    <div className="sftp-transfer-heading">
      <button className="sftp-transfer-toggle" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<strong>Transfers</strong>
        <span className={active ? 'transfer-active-count' : ''}>{active ? `${active} active` : jobs.length ? `${jobs.length} finished` : 'No activity'}</span>
      </button>
      {jobs.length > active && <button className="icon-button" aria-label="Clear finished transfers" title="Clear finished transfers" onClick={() => clearFinishedTransfers(sessionId)}><Trash2 size={13} /></button>}
    </div>
    {expanded && <div className="sftp-transfer-list">
      {!jobs.length && <div className="sftp-no-transfers">Uploads and downloads appear here.</div>}
      {jobs.map((job) => {
        const canCancel = job.status === 'running' || job.status === 'queued'
        const percent = job.status === 'completed' ? 100 : job.total > 0 ? Math.min(100, job.transferred / job.total * 100) : 0
        const elapsed = Math.max(1, ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000)
        const speed = job.status === 'running' && job.transferred > 0 ? ` · ${formatBytes(Math.round(job.transferred / elapsed))}/s` : ''
        return <article key={job.id} className={`sftp-transfer-job ${job.status}`} aria-label={`${job.direction} ${job.name}: ${job.status}`}>
          <div className="sftp-transfer-icon">{job.status === 'completed' ? <Check size={15} /> : job.status === 'failed' ? <CircleAlert size={15} /> : job.direction === 'upload' ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}</div>
          <div className="sftp-transfer-details">
            <div className="sftp-transfer-title"><strong title={job.destination}>{job.name}</strong><span>{job.status === 'running' ? `${Math.floor(percent)}%` : job.status}</span></div>
            {canCancel && <progress aria-label={`Transfer progress for ${job.name}`} max={100} value={percent} />}
            <small>{job.message || `${formatBytes(job.transferred)}${job.total ? ` / ${formatBytes(job.total)}` : ''}${speed}`}</small>
          </div>
          {canCancel && <button className="icon-button" disabled={canceling.has(job.id)} aria-label={`Cancel transfer ${job.name}`} title="Cancel transfer" onClick={() => void cancel(job.id)}>{canceling.has(job.id) ? <LoaderCircle size={13} className="spin" /> : <X size={14} />}</button>}
          {(job.status === 'failed' || job.status === 'canceled') && <button className="icon-button" disabled={canceling.has(job.id)} aria-label={`Retry transfer ${job.name}`} title="Retry from the beginning" onClick={() => void retry(job.id)}>{canceling.has(job.id) ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={14} />}</button>}
        </article>
      })}
    </div>}
  </section>
}
