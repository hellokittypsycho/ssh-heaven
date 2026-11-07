import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Activity, ArrowDownUp, CircleHelp, CornerDownLeft, FileCode2, House, KeyRound, Layers, Network, Plus, Radio, RefreshCw, Search, Server, Settings2, Star, TerminalSquare, Zap } from 'lucide-react'
import type { HostProfile } from '../../shared/types'
import { Modal } from './Modal'
import './command-palette.css'

export interface PaletteSession {
  readonly id: string
  readonly profile: { readonly name: string; readonly host: string; readonly username: string; readonly group?: string }
  readonly status: string
}

type Filter = 'all' | 'sessions' | 'hosts' | 'actions'
type Kind = 'session' | 'host' | 'quick' | 'new' | 'home' | 'keygen' | 'scripts' | 'stream' | 'workspace' | 'management' | 'dashboard' | 'tunnel' | 'updates' | 'help'
type Section = 'Open sessions' | 'Saved hosts' | 'Quick connect' | 'Actions'
interface Result {
  id: string
  label: string
  detail: string
  type: Kind
  category: Exclude<Filter, 'all'>
  section: Section
  favorite?: boolean
  busy?: boolean
  current?: boolean
  status?: string
  run: () => void
}

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'sessions', label: 'Sessions' },
  { id: 'hosts', label: 'Hosts' }, { id: 'actions', label: 'Actions' }
]
const VISIBLE_LIMIT = 200
const statusLabel = (status: string) => ({ connected: 'Connected', connecting: 'Connecting', verifying: 'Verifying host', error: 'Connection failed', disconnected: 'Disconnected' })[status] ?? status.replace(/^./, (first) => first.toUpperCase())
const statusClass = (status: string) => status === 'connected' ? 'online' : ['connecting', 'verifying'].includes(status) ? 'pending' : status === 'error' ? 'failed' : 'offline'

