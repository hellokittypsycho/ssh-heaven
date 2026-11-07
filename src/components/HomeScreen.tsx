import { useEffect, useState } from 'react'
import { ArrowRight, Clock3, History, House, KeyRound, LoaderCircle, Pencil, Plus, Search, Server, ShieldCheck, Star, TerminalSquare, Trash2, Zap } from 'lucide-react'
import type { HostProfile, RecentHost } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import './home.css'

function relativeTime(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return 'Just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(new Date(timestamp).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) })
}

export function HomeScreen({ profiles, recentHosts, connectedCount, onNewConnection, onSelectHost, onEditNickname, onFavorite, onGenerateKey, onOpenPalette, onClearRecent, quickConnectIds, quickConnecting, onQuickConnect }: {
  profiles: HostProfile[]
  recentHosts: RecentHost[]
  connectedCount: number
  onNewConnection: () => void
  onSelectHost: (profile: HostProfile) => void
  onEditNickname: (profile: HostProfile) => void
  onFavorite: (profile: HostProfile) => Promise<void>
  onGenerateKey: () => void
  onOpenPalette: () => void
  onClearRecent: () => Promise<void>
  quickConnectIds: ReadonlySet<string>
  quickConnecting: ReadonlySet<string>
  onQuickConnect: (profile: HostProfile) => Promise<void>
}) {
  const [now, setNow] = useState(Date.now)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  async function clear() {
    if (clearing) return
    setClearing(true)
    setError('')
    try { await onClearRecent(); setConfirmClear(false) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { setClearing(false) }
  }
  const favorites = profiles.filter((profile) => profile.favorite).slice(0, 6)
  const canQuickConnect = (candidate: HostProfile) => quickConnectIds.has(candidate.id) && profiles.some((profile) => profile.id === candidate.id && profile.authType === 'password' && candidate.authType === 'password' && profile.host.toLowerCase() === candidate.host.toLowerCase() && profile.port === candidate.port && profile.username === candidate.username)

  return <div className="home-screen">
    <header className="home-hero">
      <div className="home-hero-copy"><div className="home-eyebrow"><House size={13} />Home{connectedCount > 0 && <span className="home-live-badge"><span />{connectedCount} {connectedCount === 1 ? 'session' : 'sessions'} running</span>}</div><h1>Your workspace, ready.</h1><p>Pick up a recent connection or start something new.</p></div>
      <div className="home-hero-actions"><button className="button primary" onClick={onNewConnection}><Plus size={17} />New connection</button><button className="button secondary" onClick={onGenerateKey}><KeyRound size={16} />Generate SSH key</button></div>
    </header>

    <section className="home-recents" aria-label="Recently accessed hosts">
      <div className="home-section-heading"><div><h2><History size={18} />Recently accessed</h2><p>Your latest successful connections, ready for a return visit.</p></div>{recentHosts.length > 0 && <button className="button subtle compact" onClick={() => { setError(''); setConfirmClear(true) }}><Trash2 size={13} />Clear history</button>}</div>
      {recentHosts.length ? <div className="recent-host-grid">{recentHosts.map(({ profile, lastConnectedAt }) => <article className="recent-host-card" key={`${profile.id}:${profile.host}:${profile.port}:${profile.username}`}>
        <div className="recent-card-top"><div className="recent-host-icon"><Server size={19} /></div><div className="recent-card-actions"><button className={`icon-button ${profile.favorite ? 'is-favorite' : ''}`} aria-label={`${profile.favorite ? 'Unfavorite' : 'Favorite'} recent ${profile.name}`} aria-pressed={!!profile.favorite} onClick={() => void onFavorite(profile)} title={profile.favorite ? 'Remove from favorites' : 'Save as a favorite'}><Star size={15} fill={profile.favorite ? 'currentColor' : 'none'} /></button><button className="icon-button" aria-label={`Edit nickname for ${profile.name}`} title="Edit nickname" onClick={() => onEditNickname(profile)}><Pencil size={14} /></button></div></div>
        <h3>{profile.name}</h3><p className="recent-host-address" title={`${profile.username}@${profile.host}:${profile.port}`}>{profile.username}@{profile.host}<span>:{profile.port}</span></p>
        <div className="recent-host-meta"><span className="recent-group">{profile.group || 'Ungrouped'}</span><span><Clock3 size={12} /><time dateTime={new Date(lastConnectedAt).toISOString()} title={new Date(lastConnectedAt).toLocaleString()}>{relativeTime(lastConnectedAt, now)}</time></span></div>
        <div className="recent-card-footer"><button className="recent-connect" aria-label={`Open ${profile.name} connection`} onClick={() => onSelectHost(profile)}>Open connection<ArrowRight size={15} /></button>{canQuickConnect(profile) && <button className="recent-quick-connect" aria-label={`Quick connect recent ${profile.name}`} title="Connect using the saved password" aria-busy={quickConnecting.has(profile.id)} disabled={quickConnecting.has(profile.id)} onClick={() => void onQuickConnect(profile)}>{quickConnecting.has(profile.id) ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}Quick connect</button>}</div>
      </article>)}</div> : <div className="home-empty-history"><div className="home-empty-illustration"><History size={31} strokeWidth={1.5} /><span><TerminalSquare size={16} /></span></div><div><h3>Your next connection starts here.</h3><p>After you connect to a server, it will appear here with its nickname and last access time.</p><button className="home-text-action" onClick={onNewConnection}>Create your first connection<ArrowRight size={14} /></button></div></div>}
    </section>

    {favorites.length > 0 && <section className="home-favorites" aria-label="Favorite hosts"><div className="home-section-heading"><div><h2><Star size={17} />Your go-to hosts</h2></div></div><div className="home-favorite-list">{favorites.map((profile) => <button className="home-favorite" key={profile.id} onClick={() => onSelectHost(profile)} aria-label={`Open favorite ${profile.name}`}><span><Star size={15} fill="currentColor" /></span><div><strong>{profile.name}</strong><small>{profile.username}@{profile.host}</small></div><ArrowRight size={15} /></button>)}</div></section>}

    <section className="home-tools" aria-label="Workspace tools"><button className="home-tool" onClick={onGenerateKey}><span className="home-tool-icon"><KeyRound size={21} /></span><div><strong>SSH key generator</strong><p>Create an Ed25519 or RSA key pair.</p></div><ArrowRight size={17} /></button><button className="home-tool" onClick={onOpenPalette}><span className="home-tool-icon"><Search size={21} /></span><div><strong>Quick switcher</strong><p>Find a host or action with <kbd>Ctrl K</kbd>.</p></div><ArrowRight size={17} /></button></section>
    <footer className="home-privacy"><ShieldCheck size={15} /><span>Local connection history. Saved passwords use encrypted storage.</span></footer>
    {confirmClear && <Modal title="Clear recent connections?" onClose={() => { if (!clearing) setConfirmClear(false) }} className="small-modal"><p className="modal-description">Remove all hosts from your recently accessed list? Your saved hosts and active sessions will stay available.</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button secondary" disabled={clearing} onClick={() => setConfirmClear(false)}>Keep history</button><button className="button danger-button" disabled={clearing} onClick={() => void clear()}>{clearing ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}Clear recent connections</button></div></Modal>}
  </div>
}
