import { useEffect, useState } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpFromLine, Check, ChevronDown, ChevronRight, CircleAlert, Gauge, LoaderCircle, Pause, Play, RefreshCw, Trash2, X } from 'lucide-react'
import type { SshHeavenApi, TransferJob } from '../../shared/types'
import { clearFinishedTransfers, saveTransferBandwidthLimit, useTransferBandwidthLimit } from '../transfer-store'
import { errorMessage } from './Modal'
import './transfer-panel.css'

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}
export function formatEta(seconds: number): string {
  if (seconds < 1) return 'less than a second'
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
}
const limits = [0, 64 * 1024, 256 * 1024, 1024 ** 2, 5 * 1024 ** 2, 10 * 1024 ** 2]
export function TransferPanel({ sessionId, jobs, api, onError, onRetryComplete }: { sessionId: string; jobs: TransferJob[]; api: SshHeavenApi; onError: (message: string) => void; onRetryComplete?: () => void }) {
  const [expanded, setExpanded] = useState(true)
  const [canceling, setCanceling] = useState<Set<string>>(new Set())
  const bandwidth = useTransferBandwidthLimit()
  const [custom, setCustom] = useState(false)
  const [limitDraft, setLimitDraft] = useState('')
  const [savingLimit, setSavingLimit] = useState(false)
  useEffect(() => { setLimitDraft(bandwidth ? String(bandwidth / 1024) : '') }, [bandwidth])
  const active = jobs.filter((job) => ['queued', 'running', 'paused'].includes(job.status)).length
  const waiting = jobs.filter((job) => job.queuePosition !== undefined)
  async function action(id: string, run: () => Promise<void>) {
    setCanceling((current) => new Set([...current, id]))
    try { await run() } catch (error) { onError(errorMessage(error)) }
    finally { setCanceling((current) => { const next = new Set(current); next.delete(id); return next }) }
  }
  async function setLimit(value: number) {
    setSavingLimit(true)
    try { await saveTransferBandwidthLimit(value); setCustom(false) }
    catch (error) { onError(errorMessage(error)) }
    finally { setSavingLimit(false) }
  }
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
    {expanded && <><div className="sftp-bandwidth-controls"><Gauge size={13} aria-hidden="true" /><label><span>All transfers</span><select aria-label="Transfer bandwidth limit" disabled={savingLimit} value={custom ? 'custom' : limits.includes(bandwidth) ? bandwidth : 'saved-custom'} onChange={(event) => { if (event.target.value === 'custom') setCustom(true); else if (event.target.value !== 'saved-custom') void setLimit(Number(event.target.value)) }}>{limits.map((limit) => <option key={limit} value={limit}>{limit ? `${formatBytes(limit)}/s` : 'Unlimited speed'}</option>)}{!limits.includes(bandwidth) && <option value="saved-custom">{formatBytes(bandwidth)}/s · custom</option>}<option value="custom">Custom limit…</option></select></label></div>
      {custom && <form className="sftp-custom-bandwidth" onSubmit={(event) => { event.preventDefault(); const value = Number(limitDraft); if (!limitDraft.trim() || !Number.isFinite(value) || value < 1 || value > 1024 ** 2) { onError('Enter a bandwidth limit between 1 and 1,048,576 KiB/s.'); return }; void setLimit(Math.round(value * 1024)) }}><label><input type="number" aria-label="Custom transfer limit in KiB per second" min="1" max={1024 ** 2} step="any" value={limitDraft} onChange={(event) => setLimitDraft(event.target.value)} disabled={savingLimit} />KiB/s</label><button className="button secondary compact" disabled={savingLimit}>Apply</button><button type="button" className="icon-button" aria-label="Cancel custom bandwidth limit" onClick={() => setCustom(false)}><X size={13} /></button></form>}
      <div className="sftp-transfer-list">
      {!jobs.length && <div className="sftp-no-transfers">Uploads and downloads appear here.</div>}
      {jobs.map((job) => {
        const canCancel = ['running', 'queued', 'paused'].includes(job.status)
        const percent = job.status === 'completed' ? 100 : job.total > 0 ? Math.min(100, job.transferred / job.total * 100) : 0
        const speed = job.status === 'running' && (job.bytesPerSecond ?? 0) > 0 ? ` · ${formatBytes(job.bytesPerSecond!)}/s` : ''
        const eta = job.status === 'running' && job.etaSeconds !== undefined ? ` · ETA ${formatEta(job.etaSeconds)}` : ''
        const state = job.status === 'paused' ? job.queuePosition === undefined ? 'Paused in progress · this connection’s queue waits' : `Paused before starting · queue #${job.queuePosition}` : job.status === 'queued' ? `Waiting · queue #${job.queuePosition ?? 1}` : ''
        return <article key={job.id} className={`sftp-transfer-job ${job.status}`} aria-label={`${job.direction} ${job.name}: ${job.status}`}>
          <div className="sftp-transfer-icon">{job.status === 'completed' ? <Check size={15} /> : job.status === 'failed' ? <CircleAlert size={15} /> : job.direction === 'upload' ? <ArrowUpFromLine size={15} /> : <ArrowDownToLine size={15} />}</div>
          <div className="sftp-transfer-details">
            <div className="sftp-transfer-title"><strong title={job.destination}>{job.name}</strong><span>{job.status === 'running' ? `${Math.floor(percent)}%` : job.status}</span></div>
            {canCancel && <progress aria-label={`Transfer progress for ${job.name}`} max={100} value={percent} />}
            <small>{job.message || `${formatBytes(job.transferred)}${job.total ? ` / ${formatBytes(job.total)}` : ''}${speed}${eta}`}</small>
            {state && <small className="sftp-transfer-state">{state}</small>}
          </div>
          <div className="sftp-transfer-actions">{canCancel && <><button className="icon-button" disabled={canceling.has(job.id)} aria-label={`${job.status === 'paused' ? 'Resume' : 'Pause'} transfer ${job.name}`} title={job.status === 'paused' ? 'Resume without restarting' : 'Pause transfer'} onClick={() => void action(job.id, () => job.status === 'paused' ? api.resumeTransfer(job.id) : api.pauseTransfer(job.id))}>{job.status === 'paused' ? <Play size={13} /> : <Pause size={13} />}</button><button className="icon-button" disabled={canceling.has(job.id)} aria-label={`Cancel transfer ${job.name}`} title="Cancel transfer" onClick={() => void cancel(job.id)}>{canceling.has(job.id) ? <LoaderCircle size={13} className="spin" /> : <X size={14} />}</button></>}
          {job.queuePosition !== undefined && <><button className="icon-button" disabled={canceling.has(job.id) || job.queuePosition === 1} aria-label={`Move transfer ${job.name} up`} title="Move up in queue" onClick={() => void action(job.id, () => api.moveTransfer(job.id, -1))}><ArrowUp size={13} /></button><button className="icon-button" disabled={canceling.has(job.id) || job.queuePosition >= waiting.length} aria-label={`Move transfer ${job.name} down`} title="Move down in queue" onClick={() => void action(job.id, () => api.moveTransfer(job.id, 1))}><ArrowDown size={13} /></button></>}
          {(job.status === 'failed' || job.status === 'canceled') && <button className="icon-button" disabled={canceling.has(job.id)} aria-label={`Retry transfer ${job.name}`} title="Retry from the beginning" onClick={() => void retry(job.id)}>{canceling.has(job.id) ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={14} />}</button>}</div>
        </article>
      })}
    </div></>}
  </section>
}