export function CommandPalette({ sessions, activeSessionId, onSelectSession, onUpdates, profiles, onSelectHost, onNewConnection, onHelp, onHome, onGenerateKey, onAppearance, onBulkImport, onGroupCommand, onWorkspaces, onManagement, onDashboard, onTunnels, onMcp, onScripts, onVault, onToggleStreamMode, streamMode, onClose, quickConnectIds, quickConnecting, onQuickConnect }: {
  sessions: readonly PaletteSession[]
  activeSessionId?: string
  onSelectSession: (id: string) => void
  onUpdates: () => void
  profiles: HostProfile[]
  onSelectHost: (profile: HostProfile) => void
  onNewConnection: () => void
  onHelp: () => void
  onHome: () => void
  onGenerateKey: () => void
  onAppearance: () => void
  onBulkImport: () => void
  onGroupCommand: () => void
  onWorkspaces: () => void
  onManagement: () => void
  onDashboard: () => void
  onTunnels: () => void
  onMcp: () => void
  onScripts: () => void
  onVault: () => void
  onToggleStreamMode: () => void
  streamMode: boolean
  onClose: () => void
  quickConnectIds: ReadonlySet<string>
  quickConnecting: ReadonlySet<string>
  onQuickConnect: (profile: HostProfile) => Promise<void>
}) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [focusedFilter, setFocusedFilter] = useState<Filter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const filterRefs = useRef(new Map<Filter, HTMLButtonElement>())
  const resultRefs = useRef(new Map<string, HTMLButtonElement>())

  const allResults = useMemo<Result[]>(() => {
    const normalized = query.trim().toLowerCase()
    const matches = (value: string) => value.toLowerCase().includes(normalized)
    const live: Result[] = sessions.filter((session) => matches(`Switch to ${session.profile.name} ${session.profile.username} ${session.profile.host} ${session.profile.group ?? ''} ${session.status} ${statusLabel(session.status)}`))
      .map((session) => ({ id: `session:${session.id}`, label: `Switch to ${session.profile.name}`, detail: `${session.profile.username}@${session.profile.host}${session.profile.group ? ` · ${session.profile.group}` : ''}`, type: 'session', category: 'sessions', section: 'Open sessions', status: session.status, current: session.id === activeSessionId, run: () => onSelectSession(session.id) }))
    const sorted = [...profiles].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name))
    const hosts: Result[] = sorted.filter((host) => matches(`${host.name} ${host.host} ${host.username} ${host.group ?? ''}`))
      .map((host) => ({ id: `host:${host.id}`, label: host.name, detail: `${host.username}@${host.host}${host.group ? ` · ${host.group}` : ''}`, type: 'host', category: 'hosts', section: 'Saved hosts', favorite: host.favorite, run: () => onSelectHost(host) }))
    const quick: Result[] = sorted.filter((host) => quickConnectIds.has(host.id) && matches(`Quick connect ${host.name} ${host.host} ${host.username} ${host.group ?? ''}`))
      .map((host) => ({ id: `quick:${host.id}`, label: `Quick connect ${host.name}`, detail: quickConnecting.has(host.id) ? 'Connecting…' : `Saved password · ${host.username}@${host.host}`, type: 'quick', category: 'hosts', section: 'Quick connect', busy: quickConnecting.has(host.id), run: () => { void onQuickConnect(host) } }))
    const actions: Result[] = [
      { id: 'new', label: 'New connection', detail: 'Open a server connection', type: 'new', run: onNewConnection },
      { id: 'home', label: 'Go to Home', detail: 'Your workspace and recently accessed hosts', type: 'home', run: onHome },
      { id: 'keygen', label: 'Generate SSH key', detail: 'Create an Ed25519 or RSA key pair on this device', type: 'keygen', run: onGenerateKey },
      { id: 'appearance', label: 'Appearance', detail: 'Color presets, themes, wallpapers, and animated GIFs', type: 'help', run: onAppearance },
      { id: 'scripts', label: 'Scripts', detail: 'Save shell scripts and run them in a connected terminal', type: 'scripts', run: onScripts },
      { id: 'vault', label: 'Vault', detail: 'PIN-protected password and SSH key manager', type: 'keygen', run: onVault },
      { id: 'stream-mode', label: streamMode ? 'Disable stream mode' : 'Enable stream mode', detail: 'Privacy: hide IP addresses while sharing your screen', type: 'stream', run: onToggleStreamMode },
      { id: 'import', label: 'Bulk import hosts', detail: 'Add server credentials or a shared SSH key', type: 'new', run: onBulkImport },
      { id: 'group-command', label: 'Run group command', detail: 'Review and execute a command across a host group', type: 'new', run: onGroupCommand },
      { id: 'workspaces', label: 'Workspaces', detail: 'Save host selections and terminal layouts', type: 'workspace', run: onWorkspaces },
      { id: 'management', label: 'Manage workspace', detail: 'Runbooks, named keys, group defaults, backups, and updates', type: 'management', run: onManagement },
      { id: 'dashboard', label: 'Server dashboard', detail: 'CPU, memory, disk, and uptime for connected hosts', type: 'dashboard', run: onDashboard },
      { id: 'tunnels', label: 'SSH tunnels', detail: 'Local and remote port forwarding', type: 'tunnel', run: onTunnels },
      { id: 'mcp', label: 'MCP server', detail: 'Connect external AI assistants to SSH Heaven', type: 'tunnel', run: onMcp },
      { id: 'updates', label: 'Check for updates', detail: 'Open Updates to review versions and manual downloads', type: 'updates', run: onUpdates },
      { id: 'help', label: 'Help & keyboard shortcuts', detail: 'Find your way around', type: 'help', run: onHelp }
    ].filter((action) => matches(`${action.label} ${action.detail}`)).map((action) => ({ ...action, id: `action:${action.id}`, type: action.type as Kind, category: 'actions', section: 'Actions' }))
    return [...live, ...hosts, ...quick, ...actions]
  }, [query, sessions, activeSessionId, profiles, onSelectSession, onUpdates, onSelectHost, onNewConnection, onHelp, onHome, onGenerateKey, onAppearance, onBulkImport, onGroupCommand, onWorkspaces, onManagement, onDashboard, onTunnels, onMcp, onScripts, onVault, onToggleStreamMode, streamMode, quickConnectIds, quickConnecting, onQuickConnect])
  const counts = { all: allResults.length, sessions: 0, hosts: 0, actions: 0 }
  for (const result of allResults) counts[result.category]++
  const matchingResults = filter === 'all' ? allResults : allResults.filter((result) => result.category === filter)
  const results = matchingResults.slice(0, VISIBLE_LIMIT)
  const selectedIndex = results.findIndex((result) => result.id === selectedId)
  const activeIndex = selectedIndex < 0 ? 0 : selectedIndex
  const activeResult = results[activeIndex]

  useEffect(() => {
    const container = resultsRef.current
    const row = activeResult && resultRefs.current.get(activeResult.id)
    if (!container || !row) return
    const bounds = container.getBoundingClientRect()
    const item = row.getBoundingClientRect()
    if (item.top < bounds.top + 29) container.scrollTop -= bounds.top + 29 - item.top
    else if (item.bottom > bounds.bottom) container.scrollTop += item.bottom - bounds.bottom
  }, [activeResult?.id, filter, query])

  useEffect(() => {
    const closeShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.code !== 'KeyK') return
      const dialog = resultsRef.current?.closest('[role="dialog"]')
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
      if (!dialog || dialogs[dialogs.length - 1] !== dialog) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', closeShortcut, true)
    return () => document.removeEventListener('keydown', closeShortcut, true)
  }, [onClose])

  const run = (result: Result | undefined) => {
    if (!result || result.busy) return
    onClose()
    result.run()
  }
  const chooseFilter = (id: Filter) => { setFilter(id); setFocusedFilter(id); setSelectedId(null) }
  const filterKey = (event: KeyboardEvent<HTMLButtonElement>, id: Filter) => {
    const index = FILTERS.findIndex((item) => item.id === id)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % FILTERS.length
    else if (event.key === 'ArrowLeft') next = (index + FILTERS.length - 1) % FILTERS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = FILTERS.length - 1
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseFilter(id); return }
    else return
    event.preventDefault()
    setFocusedFilter(FILTERS[next].id)
    filterRefs.current.get(FILTERS[next].id)?.focus({ preventScroll: true })
  }

  return <Modal title="Quick switcher" className="command-palette" onClose={onClose}>
    <div className="palette-search"><Search size={20} aria-hidden="true" /><input autoFocus autoComplete="off" spellCheck={false} role="combobox" aria-label="Search hosts and actions" aria-autocomplete="list" aria-expanded="true" aria-controls="palette-results" aria-activedescendant={activeResult ? `palette-item-${activeIndex}` : undefined} value={query} placeholder="Search sessions, hosts, groups, and actions…" onChange={(event) => { setQuery(event.target.value); setSelectedId(null) }} onKeyDown={(event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (results.length) setSelectedId(results[(activeIndex + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length].id)
      } else if (event.key === 'Enter') { event.preventDefault(); run(activeResult) }
    }} /><kbd>esc</kbd></div>
    <div className="palette-filters" role="tablist" aria-label="Switcher filters">
      {FILTERS.map((item) => <button key={item.id} type="button" role="tab" aria-label={item.label} aria-selected={filter === item.id} aria-controls="palette-results" aria-description={`${counts[item.id]} matching ${counts[item.id] === 1 ? 'choice' : 'choices'}`} tabIndex={focusedFilter === item.id ? 0 : -1} ref={(node) => { if (node) filterRefs.current.set(item.id, node); else filterRefs.current.delete(item.id) }} onFocus={() => setFocusedFilter(item.id)} onClick={() => chooseFilter(item.id)} onKeyDown={(event) => filterKey(event, item.id)}><span>{item.label}</span><span className="palette-filter-count" aria-hidden="true">{counts[item.id]}</span></button>)}
    </div>
    <div className="palette-results" ref={resultsRef} id="palette-results" role="listbox" aria-label="Hosts and actions">
      {results.length ? results.map((result, index) => {
        const Icon = result.type === 'session' ? TerminalSquare : result.type === 'host' ? Server : result.type === 'quick' ? Zap : result.type === 'new' ? Plus : result.type === 'home' ? House : result.type === 'keygen' ? KeyRound : result.type === 'scripts' ? FileCode2 : result.type === 'stream' ? Radio : result.type === 'workspace' ? Layers : result.type === 'management' ? Settings2 : result.type === 'dashboard' ? Activity : result.type === 'tunnel' ? Network : result.type === 'updates' ? RefreshCw : CircleHelp
        const heading = index === 0 || results[index - 1].section !== result.section
        return <Fragment key={result.id}>
          {heading && <div className="palette-section" role="presentation"><span>{result.section}</span><span>{matchingResults.filter((item) => item.section === result.section).length}</span></div>}
          <button type="button" id={`palette-item-${index}`} ref={(node) => { if (node) resultRefs.current.set(result.id, node); else resultRefs.current.delete(result.id) }} role="option" aria-label={result.type === 'session' || result.type === 'quick' ? result.label : undefined} aria-disabled={result.busy || undefined} aria-selected={index === activeIndex} aria-posinset={index + 1} aria-setsize={matchingResults.length} className={`palette-result ${index === activeIndex ? 'selected' : ''} ${result.type === 'session' ? 'palette-session-result' : ''}`} onMouseEnter={() => setSelectedId(result.id)} onClick={() => run(result)} tabIndex={-1}>
            <div className="palette-icon"><Icon size={18} aria-hidden="true" /></div>
            <div className="palette-result-copy"><strong><span className="palette-result-name">{result.label}</span>{result.favorite && <Star size={12} aria-label="Favorite" />}</strong><span className="palette-result-detail">{result.detail}</span></div>
            <div className="palette-result-trailing">{result.current && <span className="palette-current">Current</span>}{result.status && <span className="palette-session-status"><i className={`status-dot ${statusClass(result.status)}`} aria-hidden="true" />{statusLabel(result.status)}</span>}{index === activeIndex && <CornerDownLeft className="palette-return" size={16} aria-hidden="true" />}</div>
          </button>
        </Fragment>
      }) : <div className="palette-empty"><Search size={27} aria-hidden="true" /><strong>{!query.trim() && filter === 'sessions' ? 'No open SSH sessions' : !query.trim() && filter === 'hosts' ? 'No saved hosts' : 'No matching results'}</strong><span>{!query.trim() && filter === 'sessions' ? 'Connect to a host, then switch between terminals here.' : 'Try another name, host, group, or action.'}</span></div>}
    </div>
    <div className="palette-footer"><span><ArrowDownUp size={13} aria-hidden="true" /> Navigate</span><span><CornerDownLeft size={13} aria-hidden="true" /> {activeResult?.type === 'session' ? 'Switch session' : 'Open'}</span><span className="palette-total">{matchingResults.length > VISIBLE_LIMIT ? `${VISIBLE_LIMIT} of ${matchingResults.length} matches · keep typing to narrow` : `${matchingResults.length} ${matchingResults.length === 1 ? 'result' : 'results'}`}</span></div>
  </Modal>
}
