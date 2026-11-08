import { useRef, useState } from 'react'
import { Download, LoaderCircle, PackageCheck, X } from 'lucide-react'
import type { SshHeavenApi, UpdateState } from '../../shared/types'
import './updates.css'

export function UpdateControls({ api, state, onInstall, onError }: {
  api: SshHeavenApi
  state: UpdateState
  onInstall: () => void
  onError: (error: unknown) => void
}) {
  const active = useRef(false)
  const [busy, setBusy] = useState(false)
  async function act(action: () => Promise<unknown>) {
    if (active.current) return
    active.current = true; setBusy(true)
    try { await action() } catch (error) { onError(error) }
    finally { active.current = false; setBusy(false) }
  }
  if (state.status === 'installing') return <span className="update-download-status" role="status"><LoaderCircle className="spin" size={15} />Starting installer…</span>
  if (state.status === 'downloading') return <div className="update-download-controls">
    <div className="update-download-meter"><progress aria-label="Update download progress" max={state.totalBytes || 1} value={state.downloadedBytes || 0} /><span>{state.totalBytes ? `${Math.min(100, Math.floor(100 * (state.downloadedBytes || 0) / state.totalBytes))}%` : 'Downloading…'}</span></div>
    <button className="button subtle compact" onClick={() => { void api.cancelUpdateDownload().catch(onError) }} aria-label="Cancel update download"><X size={14} />Cancel</button>
  </div>
  if (state.status === 'downloaded') return <button className="button primary compact" onClick={onInstall}><PackageCheck size={15} />Install now</button>
  if (state.status !== 'available') return null
  return state.downloadAvailable
    ? <button className="button primary compact" disabled={busy} onClick={() => void act(() => api.downloadUpdate())}>{busy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}Download update</button>
    : <button className="button secondary compact" disabled={busy} onClick={() => void act(() => api.openUpdateDownload())}><Download size={15} />Open download page</button>
}
