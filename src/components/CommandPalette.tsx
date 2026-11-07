import { useEffect, useMemo, useRef, useState } from 'react'
import { Activity, ArrowDownUp, CircleHelp, CornerDownLeft, FileCode2, House, KeyRound, Layers, Network, Plus, Radio, Search, Server, Settings2, Star, Zap } from 'lucide-react'
import type { HostProfile } from '../../shared/types'
import { Modal } from './Modal'

export function CommandPalette({ profiles, onSelectHost, onNewConnection, onHelp, onHome, onGenerateKey, onAppearance, onBulkImport, onGroupCommand, onWorkspaces, onManagement, onDashboard, onTunnels, onMcp, onScripts, onVault, onToggleStreamMode, streamMode, onClose, quickConnectIds, quickConnecting, onQuickConnect }: {
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
  const [selected, setSelected] = useState(0)
  const resultsRef = useRef<HTMLDivElement>(null)
  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    const hosts = [...profiles].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name))
      .filter((host) => `${host.name} ${host.host} ${host.username} ${host.group ?? ''}`.toLowerCase().includes(normalized))
      .map((host) => ({ id: host.id, label: host.name, detail: `${host.username}@${host.host}${host.group ? ` · ${host.group}` : ''}`, type: 'host' as const, favorite: host.favorite, run: () => onSelectHost(host) }))
    const quickHosts = profiles.filter((host) => quickConnectIds.has(host.id) && `Quick connect ${host.name} ${host.host} ${host.username} ${host.group ?? ''}`.toLowerCase().includes(normalized))
      .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name))
      .map((host) => ({ id: `quick:${host.id}`, label: `Quick connect ${host.name}`, detail: quickConnecting.has(host.id) ? 'Connecting…' : `Saved password · ${host.username}@${host.host}`, type: 'quick' as const, favorite: false, busy: quickConnecting.has(host.id), run: () => { void onQuickConnect(host) } }))
    const actions = [
      { id: 'new', label: 'New connection', detail: 'Open a server connection', type: 'new' as const, favorite: false, run: onNewConnection },
      { id: 'home', label: 'Go to Home', detail: 'Your workspace and recently accessed hosts', type: 'home' as const, favorite: false, run: onHome },
      { id: 'keygen', label: 'Generate SSH key', detail: 'Create an Ed25519 or RSA key pair on this device', type: 'keygen' as const, favorite: false, run: onGenerateKey },
      { id: 'appearance', label: 'Appearance', detail: 'Color presets, themes, wallpapers, and animated GIFs', type: 'help' as const, favorite: false, run: onAppearance },
      { id: 'scripts', label: 'Scripts', detail: 'Save shell scripts and run them in a connected terminal', type: 'scripts' as const, favorite: false, run: onScripts },
      { id: 'vault', label: 'Vault', detail: 'PIN-protected password and SSH key manager', type: 'keygen' as const, favorite: false, run: onVault },
      { id: 'stream-mode', label: streamMode ? 'Disable stream mode' : 'Enable stream mode', detail: 'Privacy: hide IP addresses while sharing your screen', type: 'stream' as const, favorite: false, run: onToggleStreamMode },
      { id: 'import', label: 'Bulk import hosts', detail: 'Add server credentials or a shared SSH key', type: 'new' as const, favorite: false, run: onBulkImport },
      { id: 'group-command', label: 'Run group command', detail: 'Review and execute a command across a host group', type: 'new' as const, favorite: false, run: onGroupCommand },
      { id: 'workspaces', label: 'Workspaces', detail: 'Save host selections and terminal layouts', type: 'workspace' as const, favorite: false, run: onWorkspaces },
      { id: 'management', label: 'Manage workspace', detail: 'Runbooks, named keys, group defaults, backups, and updates', type: 'management' as const, favorite: false, run: onManagement },
      { id: 'dashboard', label: 'Server dashboard', detail: 'CPU, memory, disk, and uptime for connected hosts', type: 'dashboard' as const, favorite: false, run: onDashboard },
      { id: 'tunnels', label: 'SSH tunnels', detail: 'Local and remote port forwarding', type: 'tunnel' as const, favorite: false, run: onTunnels },
      { id: 'mcp', label: 'MCP server', detail: 'Connect external AI assistants to SSH Heaven', type: 'tunnel' as const, favorite: false, run: onMcp },
      { id: 'help', label: 'Help & keyboard shortcuts', detail: 'Find your way around', type: 'help' as const, favorite: false, run: onHelp }
    ].filter((action) => `${action.label} ${action.detail}`.toLowerCase().includes(normalized))
    return [...hosts, ...quickHosts, ...actions]
  }, [query, profiles, onSelectHost, onNewConnection, onHelp, onHome, onGenerateKey, onAppearance, onBulkImport, onGroupCommand, onWorkspaces, onManagement, onDashboard, onTunnels, onMcp, onScripts, onVault, onToggleStreamMode, streamMode, quickConnectIds, quickConnecting, onQuickConnect])

  useEffect(() => setSelected(0), [query])
  useEffect(() => { resultsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, [selected])
  const activeIndex = Math.min(selected, Math.max(0, results.length - 1))
  function run(index: number) {
    const result = results[index]
    if (!result || ('busy' in result && result.busy)) return
    onClose()
    result.run()
  }

  return <Modal title="Quick switcher" onClose={onClose} className="command-palette">
    <div className="palette-search"><Search size={20} /><input
      role="combobox" aria-label="Search hosts and actions" aria-controls="palette-results" aria-expanded="true"
      aria-autocomplete="list" aria-activedescendant={results.length ? `palette-item-${activeIndex}` : undefined}
      placeholder="Search hosts, groups, or actions…" value={query} onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setSelected((value) => results.length ? (value + 1) % results.length : 0) }
        if (event.key === 'ArrowUp') { event.preventDefault(); setSelected((value) => results.length ? (value - 1 + results.length) % results.length : 0) }
        if (event.key === 'Enter') { event.preventDefault(); run(activeIndex) }
      }} autoComplete="off" spellCheck={false}
    /><kbd>esc</kbd></div>
    <div className="palette-results" role="listbox" aria-label="Hosts and actions" id="palette-results" ref={resultsRef}>
      {!results.length && <div className="palette-empty"><Search size={24} /><strong>No matching hosts or actions</strong><span>Try a hostname, group, or “new connection”.</span></div>}
      {results.map((result, index) => <button key={result.id} id={`palette-item-${index}`} type="button" role="option" aria-label={result.type === 'quick' ? result.label : undefined} aria-disabled={'busy' in result && result.busy} aria-selected={activeIndex === index} tabIndex={-1} className={`palette-result ${activeIndex === index ? 'selected' : ''}`} onMouseEnter={() => setSelected(index)} onClick={() => run(index)}>
        <div className={`palette-result-icon ${result.type === 'host' ? 'host' : ''}`}>{result.type === 'scripts' ? <FileCode2 size={18} /> : result.type === 'stream' ? <Radio size={18} /> : result.type === 'quick' ? <Zap size={18} /> : result.type === 'new' ? <Plus size={19} /> : result.type === 'home' ? <House size={19} /> : result.type === 'keygen' ? <KeyRound size={19} /> : result.type === 'workspace' ? <Layers size={19} /> : result.type === 'management' ? <Settings2 size={19} /> : result.type === 'dashboard' ? <Activity size={19} /> : result.type === 'tunnel' ? <Network size={19} /> : result.type === 'help' ? <CircleHelp size={19} /> : <Server size={18} />}</div>
        <div><strong>{result.label}{result.favorite && <Star size={12} className="favorite-star" fill="currentColor" />}</strong><span>{result.detail}</span></div>
        {activeIndex === index && <CornerDownLeft size={16} className="palette-return" />}
      </button>)}
    </div>
    <div className="palette-footer"><span><ArrowDownUp size={13} />Navigate</span><span><CornerDownLeft size={13} />Open</span><span>{profiles.length} saved {profiles.length === 1 ? 'host' : 'hosts'}</span></div>
  </Modal>
}
