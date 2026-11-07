import { useEffect, useState } from 'react'
import { Activity, Cpu, HardDrive, LoaderCircle, MemoryStick, RefreshCw, Server } from 'lucide-react'
import type { HostProfile, ServerMetrics, SshHeavenApi } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import './server-dashboard.css'

type ConnectedHost = { id: string; profile: HostProfile }
const bytes = (value: number) => value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MB` : `${(value / 1024 ** 3).toFixed(1)} GB`
const percent = (used: number, total: number) => total > 0 ? Math.min(100, Math.max(0, used / total * 100)) : null
function uptime(seconds: number) { const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const minutes = Math.floor(seconds % 3600 / 60); return `${days ? `${days}d ` : ''}${hours}h ${minutes}m` }

export function ServerDashboard({ api, sessions, initialSessionId, onClose }: { api: SshHeavenApi; sessions: ConnectedHost[]; initialSessionId?: string; onClose: () => void }) {
  const [sessionId, setSessionId] = useState(initialSessionId || sessions[0]?.id || '')
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const ids = sessions.map((session) => session.id).join(',')
  useEffect(() => { if (!sessions.some((session) => session.id === sessionId)) setSessionId(sessions[0]?.id || '') }, [ids, sessionId, sessions])
  useEffect(() => {
    setMetrics(null); setError('')
    if (!sessionId) return
    let active = true
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      if (!active || busy || document.visibilityState === 'hidden') return
      busy = true; setLoading(true)
      try { const result = await api.getServerMetrics(sessionId); if (active) { setMetrics(result); setError('') } }
      catch (cause) { if (active) setError(errorMessage(cause)) }
      finally { busy = false; if (active) { setLoading(false); timer = setTimeout(() => void poll(), 5000) } }
    }
    const visibility = () => { if (timer) clearTimeout(timer); if (document.visibilityState !== 'hidden') void poll() }
    document.addEventListener('visibilitychange', visibility)
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
  }, [api, sessionId, refresh])
  const memory = metrics ? percent(metrics.memoryUsedBytes, metrics.memoryTotalBytes) : null
  const disk = metrics ? percent(metrics.diskUsedBytes, metrics.diskTotalBytes) : null
  return <Modal title="Server dashboard" onClose={onClose} className="server-dashboard">
    <div className="dashboard-toolbar"><label className="field-label">Connection<select aria-label="Dashboard connection" value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">Choose a connected host</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.profile.name} · {session.profile.username}@{session.profile.host}</option>)}</select></label><button className="icon-button" aria-label="Refresh server metrics" title="Refresh metrics" disabled={!sessionId || loading} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={17} className={loading ? 'spin' : ''} /></button></div>
    {!sessionId ? <div className="dashboard-empty"><Server size={29} /><p>Connect to a host to view its server dashboard.</p></div> : !metrics && loading ? <div className="dashboard-empty"><LoaderCircle className="spin" size={28} /><p>Reading server metrics…</p></div> : null}
    {error && <div className="form-error" role="alert">{error}</div>}
    {metrics && <><div className="dashboard-cards"><section><h3><Cpu size={17} />CPU</h3><output aria-label="CPU usage">{metrics.cpuPercent === null ? 'Unavailable' : `${metrics.cpuPercent.toFixed(1)}%`}</output>{metrics.cpuPercent !== null && <progress max={100} value={metrics.cpuPercent} />}</section><section><h3><MemoryStick size={17} />Memory</h3><output aria-label="Memory usage">{memory === null ? 'Unavailable' : `${memory.toFixed(1)}%`}</output>{memory !== null && <progress max={100} value={memory} />}<p>{metrics.memoryTotalBytes ? `${bytes(metrics.memoryUsedBytes)} of ${bytes(metrics.memoryTotalBytes)}` : 'No memory metrics reported'}</p></section><section><h3><HardDrive size={17} />Disk</h3><output aria-label="Disk usage">{disk === null ? 'Unavailable' : `${disk.toFixed(1)}%`}</output>{disk !== null && <progress max={100} value={disk} />}<p>{metrics.diskTotalBytes ? `${bytes(metrics.diskUsedBytes)} of ${bytes(metrics.diskTotalBytes)}` : 'No disk metrics reported'}</p></section></div><dl className="dashboard-details"><div><dt><Activity size={15} />Uptime</dt><dd>{uptime(metrics.uptimeSeconds)}</dd></div><div><dt><Server size={15} />Operating system</dt><dd>{metrics.os}</dd></div><div><dt>Last sampled</dt><dd>{new Date(metrics.sampledAt).toLocaleTimeString()}</dd></div></dl></>}
    <p className="dashboard-note">Refreshes every 5 seconds while this dashboard is visible. Availability depends on the server’s operating system and tools.</p>
  </Modal>
}
