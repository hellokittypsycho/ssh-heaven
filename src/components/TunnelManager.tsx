import { useEffect, useState } from 'react'
import { ArrowRight, LoaderCircle, Network, Plus, Square, Trash2 } from 'lucide-react'
import type { HostProfile, LibraryState, SshHeavenApi, TunnelInfo, TunnelRule } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import './tunnel-manager.css'

type ConnectedHost = { id: string; profile: HostProfile }
export function TunnelManager({ api, sessions, initialSessionId, library, onChanged, onClose }: { api: SshHeavenApi; sessions: ConnectedHost[]; initialSessionId?: string; library: LibraryState; onChanged: () => Promise<void>; onClose: () => void }) {
  const [sessionId, setSessionId] = useState(initialSessionId || sessions[0]?.id || '')
  const [name, setName] = useState('')
  const [direction, setDirection] = useState<TunnelRule['direction']>('local')
  const [bindPort, setBindPort] = useState(8080)
  const [targetHost, setTargetHost] = useState('127.0.0.1')
  const [targetPort, setTargetPort] = useState(80)
  const [saveRule, setSaveRule] = useState(false)
  const [selectedRuleId, setSelectedRuleId] = useState('')
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [tunnels, setTunnels] = useState<TunnelInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stopping, setStopping] = useState<string | null>(null)
  const selected = sessions.find((session) => session.id === sessionId)
  const ids = sessions.map((session) => session.id).join(',')
  useEffect(() => { setSelectedRuleId(''); setConfirmRemove(false) }, [sessionId])
  useEffect(() => { if (!sessions.some((session) => session.id === sessionId)) setSessionId(sessions[0]?.id || '') }, [ids, sessionId, sessions])
  useEffect(() => {
    let active = true
    const unsubscribe = api.onTunnel((tunnel) => { if (active) setTunnels((current) => [...current.filter((item) => item.id !== tunnel.id), tunnel]) })
    void api.listTunnels().then((loaded) => { if (active) setTunnels((current) => [...loaded.filter((item) => !current.some((live) => live.id === item.id)), ...current]) }).catch((cause) => { if (active) setError(errorMessage(cause)) })
    return () => { active = false; unsubscribe() }
  }, [api])
  function useRule(id: string) {
    setSelectedRuleId(id); setConfirmRemove(false)
    const rule = library.tunnelRules.find((item) => item.id === id)
    if (!rule) return
    setName(rule.name); setDirection(rule.direction); setBindPort(rule.bindPort); setTargetHost(rule.targetHost); setTargetPort(rule.targetPort)
  }
  async function start(event: React.FormEvent) {
    event.preventDefault(); if (busy || !selected) return
    if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535 || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 || !targetHost.trim()) { setError('Enter a target host, listening port from 0 to 65535, and target port from 1 to 65535.'); return }
    setBusy(true); setError('')
    const rule: TunnelRule = { id: crypto.randomUUID(), name: name.trim() || `${direction === 'local' ? 'Local' : 'Remote'} ${bindPort}`, direction, bindPort, targetHost: targetHost.trim(), targetPort, profileId: selected.profile.id }
    try {
      const tunnel = await api.startTunnel(sessionId, rule)
      setTunnels((current) => [...current.filter((item) => item.id !== tunnel.id), tunnel])
      if (saveRule) {
        try { const savedId = selectedRuleId || rule.id; await api.saveLibraryItem('tunnel', { ...rule, id: savedId }); await onChanged(); setSelectedRuleId(savedId) }
        catch (cause) { setError(`Tunnel started, but the rule could not be saved: ${errorMessage(cause)}`) }
      }
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function stop(id: string) {
    setStopping(id); setError('')
    try { await api.stopTunnel(id); setTunnels((current) => current.map((item) => item.id === id ? { ...item, status: 'closed' } : item)) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { setStopping(null) }
  }
  async function removeRule() {
    if (!selectedRuleId || removing) return
    setRemoving(true); setError('')
    try { await api.deleteLibraryItem('tunnel', selectedRuleId); await onChanged(); setSelectedRuleId(''); setConfirmRemove(false) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { setRemoving(false) }
  }
  return <Modal title="SSH tunnels" onClose={onClose} className="tunnel-manager">
    <p className="tunnel-intro">Forward a local or remote loopback port through a connected SSH session.</p>
    <div className="tunnel-manager-grid"><form onSubmit={(event) => void start(event)}><label className="field-label">Connection<select aria-label="Tunnel connection" value={sessionId} onChange={(event) => setSessionId(event.target.value)}><option value="">Choose a connected host</option>{sessions.map((session) => <option key={session.id} value={session.id}>{session.profile.name}</option>)}</select></label>{library.tunnelRules.length > 0 && <label className="field-label">Saved rule<select aria-label="Saved tunnel rule" value={selectedRuleId} disabled={busy || removing} onChange={(event) => useRule(event.target.value)}><option value="">Choose a saved rule</option>{library.tunnelRules.filter((rule) => !rule.profileId || rule.profileId === selected?.profile.id).map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></label>}{selectedRuleId && <div className="tunnel-note">{confirmRemove ? <><p>Remove this saved rule? Active tunnels will keep running.</p><div className="modal-actions"><button type="button" className="button secondary compact" disabled={removing} onClick={() => setConfirmRemove(false)}>Keep rule</button><button type="button" className="button danger-button compact" disabled={removing} onClick={() => void removeRule()}>{removing ? <LoaderCircle size={12} className="spin" /> : <Trash2 size={12} />}Confirm remove rule</button></div></> : <button type="button" className="button secondary compact" disabled={busy || removing} onClick={() => setConfirmRemove(true)}><Trash2 size={12} />Remove saved rule</button>}</div>}<label className="field-label">Rule name<span className="optional">optional</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Database access" maxLength={100} /></label><label className="field-label">Direction<select aria-label="Tunnel direction" value={direction} onChange={(event) => setDirection(event.target.value as TunnelRule['direction'])}><option value="local">Local forwarding</option><option value="remote">Remote forwarding</option></select></label><div className="form-row tunnel-port-row"><label className="field-label">Listening port<input type="number" min={0} max={65535} value={bindPort} onChange={(event) => setBindPort(Number(event.target.value))} required /></label><label className="field-label">Target port<input type="number" min={1} max={65535} value={targetPort} onChange={(event) => setTargetPort(Number(event.target.value))} required /></label></div><label className="field-label">Target host<input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} maxLength={253} required spellCheck={false} /></label><div className="tunnel-route"><code>127.0.0.1:{bindPort}</code><ArrowRight size={13} /><code>{targetHost}:{targetPort}</code></div><p className="tunnel-note">{direction === 'local' ? 'Listens on this device; the target is reached from the SSH server. Use port 0 to choose an available listening port.' : 'Listens on the SSH server; the target is reached from this device. Use port 0 to choose an available listening port.'}</p><label className="checkbox-label tunnel-save"><input type="checkbox" checked={saveRule} onChange={(event) => setSaveRule(event.target.checked)} />Save forwarding rule</label><button className="button primary" disabled={busy || removing || !selected}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}Start tunnel</button></form><section className="tunnel-list" aria-label="Tunnel list"><h3>Forwarding sessions</h3>{tunnels.map((tunnel) => <article key={tunnel.id}><header><Network size={16} /><strong>{tunnel.name}</strong><span className={`tunnel-status ${tunnel.status}`}>{tunnel.status}</span></header><p>{tunnel.direction} · 127.0.0.1:{tunnel.boundPort} → {tunnel.targetHost}:{tunnel.targetPort}</p>{tunnel.error && <p className="tunnel-error">{tunnel.error}</p>}{tunnel.status === 'active' && <button className="button secondary compact" disabled={stopping === tunnel.id} aria-label={`Stop tunnel ${tunnel.name}`} onClick={() => void stop(tunnel.id)}>{stopping === tunnel.id ? <LoaderCircle size={12} className="spin" /> : <Square size={11} />}Stop tunnel</button>}</article>)}{!tunnels.length && <div className="tunnel-empty"><Network size={26} /><p>No tunnels have been started.</p></div>}<p className="tunnel-note">Tunnels remain active until stopped or their SSH session disconnects.</p></section></div>
    {error && <div className="form-error" role="alert">{error}</div>}
  </Modal>
}
