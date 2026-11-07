import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { Activity, ArrowLeft, ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, Columns2, Command, FileKey2, Folder, FolderOpen, House, KeyRound, Layers, LayoutGrid, ListPlus, LoaderCircle, LockKeyhole, Network, Palette, PanelLeftClose, PanelLeftOpen, Pencil, Play, Plus, Search, Server, Settings2, ShieldCheck, ShieldQuestion, ShieldX, Star, TerminalSquare, Trash2, Unplug, X, Zap } from 'lucide-react'
import type { ConnectRequest, CredentialStatus, GeneratedKey, HostKeyChallenge, HostProfile, LibraryState, RecentHost, SavedWorkspace, SessionStatus, UpdateState, WorkspaceLayout, McpState } from '../shared/types'
import { FileBrowser } from './components/FileBrowser'
import { TerminalView, type TerminalTransport } from './components/TerminalView'
import { Modal, errorMessage } from './components/Modal'
import { CommandPalette } from './components/CommandPalette'
import { HomeScreen } from './components/HomeScreen'
import { KeyGenerator } from './components/KeyGenerator'
import { Appearance } from './components/Appearance'
import { RemoteEditor } from './components/RemoteEditor'
import { BulkImport } from './components/BulkImport'
import { GroupCommand } from './components/GroupCommand'
import { WorkspaceManager } from './components/WorkspaceManager'
import { ServerDashboard } from './components/ServerDashboard'
import { TunnelManager } from './components/TunnelManager'
import { ManagementPanel } from './components/ManagementPanel'
import { McpPanel } from './components/McpPanel'
import { McpApprovalDialog } from './components/McpApprovalDialog'
import { ScriptsPanel } from './components/ScriptsPanel'
import { VaultPanel } from './components/VaultPanel'
import { SessionStrip } from './components/SessionStrip'
import { useStreamMode } from './stream-mode'
import { createNavigationHistory, moveHistory, navigateHistory, pruneNavigationHistory } from './navigation-history'
import { Download, FileCode2, Radio } from 'lucide-react'

type Session = { id: string; profile: HostProfile; status: SessionStatus['status']; message?: string; everConnected?: boolean; retryMessage?: string }
type Draft = HostProfile & { password: string; passphrase: string }
const blankDraft = (): Draft => ({ id: crypto.randomUUID(), name: '', host: '', port: 22, username: '', authType: 'password', password: '', passphrase: '', group: '' })
const api = window.sshHeaven
const emptyLibrary: LibraryState = { runbooks: [], keys: [], groupDefaults: [], workspaces: [], tunnelRules: [] }
const sameEndpoint = (a: HostProfile, b: HostProfile) => a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.username === b.username
const workspacePages = new Set(['home', 'new', 'scripts', 'vault'])
const hostGroupKey = (group: string | null) => group === null ? 'ungrouped' : `group:${group}`
function focusConnectionField(selector: string) {
  requestAnimationFrame(() => {
    const form = document.querySelector<HTMLElement>('.connection-form-workspace:not([hidden])')
    if (!form || document.querySelector('[role="dialog"]')) return
    const focused = document.activeElement
    if (focused instanceof HTMLElement && form.contains(focused) && focused.matches('input, select, textarea, [contenteditable="true"]')) return
    form.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true })
  })
}

const histories = new Map<string, { chunks: Uint8Array[]; bytes: number }>()
const outputListeners = new Map<string, Set<(data: Uint8Array) => void>>()
function receiveOutput(id: string, data: Uint8Array) {
  const history = histories.get(id)
  // Ignore late output from a tab which has already closed.
  if (!history) return
  const retained = data.byteLength > 512 * 1024 ? data.slice(-512 * 1024) : data
  history.chunks.push(retained)
  history.bytes += retained.byteLength
  while ((history.bytes > 512 * 1024 || history.chunks.length > 2048) && history.chunks.length > 1) {
    history.bytes -= history.chunks.shift()!.byteLength
  }
  outputListeners.get(id)?.forEach((listener) => listener(data))
}

function ConnectionForm({ initial, onConnect, onSave, onError, saved, favorite, groups, profiles, onSelectHost, onOpenPalette, onGenerateKey, generatedKey, credentialStatus, onForgetCredential, library, credentialError }: {
  initial: Draft
  onConnect: (request: Omit<ConnectRequest, 'sessionId'>) => Promise<void>
  onSave: (profile: HostProfile) => Promise<void>
  onError: (error: unknown) => void
  saved: boolean
  favorite?: boolean
  groups: string[]
  profiles: HostProfile[]
  onSelectHost: (profile: HostProfile) => void
  onOpenPalette: () => void
  onGenerateKey: () => void
  generatedKey: { id: string; path: string } | null
  credentialStatus: CredentialStatus | null
  onForgetCredential: (profileId: string) => Promise<void>
  library: LibraryState
  credentialError?: string
}) {
  const [draft, setDraft] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [saveWithConnection, setSaveWithConnection] = useState(true)
  const [formError, setFormError] = useState(credentialError || '')
  const [useSavedCredential, setUseSavedCredential] = useState(!credentialError)
  const [rememberCredential, setRememberCredential] = useState(false)
  const [forgettingCredential, setForgettingCredential] = useState(false)
  const savedProfile = profiles.find((profile) => profile.id === draft.id)
  const hasSavedCredential = !!credentialStatus?.profileIds.includes(draft.id) && !!savedProfile && sameEndpoint(draft, savedProfile) && draft.authType === 'password' && savedProfile.authType === 'password'
  useEffect(() => {
    if (generatedKey) setDraft((current) => ({ ...current, authType: 'privateKey', privateKeyPath: generatedKey.path, passphrase: '' }))
  }, [generatedKey])
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((current) => ({ ...current, [field]: value }))
  function applyGroupDefaults(group: string) {
    const defaults = library.groupDefaults.find((item) => item.group === group)
    if (!defaults) { set('group', group); return }
    const key = library.keys.find((item) => item.id === defaults.keyId)
    setDraft((current) => ({ ...current, group, username: defaults.username, port: defaults.port, authType: key ? 'privateKey' : 'password', privateKeyPath: key?.path, passphrase: '' }))
  }
  const profile = (): HostProfile => ({ id: draft.id, name: draft.name.trim() || draft.host.trim(), host: draft.host.trim(), port: Number(draft.port), username: draft.username.trim(), authType: draft.authType, favorite: favorite ?? draft.favorite ?? false, autoReconnect: !!draft.autoReconnect, ...(draft.jumpHostId ? { jumpHostId: draft.jumpHostId } : {}), ...(draft.tmuxSession?.trim() ? { tmuxSession: draft.tmuxSession.trim() } : {}), ...(draft.authType === 'privateKey' ? { privateKeyPath: draft.privateKeyPath } : {}), ...(draft.group?.trim() ? { group: draft.group.trim() } : {}) })
  function valid() {
    if (!draft.host.trim() || !draft.username.trim()) { setFormError('Enter a hostname and username.'); return false }
    if (!Number.isInteger(Number(draft.port)) || draft.port < 1 || draft.port > 65535) { setFormError('Port must be between 1 and 65535.'); return false }
    if (draft.authType === 'privateKey' && !draft.privateKeyPath) { setFormError('Choose a private key file.'); return false }
    if (draft.tmuxSession && !/^[a-zA-Z0-9_-]{1,64}$/.test(draft.tmuxSession.trim())) { setFormError('Use a tmux session name with letters, numbers, underscores, or hyphens (up to 64 characters).'); return false }
    setFormError(''); return true
  }
  async function saveOnly() {
    if (!valid()) return
    setSaving(true)
    try { await onSave(profile()) } catch (error) { setFormError(errorMessage(error)) }
    finally { setSaving(false) }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid() || saving) return
    if (credentialError && draft.authType === 'password' && !draft.password && !useSavedCredential) { setFormError('Enter your password before reconnecting.'); return }
    setSaving(true)
    try {
      if (saveWithConnection || (draft.authType === 'password' && rememberCredential)) await onSave(profile())
      const credentials = {
        password: draft.password,
        passphrase: draft.passphrase,
        useSavedCredential: draft.authType === 'password' && hasSavedCredential && useSavedCredential && !draft.password,
        rememberCredential: draft.authType === 'password' && rememberCredential && !!credentialStatus?.available
      }
      setDraft((current) => ({ ...current, password: '', passphrase: '' }))
      setUseSavedCredential(true)
      await onConnect({ profile: profile(), ...credentials })
    } catch (error) { setFormError(errorMessage(error)) }
    finally { setSaving(false) }
  }
  async function forgetCredential() {
    if (forgettingCredential) return
    setForgettingCredential(true)
    setFormError('')
    try { await onForgetCredential(draft.id); setRememberCredential(false); setUseSavedCredential(false) }
    catch (error) { setFormError(errorMessage(error)) }
    finally { setForgettingCredential(false) }
  }
  return <div className="connection-page">
    <header className="connection-page-heading"><div><h1>Connect to a server</h1><p>Open a secure shell and browse your remote files.</p></div><button className="button secondary" type="button" onClick={onOpenPalette}><Search size={15} />Quick switcher<kbd>Ctrl K</kbd></button></header>
    <div className="connection-page-grid">
    <form className="connection-card" onSubmit={(event) => void submit(event)}>
      <div className="connection-card-heading"><div className="card-icon"><Server size={20} /></div><div><h2>{saved ? 'Connect to host' : 'New connection'}</h2><p>{saved ? 'Update the details or start a session.' : 'Enter your server details to get started.'}</p></div><span className="ssh-pill">SSH</span></div>
      <div className="form-row identity-row"><label className="field-label">Nickname <span className="optional">optional</span><input id="connection-name" placeholder="e.g. Production server" value={draft.name} onChange={(event) => set('name', event.target.value)} maxLength={100} autoComplete="off" /></label><label className="field-label">Group <span className="optional">optional</span><input list="host-groups" placeholder="e.g. Production" value={draft.group ?? ''} onChange={(event) => { if (!saved) applyGroupDefaults(event.target.value); else set('group', event.target.value) }} maxLength={100} autoComplete="off" /><datalist id="host-groups">{groups.map((group) => <option key={group} value={group} />)}</datalist></label></div>
      {library.groupDefaults.some((item) => item.group === draft.group) && <button type="button" className="apply-group-defaults" onClick={() => applyGroupDefaults(draft.group!)}>Apply group defaults for {draft.group}</button>}
      <div className="form-row host-row"><label className="field-label">Hostname or IP address<input placeholder="192.168.1.10" value={draft.host} onChange={(event) => set('host', event.target.value)} required maxLength={253} spellCheck={false} autoComplete="off" /></label><label className="field-label">Port<input aria-label="SSH port" type="number" min={1} max={65535} value={draft.port} onChange={(event) => set('port', Number(event.target.value))} required /></label></div>
      <label className="field-label">Username<input placeholder="root" value={draft.username} onChange={(event) => set('username', event.target.value)} required maxLength={100} spellCheck={false} autoComplete="username" /></label>
      <div className="auth-heading"><span className="field-label">Authentication</span><div className="segmented-control"><button type="button" aria-pressed={draft.authType === 'password'} className={draft.authType === 'password' ? 'active' : ''} onClick={() => set('authType', 'password')}><LockKeyhole size={13} />Password</button><button type="button" aria-pressed={draft.authType === 'privateKey'} className={draft.authType === 'privateKey' ? 'active' : ''} onClick={() => set('authType', 'privateKey')}><KeyRound size={13} />SSH key</button></div></div>
      {draft.authType === 'password' && credentialError && formError === credentialError && <div className="form-error credential-recovery-message" role="alert">{formError}</div>}
      {draft.authType === 'password' ? <><label className="field-label sr-label">Password<input type="password" placeholder={hasSavedCredential && useSavedCredential && !draft.password ? 'Saved password will be used' : 'Password'} value={draft.password} onChange={(event) => { set('password', event.target.value); if (event.target.value) setUseSavedCredential(false) }} autoComplete="off" /></label><div className="credential-options">{hasSavedCredential && <div className="saved-credential-row"><label className="checkbox-label"><input type="checkbox" checked={useSavedCredential && !draft.password} onChange={(event) => { setUseSavedCredential(event.target.checked); if (event.target.checked) set('password', '') }} />Use saved password</label><button type="button" className="credential-forget" disabled={forgettingCredential} onClick={() => void forgetCredential()}>{forgettingCredential ? <LoaderCircle size={12} className="spin" /> : null}Forget saved password</button></div>}<label className="checkbox-label"><input type="checkbox" checked={rememberCredential} disabled={!credentialStatus?.available} onChange={(event) => { setRememberCredential(event.target.checked); if (event.target.checked) setSaveWithConnection(true) }} />Remember password on this device</label><p className="credential-hint">{credentialStatus === null ? 'Checking encrypted storage…' : credentialStatus.available ? 'Saved passwords use encrypted storage. Key passphrases are never saved.' : 'Encrypted storage is unavailable. Enter your password each time.'}</p></div></> : <div className="key-fields">{library.keys.length > 0 && <label className="field-label">Key library<select aria-label="Key library" value={library.keys.find((item) => item.path === draft.privateKeyPath)?.id || ''} onChange={(event) => { const key = library.keys.find((item) => item.id === event.target.value); if (key) setDraft((current) => ({ ...current, privateKeyPath: key.path, passphrase: '' })) }}><option value="">Choose a named key</option>{library.keys.map((key) => <option key={key.id} value={key.id}>{key.name}</option>)}</select></label>}<div className="key-picker"><FileKey2 size={15} /><span title={draft.privateKeyPath}>{draft.privateKeyPath || 'No private key selected'}</span><button type="button" className="button secondary compact" onClick={() => void api.pickPrivateKey().then((path) => { if (path) set('privateKeyPath', path) }).catch(onError)}>Browse</button></div><div className="key-generation-link"><span>Need a key for this connection?</span><button type="button" onClick={onGenerateKey}><Plus size={12} />Generate SSH key</button></div><label className="field-label sr-label">Key passphrase<input type="password" placeholder="Key passphrase (if required)" value={draft.passphrase} onChange={(event) => set('passphrase', event.target.value)} autoComplete="off" /></label></div>}
      <details className="connection-advanced"><summary>Connection options</summary><label className="field-label">Jump host<select aria-label="Jump host" value={draft.jumpHostId || ''} onChange={(event) => set('jumpHostId', event.target.value || undefined)}><option value="">Direct connection</option>{profiles.filter((item) => item.id !== draft.id).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}</option>)}</select></label><label className="field-label">tmux session<span className="optional">optional</span><input value={draft.tmuxSession || ''} onChange={(event) => set('tmuxSession', event.target.value)} placeholder="e.g. work" maxLength={64} autoComplete="off" /></label><label className="checkbox-label"><input type="checkbox" checked={!!draft.autoReconnect} onChange={(event) => set('autoReconnect', event.target.checked)} />Automatically reconnect after disconnects</label><p>Retries use saved credentials or your key, up to five attempts. Terminal input is never replayed. Jump hosts use their saved credentials. tmux must be installed on the server.</p></details>
      <div className="save-options"><label className="checkbox-label"><input type="checkbox" checked={saveWithConnection} disabled={rememberCredential && draft.authType === 'password'} onChange={(event) => setSaveWithConnection(event.target.checked)} /><span>Save to hosts</span></label><span>Connection details stay local</span></div>
      {formError && !(draft.authType === 'password' && credentialError && formError === credentialError) && <div className="form-error" role="alert">{formError}</div>}
      <div className="connection-actions"><button type="button" className="button secondary" disabled={saving} onClick={() => void saveOnly()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{saved ? 'Save changes' : 'Save host'}</button><button type="submit" className="button primary" disabled={saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <TerminalSquare size={16} />}Connect<ArrowRight size={15} /></button></div>
      <div className="card-note"><ShieldCheck size={14} /><span>New servers are verified by their host-key fingerprint.</span></div>
    </form>
    <aside className="connection-quick-panel"><section className="quick-panel-section"><div className="quick-section-title"><Server size={16} /><h2>Saved hosts</h2><span>{profiles.length}</span></div>{profiles.length ? <div className="quick-host-list">{[...profiles].sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name)).slice(0, 4).map((host) => <button type="button" className="quick-host" key={host.id} onClick={() => onSelectHost(host)}><span className="quick-host-symbol">{host.favorite ? <Star size={15} className="favorite-star" fill="currentColor" /> : <Server size={15} />}</span><span><strong>{host.name}</strong><small>{host.username}@{host.host}</small></span><ArrowRight size={14} /></button>)}</div> : <div className="quick-empty"><FolderOpen size={25} /><strong>A faster way back</strong><p>Save a host to keep its address, username, and key path ready for your next session.</p></div>}</section><section className="quick-panel-section"><div className="quick-section-title"><Command size={16} /><h2>Work a little faster</h2></div><div className="shortcut-list"><span>Find hosts & actions<kbd>Ctrl K</kbd></span><span>New connection<kbd>Ctrl Shift N</kbd></span><span>Switch sessions<kbd>Ctrl Tab</kbd></span><span>Close a session<kbd>Ctrl W</kbd></span></div></section><div className="workspace-privacy"><ShieldCheck size={18} /><div><strong>Private by default</strong><p>Hosts stay on this device. Saved passwords use encrypted storage. Key passphrases are never saved.</p></div></div></aside>
    </div>
  </div>
}

export function App() {
  const streamMode = useStreamMode()
  const [profiles, setProfiles] = useState<HostProfile[]>([])
  const [library, setLibrary] = useState<LibraryState>(emptyLibrary)
  const [recentHosts, setRecentHosts] = useState<RecentHost[]>([])
  const [sessions, setSessions] = useState<Session[]>([])
  const [navigation, setNavigation] = useState(() => createNavigationHistory('home'))
  const activeTab = navigation.entries[navigation.index]
  const setActiveTab = useCallback((next: SetStateAction<string>) => {
    setNavigation((current) => navigateHistory(current, typeof next === 'function' ? next(current.entries[current.index]) : next))
  }, [])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('ssh-heaven:sidebar-collapsed') === 'true' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('ssh-heaven:sidebar-collapsed', String(sidebarCollapsed)) } catch { /* Storage may be disabled. */ }
  }, [sidebarCollapsed])
  const [scriptTargetId, setScriptTargetId] = useState('')
  const [draft, setDraft] = useState<Draft>(blankDraft)
  const [draftVersion, setDraftVersion] = useState(0)
  const [credentialError, setCredentialError] = useState('')
  const [quickConnecting, setQuickConnecting] = useState<Set<string>>(new Set())
  const quickConnectingRef = useRef(new Set<string>())
  const [search, setSearch] = useState('')
  const [hostFilter, setHostFilter] = useState<'all' | 'favorites'>('all')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem('ssh-heaven:collapsed-host-groups') || '[]')
      return new Set(Array.isArray(stored) ? stored.filter((value): value is string => typeof value === 'string' && value.length <= 106).slice(-1000) : [])
    } catch { return new Set() }
  })
  useEffect(() => {
    try { localStorage.setItem('ssh-heaven:collapsed-host-groups', JSON.stringify([...collapsedGroups])) } catch { /* Keep navigation usable when storage is unavailable. */ }
  }, [collapsedGroups])
  const toggleHostGroup = useCallback((group: string | null) => {
    setCollapsedGroups((current) => {
      const next = new Set(current), key = hostGroupKey(group)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return new Set([...next].slice(-1000))
    })
  }, [])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [keyGeneratorOpen, setKeyGeneratorOpen] = useState(false)
  const [keyGeneratorForVault, setKeyGeneratorForVault] = useState(false)
  const [addingVaultKey, setAddingVaultKey] = useState(false)
  const addingVaultKeyRef = useRef(false)
  const [vaultRefreshToken, setVaultRefreshToken] = useState(0)
  const wasVaultActive = useRef(false)
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const [bulkImportOpen, setBulkImportOpen] = useState(false)
  const [commandGroup, setCommandGroup] = useState<string | null>(null)
  const [initialGroupCommand, setInitialGroupCommand] = useState('')
  const [managementOpen, setManagementOpen] = useState(false)
  const [managementStart, setManagementStart] = useState<'runbooks' | 'updates'>('runbooks')
  const [mcpOpen, setMcpOpen] = useState(false)
  const [mcpState, setMcpState] = useState<McpState | null>(null)
  const [workspacesOpen, setWorkspacesOpen] = useState(false)
  const [dashboardOpen, setDashboardOpen] = useState(false)
  const [tunnelsOpen, setTunnelsOpen] = useState(false)
  const [layout, setLayout] = useState<WorkspaceLayout>('tabs')
  const [paneIds, setPaneIds] = useState<string[]>([])
  const [restoredWorkspace, setRestoredWorkspace] = useState<{ name: string; sessionIds: string[]; missing: number } | null>(null)
  const [workspaceConnecting, setWorkspaceConnecting] = useState(false)
  const [workspaceNeeds, setWorkspaceNeeds] = useState<{ profile: HostProfile; sessionId: string }[]>([])
  const [credentialSessionId, setCredentialSessionId] = useState<string | null>(null)
  const [availableUpdate, setAvailableUpdate] = useState<UpdateState | null>(null)
  const [updateState, setUpdateState] = useState<UpdateState | null>(null)
  const [credentialStatus, setCredentialStatus] = useState<CredentialStatus | null>(null)
  const [editing, setEditing] = useState<{ sessionId: string; path: string } | null>(null)
  const [editorRefreshToken, setEditorRefreshToken] = useState(0)
  const [generatedKey, setGeneratedKey] = useState<{ id: string; path: string } | null>(null)
  const [showFiles, setShowFiles] = useState(true)
  const [toast, setToast] = useState<{ message: string; kind: 'error' | 'success' } | null>(null)
  const [challenges, setChallenges] = useState<HostKeyChallenge[]>([])
  const [trustBusy, setTrustBusy] = useState(false)
  const [deleteHost, setDeleteHost] = useState<HostProfile | null>(null)
  const [help, setHelp] = useState(false)
  const [closeTarget, setCloseTarget] = useState<Session | null>(null)
  const [closing, setClosing] = useState(false)
  const sessionsRef = useRef(sessions)
  const manualStops = useRef(new Set<string>())
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const retryAttempts = useRef(new Map<string, number>())
  const retryInFlight = useRef(new Set<string>())
  const workspaceConnectingRef = useRef(false)
  const dismissedUpdate = useRef<string | undefined>(undefined)
  sessionsRef.current = sessions
  useLayoutEffect(() => {
    const valid = new Set([...workspacePages, ...sessions.map((session) => session.id)])
    setNavigation((current) => pruneNavigationHistory(current, (id) => valid.has(id)))
  }, [sessions])
  const moveNavigation = useCallback((direction: -1 | 1) => {
    const valid = new Set([...workspacePages, ...sessionsRef.current.map((session) => session.id)])
    setNavigation((current) => moveHistory(pruneNavigationHistory(current, (id) => valid.has(id)), direction))
  }, [])
  const notifyError = useCallback((error: unknown) => setToast({ message: errorMessage(error), kind: 'error' }), [])
  const refreshRecentHosts = useCallback(async () => {
    const recent = await api.listRecentHosts()
    setRecentHosts(recent)
  }, [])
  const refreshCredentialStatus = useCallback(async () => { setCredentialStatus(await api.getCredentialStatus()) }, [])
  const refreshLibrary = useCallback(async () => { setLibrary(await api.getLibrary()) }, [])
  const onMcpResolved = useCallback((id: string) => { setMcpState((state) => state ? { ...state, pendingApprovals: state.pendingApprovals.filter((request) => request.id !== id) } : state) }, [])
  const forgetCredential = useCallback(async (id: string) => { await api.forgetCredential(id); await refreshCredentialStatus() }, [refreshCredentialStatus])
  const closeEditor = useCallback(() => { setEditing(null); setEditorRefreshToken((current) => current + 1) }, [])
  const active = sessions.find((session) => session.id === activeTab)
  const connectedCount = sessions.filter((session) => session.status === 'connected').length
  const connectedSessions = sessions.filter((session) => session.status === 'connected')
  const scriptTargets = connectedSessions.map((session) => ({ sessionId: session.id, name: session.profile.name, host: session.profile.host, username: session.profile.username, port: session.profile.port }))
  const scriptTarget = scriptTargets.find((target) => target.sessionId === scriptTargetId) ?? null
  useEffect(() => { if (active?.status === 'connected') setScriptTargetId(active.id) }, [active?.id, active?.status])
  const openScripts = useCallback(() => setActiveTab('scripts'), [])
  const openVault = useCallback(() => setActiveTab('vault'), [])
  const openVaultKeyGenerator = useCallback(() => { setKeyGeneratorForVault(true); setKeyGeneratorOpen(true) }, [])
  useEffect(() => {
    if (wasVaultActive.current && activeTab !== 'vault') void api.lockVault().catch(notifyError)
    wasVaultActive.current = activeTab === 'vault'
  }, [activeTab, notifyError])
  async function addGeneratedVaultKey(key: GeneratedKey) {
    if (addingVaultKeyRef.current) return
    addingVaultKeyRef.current = true; setAddingVaultKey(true)
    try {
      await api.saveVaultKey({ id: crypto.randomUUID(), name: key.privateKeyPath.split(/[\\/]/).at(-1) || 'Generated SSH key', path: key.privateKeyPath })
      await refreshLibrary()
      setVaultRefreshToken((value) => value + 1)
      setKeyGeneratorOpen(false); setKeyGeneratorForVault(false)
      setToast({ message: 'Generated SSH key added to your vault.', kind: 'success' })
    } catch (error) { notifyError(error) }
    finally { addingVaultKeyRef.current = false; setAddingVaultKey(false) }
  }
  const saveScript = useCallback(async (script: import('../shared/types').Runbook) => { setLibrary(await api.saveLibraryItem('runbook', script)) }, [])
  const deleteScript = useCallback(async (id: string) => { setLibrary(await api.deleteLibraryItem('runbook', id)) }, [])
  async function runScript(script: import('../shared/types').Runbook) {
    if (!scriptTarget || !sessionsRef.current.some((session) => session.id === scriptTarget.sessionId && session.status === 'connected')) throw new Error('Select a connected terminal before running a script.')
    const targetId = scriptTarget.sessionId
    try { await api.runTerminalScript(targetId, script.command); setActiveTab(targetId) }
    catch (error) { notifyError(error); throw error }
    setToast({ message: `${script.name || 'Script'} sent to ${scriptTarget.name}. Follow its output in the terminal.`, kind: 'success' })
  }
  const transport: TerminalTransport = useMemo(() => ({
    history: (id) => histories.get(id)?.chunks ?? [],
    subscribe: (id, listener) => { const listeners = outputListeners.get(id) ?? new Set(); listeners.add(listener); outputListeners.set(id, listeners); return () => { listeners.delete(listener) } },
    write: async (id, data) => { api.write(id, data) },
    resize: async (id, cols, rows) => { api.resize(id, cols, rows) },
    readClipboard: () => api.readClipboard(),
    writeClipboard: (text) => api.writeClipboard(text)
  }), [])

  useEffect(() => {
    void api.listProfiles().then(setProfiles).catch(notifyError)
    void refreshRecentHosts().catch(notifyError)
    void refreshCredentialStatus().catch(notifyError)
    void refreshLibrary().catch(notifyError)
    const stopData = api.onData(({ sessionId, data }) => receiveOutput(sessionId, new Uint8Array(data)))
    const stopStatus = api.onStatus((event) => {
      setSessions((current) => current.map((session) => session.id === event.sessionId ? { ...session, status: event.status, message: event.message, everConnected: session.everConnected || event.status === 'connected', ...(event.status === 'connected' ? { retryMessage: undefined } : {}) } : session))
      if (event.status === 'connected') {
        void refreshRecentHosts().catch(notifyError)
        void refreshCredentialStatus().catch(notifyError)
        if (event.message) setToast({ message: event.message, kind: 'error' })
      }
      if (event.status === 'error' || event.status === 'disconnected') setChallenges((current) => current.filter((challenge) => challenge.sessionId !== event.sessionId))
    })
    const stopHostKey = api.onHostKey((challenge) => setChallenges((current) => [...current, challenge]))
    const update = (state: UpdateState) => {
      setUpdateState(state)
      setAvailableUpdate(state.status === 'available' && state.version !== dismissedUpdate.current ? state : null)
    }
    let receivedUpdate = false
    const stopUpdates = api.onUpdate((state) => { receivedUpdate = true; update(state) })
    void api.getUpdateState().then((state) => { if (!receivedUpdate) update(state) }).catch(notifyError)
    return () => { stopData(); stopStatus(); stopHostKey(); stopUpdates() }
  }, [notifyError, refreshRecentHosts, refreshCredentialStatus, refreshLibrary])
  useEffect(() => {
    if (!toast) return
    const timeout = setTimeout(() => setToast(null), toast.kind === 'error' ? 9000 : 3500)
    return () => clearTimeout(timeout)
  }, [toast])
  useEffect(() => {
    let received = false
    const stop = api.onMcpState((state) => { received = true; setMcpState(state) })
    void api.getMcpState().then((state) => { if (!received) setMcpState(state) }).catch(notifyError)
    return stop
  }, [notifyError])
  const newConnection = useCallback(() => { setCredentialError(''); setCredentialSessionId(null); setGeneratedKey(null); setDraft(blankDraft()); setDraftVersion((version) => version + 1); setActiveTab('new') }, [])
  const saveProfile = useCallback(async (profile: HostProfile) => {
    const saved = await api.saveProfile(profile)
    setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)))
    setSessions((current) => current.map((session) => session.profile.id === saved.id && sameEndpoint(session.profile, saved)
      ? { ...session, profile: { ...saved } } : session))
    void refreshRecentHosts().catch(notifyError)
    void refreshCredentialStatus().catch(notifyError)
    setToast({ message: `${saved.name} saved to hosts.`, kind: 'success' })
  }, [refreshRecentHosts, refreshCredentialStatus, notifyError])
  async function startSession(request: Omit<ConnectRequest, 'sessionId'>, id: string = crypto.randomUUID(), activate = true, onFailure?: (error: unknown) => void): Promise<boolean> {
    if (!sessionsRef.current.some((session) => session.id === id) && sessionsRef.current.length >= 20) { notifyError(new Error('Close a session before opening another (20-session limit).')); return false }
    manualStops.current.delete(id)
    const retryTimer = retryTimers.current.get(id)
    if (retryTimer) clearTimeout(retryTimer)
    retryTimers.current.delete(id); retryAttempts.current.delete(id)
    if (!histories.has(id)) histories.set(id, { chunks: [], bytes: 0 })
    setSessions((current) => current.some((session) => session.id === id) ? current.map((session) => session.id === id ? { ...session, profile: request.profile, status: 'connecting', message: undefined, retryMessage: undefined } : session) : [...current, { id, profile: request.profile, status: 'connecting' }])
    if (activate) setActiveTab(id)
    try {
      await api.connect({ ...request, sessionId: id, cols: 100, rows: 30 })
      void refreshRecentHosts().catch(notifyError)
      void refreshCredentialStatus().catch(notifyError)
      setSessions((current) => current.map((session) => session.id === id && session.status === 'connecting' ? { ...session, status: 'connected', everConnected: true } : session))
      return true
    } catch (error) {
      if (manualStops.current.has(id)) return false
      onFailure?.(error)
      setSessions((current) => current.map((session) => session.id === id ? { ...session, status: 'error', message: errorMessage(error) } : session))
      return false
    }
  }
  async function connect(request: Omit<ConnectRequest, 'sessionId'>) {
    const id = credentialSessionId || undefined
    const connected = await startSession(request, id)
    if (connected && id) { setWorkspaceNeeds((current) => current.filter((item) => item.sessionId !== id)); setCredentialSessionId(null) }
  }
  const disconnectSession = useCallback(async (id: string) => {
    manualStops.current.add(id)
    const timer = retryTimers.current.get(id)
    if (timer) clearTimeout(timer)
    retryTimers.current.delete(id); retryAttempts.current.delete(id)
    setSessions((current) => current.map((session) => session.id === id ? { ...session, retryMessage: undefined } : session))
    await api.disconnect(id)
  }, [])
  const closeSession = useCallback(async (id: string) => {
    try { await disconnectSession(id) } catch (error) { notifyError(error) }
    const index = sessionsRef.current.findIndex((session) => session.id === id)
    const remaining = sessionsRef.current.filter((session) => session.id !== id)
    sessionsRef.current = remaining
    setSessions((current) => current.filter((session) => session.id !== id))
    setActiveTab((current) => current === id ? remaining[Math.max(0, index - 1)]?.id ?? remaining[0]?.id ?? 'new' : current)
    histories.delete(id)
    outputListeners.delete(id)
    setChallenges((current) => current.filter((challenge) => challenge.sessionId !== id))
    setWorkspaceNeeds((current) => current.filter((item) => item.sessionId !== id))
    setRestoredWorkspace((current) => current ? { ...current, sessionIds: current.sessionIds.filter((sessionId) => sessionId !== id) } : null)
    setCredentialSessionId((current) => current === id ? null : current)
  }, [notifyError, disconnectSession])
  const chooseHost = useCallback((profile: HostProfile, focusAuthentication = true) => {
    const collision = profiles.some((item) => item.id === profile.id && !sameEndpoint(item, profile))
    setGeneratedKey(null)
    setCredentialError('')
    setCredentialSessionId(null)
    setDraft({ ...profile, id: collision ? crypto.randomUUID() : profile.id, password: '', passphrase: '' })
    setDraftVersion((version) => version + 1)
    setActiveTab('new')
    focusConnectionField(focusAuthentication ? '.connection-card input[type="password"]' : '#connection-name')
  }, [profiles])
  async function quickConnect(candidate: HostProfile) {
    if (quickConnectingRef.current.has(candidate.id)) return
    quickConnectingRef.current.add(candidate.id)
    setQuickConnecting(new Set(quickConnectingRef.current))
    try {
      const [savedProfiles, status] = await Promise.all([api.listProfiles(), api.getCredentialStatus()])
      setProfiles(savedProfiles)
      setCredentialStatus(status)
      const saved = savedProfiles.find((profile) => profile.id === candidate.id)
      const openCredentials = (profile: HostProfile, message: string, sessionId?: string) => {
        if (sessionId) manualStops.current.add(sessionId)
        setGeneratedKey(null)
        setDraft({ ...profile, password: '', passphrase: '' })
        setDraftVersion((version) => version + 1)
        setActiveTab('new')
        setCredentialSessionId(sessionId || null)
        setCredentialError(message)
        focusConnectionField('.connection-card input[type="password"]')
      }
      if (!saved || !sameEndpoint(saved, candidate) || saved.authType !== candidate.authType || saved.authType !== 'password') {
        openCredentials(saved ?? candidate, 'The saved connection details changed. Review them before connecting.')
        return
      }
      if (!status.available || !status.profileIds.includes(saved.id)) {
        openCredentials(saved, 'The saved password is unavailable. Enter your password to connect.')
        return
      }
      const sessionId = crypto.randomUUID()
      let failure: unknown
      const connected = await startSession({ profile: saved, useSavedCredential: true }, sessionId, true, (error) => { failure = error })
      if (!connected && failure && /auth|password|credential|decrypt/i.test(errorMessage(failure))) {
        openCredentials(saved, `The saved password could not sign in. Enter your password to try again. ${errorMessage(failure)}`, sessionId)
      }
    } catch (error) { notifyError(error) }
    finally {
      quickConnectingRef.current.delete(candidate.id)
      setQuickConnecting(new Set(quickConnectingRef.current))
    }
  }
  const requestCloseSession = useCallback((id: string) => {
    const session = sessionsRef.current.find((item) => item.id === id)
    if (!session) return
    if (session.status === 'connected') setCloseTarget(session)
    else void closeSession(id)
  }, [closeSession])
  async function confirmCloseSession() {
    if (!closeTarget || closing) return
    setClosing(true)
    try { await closeSession(closeTarget.id); setCloseTarget(null) }
    finally { setClosing(false) }
  }
  const toggleFavorite = useCallback(async (profile: HostProfile) => {
    try {
      const collision = profiles.find((item) => item.id === profile.id && !sameEndpoint(item, profile))
      const saved = await api.saveProfile({ ...profile, id: collision ? crypto.randomUUID() : profile.id, favorite: !profile.favorite })
      setProfiles((current) => [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.name.localeCompare(b.name)))
      void refreshRecentHosts().catch(notifyError)
      void refreshCredentialStatus().catch(notifyError)
    } catch (error) { notifyError(error) }
  }, [profiles, notifyError, refreshRecentHosts, refreshCredentialStatus])
  const resolveTrust = useCallback(async (trusted: boolean) => {
    if (!challenges[0] || trustBusy) return
    const requestId = challenges[0].requestId
    setTrustBusy(true)
    try { await api.resolveHostKey(requestId, trusted); setChallenges((current) => current.filter((challenge) => challenge.requestId !== requestId)) }
    catch (error) { notifyError(error); setChallenges((current) => current.filter((challenge) => challenge.requestId !== requestId)) }
    finally { setTrustBusy(false) }
  }, [challenges, trustBusy, notifyError])
  const rejectTrust = useCallback(() => { void resolveTrust(false) }, [resolveTrust])
  const closeDelete = useCallback(() => setDeleteHost(null), [])
  const closeHelp = useCallback(() => setHelp(false), [])
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const openPalette = useCallback(() => setPaletteOpen(true), [])
  const openHelp = useCallback(() => setHelp(true), [])
  const openAppearance = useCallback(() => setAppearanceOpen(true), [])
  const closeAppearance = useCallback(() => setAppearanceOpen(false), [])
  const openBulkImport = useCallback(() => setBulkImportOpen(true), [])
  const closeBulkImport = useCallback(() => setBulkImportOpen(false), [])
  const openGroupCommand = useCallback(() => { setInitialGroupCommand(''); setCommandGroup('') }, [])
  const closeGroupCommand = useCallback(() => { setCommandGroup(null); setInitialGroupCommand('') }, [])
  const openManagement = useCallback(() => { setManagementStart('runbooks'); setManagementOpen(true) }, [])
  const openUpdates = useCallback(() => { setManagementStart('updates'); setManagementOpen(true) }, [])
  const checkUpdates = useCallback(() => { openUpdates(); void api.checkForUpdates().catch(notifyError) }, [openUpdates, notifyError])
  const closeManagement = useCallback(() => setManagementOpen(false), [])
  const openMcp = useCallback(() => setMcpOpen(true), [])
  const closeMcp = useCallback(() => setMcpOpen(false), [])
  const openWorkspaces = useCallback(() => setWorkspacesOpen(true), [])
  const closeWorkspaces = useCallback(() => setWorkspacesOpen(false), [])
  const openDashboard = useCallback(() => setDashboardOpen(true), [])
  const closeDashboard = useCallback(() => setDashboardOpen(false), [])
  const openTunnels = useCallback(() => setTunnelsOpen(true), [])
  const closeTunnels = useCallback(() => setTunnelsOpen(false), [])
  const refreshImportedHosts = useCallback(async () => {
    await Promise.all([api.listProfiles().then(setProfiles), refreshRecentHosts(), refreshCredentialStatus(), refreshLibrary()])
    setVaultRefreshToken((value) => value + 1)
  }, [refreshRecentHosts, refreshCredentialStatus, refreshLibrary])
  function changeLayout(next: WorkspaceLayout) {
    const limit = next === 'tabs' ? 1 : next === 'split' ? 2 : 4
    const ids = [...new Set([...(active ? [active.id] : []), ...paneIds, ...sessions.map((session) => session.id)])]
    setLayout(next); setPaneIds(ids.slice(0, limit))
    if (next !== 'tabs') setShowFiles(false)
  }
  function toggleFiles() {
    if (!showFiles && layout !== 'tabs' && paneIds.length > 1) {
      let fileWidth = 440
      try { fileWidth = Math.min(740, Math.max(320, Number(localStorage.getItem('ssh-heaven-files-width')) || 440)) } catch { /* Use the default panel width. */ }
      const available = document.querySelector<HTMLElement>('.session-desktop')?.clientWidth ?? innerWidth - 265
      if (available - fileWidth < 640) changeLayout('tabs')
    }
    setShowFiles(!showFiles)
  }
  function movePane(id: string, direction: number) {
    setPaneIds((current) => { const index = current.indexOf(id); const target = index + direction; if (index < 0 || target < 0 || target >= current.length) return current; const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next })
  }
  function restoreWorkspace(workspace: SavedWorkspace) {
    const chosen = workspace.profileIds.map((id) => profiles.find((profile) => profile.id === id)).filter((profile): profile is HostProfile => !!profile)
    if (!chosen.length) { notifyError(new Error('This workspace has no available saved hosts.')); return }
    const additions: Session[] = []
    const ids = chosen.map((profile) => {
      const existing = sessionsRef.current.find((session) => session.profile.id === profile.id && sameEndpoint(session.profile, profile))
      if (existing) return existing.id
      const id = crypto.randomUUID(); additions.push({ id, profile, status: 'disconnected', message: 'Workspace restored. Connect when ready.' }); return id
    })
    if (sessionsRef.current.length + additions.length > 20) { notifyError(new Error('Close some sessions before restoring this workspace (20-session limit).')); return }
    for (const session of additions) { histories.set(session.id, { chunks: [], bytes: 0 }); manualStops.current.add(session.id) }
    sessionsRef.current = [...sessionsRef.current, ...additions]
    setSessions((current) => [...current, ...additions]); setLayout(workspace.layout); setPaneIds(ids.slice(0, workspace.layout === 'tabs' ? 1 : workspace.layout === 'split' ? 2 : 4)); setActiveTab(ids[0]); setRestoredWorkspace({ name: workspace.name, sessionIds: ids, missing: workspace.profileIds.length - chosen.length }); setWorkspaceNeeds([])
    if (workspace.layout !== 'tabs') setShowFiles(false)
  }
  function requestWorkspaceCredentials(item: { profile: HostProfile; sessionId: string }) { chooseHost(item.profile); setCredentialSessionId(item.sessionId) }
  async function connectWorkspace() {
    if (!restoredWorkspace || workspaceConnectingRef.current) return
    workspaceConnectingRef.current = true; setWorkspaceConnecting(true)
    const needs: { profile: HostProfile; sessionId: string }[] = []
    try {
      const candidates = restoredWorkspace.sessionIds.map((id) => sessionsRef.current.find((session) => session.id === id)).filter((session): session is Session => !!session && session.status !== 'connected' && session.status !== 'connecting')
      for (let index = 0; index < candidates.length; index += 4) {
        const [latestProfiles, latestCredentials] = await Promise.all([api.listProfiles(), api.getCredentialStatus()])
        await Promise.all(candidates.slice(index, index + 4).map(async (session) => {
          // A tab may have been closed while a previous batch was connecting.
          const current = sessionsRef.current.find((item) => item.id === session.id)
          if (!current) return
          const profile = latestProfiles.find((item) => item.id === current.profile.id && sameEndpoint(item, current.profile)) ?? current.profile
          if (profile.authType === 'password' && !latestCredentials.profileIds.includes(profile.id)) { needs.push({ profile, sessionId: session.id }); return }
          const connected = await startSession({ profile, useSavedCredential: profile.authType === 'password' }, session.id, false)
          if (!connected && !manualStops.current.has(session.id) && sessionsRef.current.some((item) => item.id === session.id)) needs.push({ profile, sessionId: session.id })
        }))
      }
      const remainingNeeds = needs.filter((item) => sessionsRef.current.some((session) => session.id === item.sessionId))
      setWorkspaceNeeds(remainingNeeds)
      if (remainingNeeds[0]) requestWorkspaceCredentials(remainingNeeds[0])
    } catch (error) {
      notifyError(error)
    } finally { workspaceConnectingRef.current = false; setWorkspaceConnecting(false) }
  }
  const openHome = useCallback(() => setActiveTab('home'), [])
  const selectTerminalSession = useCallback((id: string) => {
    if (!sessionsRef.current.some((session) => session.id === id)) return
    setActiveTab(id)
    // Selecting the current tab does not trigger TerminalView's active effect.
    // Pointer clicks should still let the user type immediately.
    if (id !== activeTab || document.activeElement?.matches('[data-session-keyboard-focus="true"]')) return
    requestAnimationFrame(() => {
      if (document.querySelector('[role="dialog"]')) return
      const pane = document.querySelector<HTMLElement>('.session-workspace.is-active-pane')
      if (pane?.dataset.sessionId === id) pane.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')?.focus({ preventScroll: true })
    })
  }, [activeTab])
  const openKeyGenerator = useCallback(() => { setKeyGeneratorForVault(false); setKeyGeneratorOpen(true) }, [])
  const closeKeyGenerator = useCallback(() => { setKeyGeneratorOpen(false); setKeyGeneratorForVault(false) }, [])
  const editNickname = useCallback((profile: HostProfile) => {
    const collision = profiles.find((item) => item.id === profile.id && !sameEndpoint(item, profile))
    chooseHost(collision ? { ...profile, id: crypto.randomUUID() } : profile, false)
  }, [profiles, chooseHost])
  const clearRecentHosts = useCallback(async () => { await api.clearRecentHosts(); setRecentHosts([]) }, [])
  const useGeneratedKey = useCallback((key: GeneratedKey) => {
    setGeneratedKey({ id: crypto.randomUUID(), path: key.privateKeyPath })
    setActiveTab('new')
    setKeyGeneratorOpen(false)
    focusConnectionField('.connection-card input[type="password"]')
  }, [])
  const cancelClose = useCallback(() => { if (!closing) setCloseTarget(null) }, [closing])
  useLayoutEffect(() => {
    const live = new Set(sessions.map((session) => session.id))
    const limit = layout === 'tabs' ? 1 : layout === 'split' ? 2 : 4
    setPaneIds((current) => {
      let next = current.filter((id) => live.has(id)).slice(0, limit)
      if (active) {
        if (layout === 'tabs') next = [active.id]
        else if (!next.includes(active.id)) next = next.length < limit ? [...next, active.id] : [...next.slice(0, limit - 1), active.id]
      }
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next
    })
  }, [sessions, active, layout])
  useEffect(() => {
    const live = new Set(sessions.map((session) => session.id))
    for (const [id, timer] of retryTimers.current) if (!live.has(id)) { clearTimeout(timer); retryTimers.current.delete(id) }
    for (const session of sessions) {
      const profile = profiles.find((item) => item.id === session.profile.id && sameEndpoint(item, session.profile)) ?? session.profile
      if (session.status === 'connected') { const timer = retryTimers.current.get(session.id); if (timer) clearTimeout(timer); retryTimers.current.delete(session.id); retryAttempts.current.delete(session.id); retryInFlight.current.delete(session.id); continue }
      if (!profile.autoReconnect || manualStops.current.has(session.id)) { const timer = retryTimers.current.get(session.id); if (timer) clearTimeout(timer); retryTimers.current.delete(session.id); continue }
      if (!session.everConnected || (session.status !== 'error' && session.status !== 'disconnected') || retryTimers.current.has(session.id) || retryInFlight.current.has(session.id)) continue
      const attempt = (retryAttempts.current.get(session.id) ?? 0) + 1
      const needsCredentials = profile.authType === 'password' && !credentialStatus?.profileIds.includes(profile.id)
      if (attempt > 5 || needsCredentials || /authentication|passphrase|private key|credential|verification|hostVerifier|host key/i.test(session.message || '')) {
        manualStops.current.add(session.id)
        setSessions((current) => current.map((item) => item.id === session.id ? { ...item, retryMessage: attempt > 5 ? 'Automatic reconnect stopped after five attempts.' : 'Reconnect needs your attention. Enter credentials to continue.' } : item))
        continue
      }
      const delay = [2000, 4000, 8000, 16000, 30000][attempt - 1]
      const timer = setTimeout(() => {
        retryTimers.current.delete(session.id)
        if (manualStops.current.has(session.id) || !sessionsRef.current.some((item) => item.id === session.id)) return
        retryAttempts.current.set(session.id, attempt); retryInFlight.current.add(session.id)
        setSessions((current) => current.map((item) => item.id === session.id ? { ...item, status: 'connecting', retryMessage: `Reconnecting, attempt ${attempt} of 5…` } : item))
        void api.connect({ sessionId: session.id, profile, useSavedCredential: profile.authType === 'password', cols: 100, rows: 30 }).then(() => {
          retryInFlight.current.delete(session.id)
          if (!manualStops.current.has(session.id)) setSessions((current) => current.map((item) => item.id === session.id ? { ...item, status: 'connected', everConnected: true, retryMessage: undefined } : item))
          void refreshCredentialStatus().catch(notifyError)
        }).catch((cause) => {
          retryInFlight.current.delete(session.id)
          if (!manualStops.current.has(session.id)) setSessions((current) => current.map((item) => item.id === session.id ? { ...item, status: 'error', message: errorMessage(cause), retryMessage: undefined } : item))
        })
      }, delay)
      retryTimers.current.set(session.id, timer)
      setSessions((current) => current.map((item) => item.id === session.id ? { ...item, retryMessage: `Automatic reconnect in ${delay / 1000}s · attempt ${attempt} of 5` } : item))
    }
  }, [sessions, profiles, credentialStatus, refreshCredentialStatus, notifyError])
  useEffect(() => () => { for (const timer of retryTimers.current.values()) clearTimeout(timer); retryTimers.current.clear() }, [])
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey
      if (modifier && !event.altKey && event.shiftKey && event.code === 'KeyS') { event.preventDefault(); event.stopPropagation(); streamMode.toggle(); return }
      if (document.querySelector('[role="dialog"]')) return
      if (event.altKey && !modifier && !event.shiftKey && (event.code === 'ArrowLeft' || event.code === 'ArrowRight')) {
        event.preventDefault(); event.stopPropagation(); moveNavigation(event.code === 'ArrowLeft' ? -1 : 1); return
      }
      if (!modifier || event.altKey) return
      if (!event.shiftKey && /^Digit[1-4]$/.test(event.code)) {
        event.preventDefault(); event.stopPropagation(); setActiveTab(['home', 'new', 'scripts', 'vault'][Number(event.code.slice(-1)) - 1]); return
      }
      if (event.code === 'KeyK') { event.preventDefault(); event.stopPropagation(); setPaletteOpen(true); return }
      if (event.shiftKey && event.code === 'KeyN') { event.preventDefault(); event.stopPropagation(); newConnection(); return }
      if (event.code === 'Tab') {
        event.preventDefault(); event.stopPropagation()
        const tabs = sessionsRef.current.map((session) => session.id)
        if (tabs.length) setActiveTab((current) => {
          const index = tabs.indexOf(current)
          return tabs[index < 0 ? (event.shiftKey ? tabs.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length]
        })
      }
      if (event.code === 'KeyW') {
        event.preventDefault(); event.stopPropagation()
        if (activeTab !== 'new' && activeTab !== 'home' && activeTab !== 'scripts' && activeTab !== 'vault') requestCloseSession(activeTab)
      }
    }
    document.addEventListener('keydown', handle, true)
    return () => document.removeEventListener('keydown', handle, true)
  }, [activeTab, newConnection, requestCloseSession, streamMode.toggle, moveNavigation, setActiveTab])
  const hostQuery = search.trim().toLowerCase()
  const filtered = profiles.filter((profile) => (hostFilter === 'all' || profile.favorite) && `${profile.name} ${profile.host} ${profile.username} ${profile.group ?? ''}`.toLowerCase().includes(hostQuery))
  const groups = [...new Set([...profiles.map((profile) => profile.group).filter((group): group is string => !!group), ...library.groupDefaults.map((defaults) => defaults.group)])].sort((a, b) => a.localeCompare(b))
  const groupedHosts = [...new Set(filtered.map((profile) => profile.group || null))].sort((a, b) => a === null ? 1 : b === null ? -1 : a.localeCompare(b)).map((group) => ({ group, name: group ?? 'Ungrouped', hosts: filtered.filter((profile) => (profile.group || null) === group).sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name)) }))
  const currentRecentHosts = recentHosts.map((recent) => ({ ...recent, profile: profiles.find((profile) => profile.id === recent.profile.id && sameEndpoint(profile, recent.profile)) ?? profiles.find((profile) => sameEndpoint(profile, recent.profile)) ?? recent.profile }))
  const quickConnectIds = new Set(credentialStatus?.available ? profiles.filter((profile) => profile.authType === 'password' && credentialStatus.profileIds.includes(profile.id)).map((profile) => profile.id) : [])

  return <div className={`app-shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
    <aside id="workspace-sidebar" className="sidebar" aria-label="Workspace sidebar">
      <div className="brand" title="SSH Heaven"><div className="brand-mark"><TerminalSquare size={23} strokeWidth={1.8} /></div><div><strong>SSH <span>Heaven</span></strong><small>SSH & SFTP workspace</small></div></div>
      <nav className="workspace-nav" aria-label="Workspace navigation">
        <button className="workspace-nav-item" onClick={openHome} aria-label="Open home" title="Home (Ctrl+1)" aria-keyshortcuts="Control+1 Meta+1" aria-current={activeTab === 'home' ? 'page' : undefined}><House size={17} /><span>Home</span></button>
        <button className="workspace-nav-item" onClick={() => setActiveTab('new')} aria-label="New connection" title="Connection editor (Ctrl+2)" aria-keyshortcuts="Control+2 Meta+2" aria-current={activeTab === 'new' ? 'page' : undefined}><TerminalSquare size={17} /><span>Connect</span></button>
        <button className="workspace-nav-item" onClick={openScripts} aria-label="Open scripts" title="Scripts (Ctrl+3)" aria-keyshortcuts="Control+3 Meta+3" aria-current={activeTab === 'scripts' ? 'page' : undefined}><FileCode2 size={17} /><span>Scripts</span><small>{library.runbooks.length || ''}</small></button>
        <button className="workspace-nav-item" onClick={openVault} aria-label="Open vault" title="Vault (Ctrl+4)" aria-keyshortcuts="Control+4 Meta+4" aria-current={activeTab === 'vault' ? 'page' : undefined}><LockKeyhole size={17} /><span>Vault</span></button>
      </nav>
      <div className="host-library">
        <div className="sidebar-section-heading"><span>Saved hosts <small>{profiles.length}</small></span><div className="sidebar-heading-actions"><button className="icon-button" title="Bulk import hosts" aria-label="Bulk import hosts" onClick={openBulkImport}><ListPlus size={17} /></button><button className="icon-button" title="New connection (Ctrl+Shift+N)" aria-label="Create a new connection" onClick={newConnection}><Plus size={18} /></button></div></div>
        <label className="search-field"><Search size={16} /><input placeholder="Search hosts…" aria-label="Search hosts" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button className="icon-button" aria-label="Clear host search" onClick={() => setSearch('')}><X size={13} /></button>}</label>
        <div className="host-filter-tabs" aria-label="Host filters"><button className={hostFilter === 'all' ? 'active' : ''} aria-pressed={hostFilter === 'all'} onClick={() => setHostFilter('all')}><Server size={14} />All hosts<span>{profiles.length}</span></button><button className={hostFilter === 'favorites' ? 'active' : ''} aria-pressed={hostFilter === 'favorites'} onClick={() => setHostFilter('favorites')}><Star size={14} />Favorites<span>{profiles.filter((profile) => profile.favorite).length}</span></button></div>
        <div className="host-list">
          {groupedHosts.map((group, groupIndex) => <section className="host-group" key={hostGroupKey(group.group)} aria-label={`${group.name} hosts`}><div className="host-group-heading"><button className="host-group-toggle" aria-label={`${!hostQuery && collapsedGroups.has(hostGroupKey(group.group)) ? 'Expand' : 'Collapse'} ${group.name} hosts`} aria-expanded={!!hostQuery || !collapsedGroups.has(hostGroupKey(group.group))} aria-controls={`host-group-items-${groupIndex}`} disabled={!!hostQuery} title={hostQuery ? 'Groups stay open while searching.' : undefined} onClick={() => toggleHostGroup(group.group)}><ChevronRight size={12} className={hostQuery || !collapsedGroups.has(hostGroupKey(group.group)) ? 'is-expanded' : ''} /><Folder size={12} /><span>{group.name}</span><small>{group.hosts.length}</small></button>{group.group !== null && <button className="icon-button group-run-trigger" aria-label={`Run group command for ${group.name}`} title={`Run a command on ${group.name}`} onClick={() => { setInitialGroupCommand(''); setCommandGroup(group.group) }}><Play size={12} /></button>}</div><div id={`host-group-items-${groupIndex}`} hidden={!hostQuery && collapsedGroups.has(hostGroupKey(group.group))}>{group.hosts.map((profile) => <div className={`host-row-item ${activeTab === 'new' && draft.id === profile.id ? 'is-active' : ''}`} key={profile.id}>
            <button className="host-select" onClick={() => chooseHost(profile)} title={`Connect to ${profile.name}`}><div className="host-avatar"><Server size={17} /></div><div><strong>{profile.name}</strong><span>{profile.username}@{profile.host}</span></div></button>
            <div className="host-actions"><button className={`icon-button ${profile.favorite ? 'is-favorite' : ''}`} aria-label={`${profile.favorite ? 'Unfavorite' : 'Favorite'} ${profile.name}`} aria-pressed={!!profile.favorite} title={profile.favorite ? 'Remove from favorites' : 'Add to favorites'} onClick={() => void toggleFavorite(profile)}><Star size={14} fill={profile.favorite ? 'currentColor' : 'none'} /></button><button className="icon-button" aria-label={`Edit ${profile.name}`} title="Edit host details" onClick={() => chooseHost(profile, false)}><Pencil size={13} /></button><button className="icon-button danger-hover" aria-label={`Delete ${profile.name}`} title="Delete saved host" onClick={() => setDeleteHost(profile)}><Trash2 size={14} /></button></div>
            {quickConnectIds.has(profile.id) && <button className="icon-button host-quick-connect" aria-label={`Quick connect ${profile.name}`} title="Quick connect using the saved password" aria-busy={quickConnecting.has(profile.id)} disabled={quickConnecting.has(profile.id)} onClick={() => void quickConnect(profile)}>{quickConnecting.has(profile.id) ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}</button>}
          </div>)}</div></section>)}
          {!filtered.length && <div className="empty-hosts"><div className="empty-host-icon">{hostFilter === 'favorites' ? <Star size={25} /> : <Server size={25} />}</div><strong>{search ? 'No matching hosts' : hostFilter === 'favorites' ? 'Keep your go-to hosts close' : 'Your hosts belong here'}</strong><p>{search ? 'Try another name, address, or group.' : hostFilter === 'favorites' ? 'Use the star on a saved host to add it here.' : 'Save a connection to find it here next time.'}</p>{!search && hostFilter === 'all' && <button className="button secondary compact" onClick={newConnection}><Plus size={14} />Add a host</button>}</div>}
        </div>
      </div>
      <div className="sidebar-bottom"><button className="sidebar-command" onClick={openPalette} aria-label="Quick switcher" title="Quick switcher (Ctrl+K)"><Search size={16} /><span>Quick switcher</span><kbd>Ctrl K</kbd></button><button className="sidebar-command" onClick={openManagement} aria-label="Manage workspace" title="Manage workspace"><Settings2 size={16} /><span>Manage workspace</span></button><div className="sidebar-service-links"><button className="sidebar-command" onClick={openMcp} aria-label="MCP server" title="MCP server"><Network size={16} /><span>MCP server</span>{mcpState?.enabled && <span className="status-dot online" aria-label="MCP enabled" />}</button><button className="sidebar-command updates-shortcut" onClick={openUpdates} aria-label="Updates" title={updateState?.status === 'available' ? `Version ${updateState.version} available · download and install manually` : 'Updates · check for new releases'}><Download size={16} /><span>Updates</span>{updateState?.status === 'available' && <span className="status-dot update-available-dot" aria-label="Update available" />}</button></div><div className="sidebar-utility-actions"><button className="help-button" onClick={openKeyGenerator} aria-label="Open SSH key generator" title="SSH key generator"><KeyRound size={16} /><span>SSH key generator</span></button><button className="icon-button" onClick={openHelp} title="Help & shortcuts" aria-label="Help & shortcuts"><CircleHelp size={17} /></button></div><div className="sidebar-version"><span><LockKeyhole size={12} />Local workspace</span><span>v0.9.0</span></div></div>
    </aside>
    <main className="main-shell">
      <div className="topbar"><div className="workspace-heading"><div className="navigation-history-controls" role="group" aria-label="Navigation history"><button className="icon-button" aria-label="Go back" title="Go back (Alt+Left)" disabled={navigation.index === 0} onClick={() => moveNavigation(-1)}><ArrowLeft size={16} /></button><button className="icon-button" aria-label="Go forward" title="Go forward (Alt+Right)" disabled={navigation.index === navigation.entries.length - 1} onClick={() => moveNavigation(1)}><ArrowRight size={16} /></button></div><button className="icon-button sidebar-toggle" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="workspace-sidebar" title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</button><div className="breadcrumb"><span>Workspace</span><ChevronRight size={13} /><strong>{active ? active.profile.name : activeTab === 'home' ? 'Home' : activeTab === 'scripts' ? 'Scripts' : activeTab === 'vault' ? 'Vault' : 'Connect'}</strong>{active?.profile.group && <span className="breadcrumb-group">{active.profile.group}</span>}</div></div><div className="topbar-right"><button className={`stream-mode-toggle ${streamMode.enabled ? 'active' : ''}`} aria-label="Stream mode" aria-pressed={streamMode.enabled} title="Stream mode (Ctrl+Shift+S)" onClick={streamMode.toggle}><Radio size={16} /><span>{streamMode.enabled ? 'Stream mode on' : 'Stream mode'}</span></button><span className="topbar-divider" /><button className="icon-button" onClick={openPalette} title="Quick switcher (Ctrl+K)" aria-label="Open quick switcher"><Command size={17} /></button><button className="icon-button" onClick={openWorkspaces} title="Workspaces" aria-label="Workspaces"><Layers size={18} /></button><button className="icon-button appearance-trigger" onClick={openAppearance} title="Appearance" aria-label="Appearance"><Palette size={18} /></button><button className="icon-button header-help" onClick={openHelp} title="Help" aria-label="Open help"><CircleHelp size={18} /></button></div></div>
      <SessionStrip sessions={sessions} activeId={active?.id} onSelect={selectTerminalSession} onClose={requestCloseSession} onNew={newConnection} />
      {streamMode.enabled && <div className="stream-mode-note" role="status"><Radio size={13} /><span>Stream mode · IP addresses are hidden. Connections and scripts still use the real addresses.</span></div>}
      {availableUpdate && <div className="update-notice"><span>SSH Heaven {availableUpdate.version} is available.</span><button className="button subtle compact" onClick={() => void api.openUpdateDownload().catch(notifyError)}>Update available<ArrowRight size={12} /></button><button className="icon-button" aria-label="Dismiss update notification" onClick={() => { dismissedUpdate.current = availableUpdate.version; setAvailableUpdate(null) }}><X size={13} /></button></div>}
      {restoredWorkspace && <div className="workspace-restored-banner"><span><strong>{restoredWorkspace.name}</strong> · {restoredWorkspace.sessionIds.length} hosts restored{restoredWorkspace.missing ? ` · ${restoredWorkspace.missing} saved hosts missing` : ''}{workspaceNeeds.length ? ` · ${workspaceNeeds.length} need credentials` : ''}</span><div>{workspaceNeeds[0] && <button className="button secondary compact" onClick={() => requestWorkspaceCredentials(workspaceNeeds[0])}>Enter credentials</button>}<button className="button primary compact" disabled={workspaceConnecting || !restoredWorkspace.sessionIds.some((id) => sessions.some((session) => session.id === id && session.status !== 'connected' && session.status !== 'connecting'))} onClick={() => void connectWorkspace()}>{workspaceConnecting ? <LoaderCircle size={13} className="spin" /> : <Play size={13} />}Connect workspace</button><button className="icon-button" aria-label="Dismiss workspace notice" onClick={() => { setRestoredWorkspace(null); setWorkspaceNeeds([]) }}><X size={13} /></button></div></div>}
      <div className="workspace-content">
        <div className="vault-workspace" hidden={activeTab !== 'vault'}><VaultPanel api={api} active={activeTab === 'vault'} refreshToken={vaultRefreshToken} onChanged={refreshImportedHosts} onGenerateKey={openVaultKeyGenerator} /></div>
        <div className="scripts-workspace" hidden={activeTab !== 'scripts'}><ScriptsPanel scripts={library.runbooks} target={scriptTarget} targets={scriptTargets} onTargetChange={setScriptTargetId} onSave={saveScript} onDelete={deleteScript} onRun={runScript} /></div>
        {activeTab === 'home' && <HomeScreen profiles={profiles} recentHosts={currentRecentHosts} connectedCount={connectedCount} onNewConnection={newConnection} onSelectHost={chooseHost} onEditNickname={editNickname} onFavorite={toggleFavorite} onGenerateKey={openKeyGenerator} onOpenPalette={openPalette} onClearRecent={clearRecentHosts} quickConnectIds={quickConnectIds} quickConnecting={quickConnecting} onQuickConnect={quickConnect} />}
        <div className="connection-form-workspace" hidden={activeTab !== 'new'}><ConnectionForm key={draftVersion} initial={draft} onConnect={connect} onSave={saveProfile} onError={notifyError} saved={profiles.some((profile) => profile.id === draft.id)} favorite={profiles.find((profile) => profile.id === draft.id)?.favorite} groups={groups} profiles={profiles} onSelectHost={chooseHost} onOpenPalette={openPalette} onGenerateKey={openKeyGenerator} generatedKey={generatedKey} credentialStatus={credentialStatus} onForgetCredential={forgetCredential} library={library} credentialError={credentialError} /></div>
        <div className="session-layout-shell" hidden={!active}>
          <div className="session-layout-toolbar" role="toolbar" aria-label="Session workspace tools"><span>Layout</span><button className={`icon-button ${layout === 'tabs' ? 'active' : ''}`} aria-label="Tabs layout" aria-pressed={layout === 'tabs'} title="Tabs" onClick={() => changeLayout('tabs')}><TerminalSquare size={16} /></button><button className={`icon-button ${layout === 'split' ? 'active' : ''}`} aria-label="Split layout" aria-pressed={layout === 'split'} title="Split · 2 panes" onClick={() => changeLayout('split')}><Columns2 size={16} /></button><button className={`icon-button ${layout === 'grid' ? 'active' : ''}`} aria-label="Grid layout" aria-pressed={layout === 'grid'} title="Grid · up to 4 panes" onClick={() => changeLayout('grid')}><LayoutGrid size={16} /></button><span className="layout-toolbar-spacer" /><button className="button subtle compact" aria-label="Save or restore workspace" onClick={openWorkspaces}><Layers size={14} />Workspaces</button><button className="icon-button" aria-label="Server dashboard" title="Server dashboard" disabled={!connectedSessions.length} onClick={openDashboard}><Activity size={16} /></button><button className="icon-button" aria-label="SSH tunnels" title="SSH tunnels" disabled={!connectedSessions.length} onClick={openTunnels}><Network size={16} /></button><button className={`button subtle compact ${showFiles ? 'active' : ''}`} aria-label="Toggle remote files" aria-pressed={showFiles} onClick={toggleFiles}><FolderOpen size={14} />Files</button></div>
          <div className={`session-desktop ${showFiles ? '' : 'hide-files'}`}>
            <div className="session-panes" data-layout={layout} data-count={paneIds.length}>
              {sessions.map((session) => <section key={session.id} data-session-id={session.id} className={`session-workspace ${paneIds.includes(session.id) ? '' : 'hidden-workspace'} ${activeTab === session.id ? 'is-active-pane' : ''}`} aria-label={`${session.profile.name} session`} style={{ order: paneIds.indexOf(session.id) }} onPointerDownCapture={() => setActiveTab(session.id)}>
                <div className="terminal-column"><div className="terminal-heading"><div><TerminalSquare size={15} /><span>{session.profile.username}@{session.profile.host}</span><span className="terminal-port">:{session.profile.port}</span></div><div>{layout !== 'tabs' && <div className="pane-order-controls"><button className="icon-button" aria-label={`Move ${session.profile.name} pane left`} title="Move pane earlier" disabled={paneIds.indexOf(session.id) <= 0} onClick={() => movePane(session.id, -1)}><ArrowLeft size={12} /></button><button className="icon-button" aria-label={`Move ${session.profile.name} pane right`} title="Move pane later" disabled={!paneIds.includes(session.id) || paneIds.indexOf(session.id) >= paneIds.length - 1} onClick={() => movePane(session.id, 1)}><ArrowRight size={12} /></button></div>}<button className="icon-button danger-hover" title="Disconnect" aria-label="Disconnect session" disabled={session.status === 'disconnected' || session.status === 'error'} onClick={() => void disconnectSession(session.id).catch(notifyError)}><Unplug size={15} /></button></div></div>
                <div className="terminal-container"><TerminalView sessionId={session.id} active={activeTab === session.id} connected={session.status === 'connected'} transport={transport} onError={notifyError} />{session.status === 'connecting' && <div className="connection-overlay"><LoaderCircle size={25} className="spin" /><strong>Connecting to {session.profile.host}</strong><span>{session.retryMessage || 'Opening your secure shell…'}</span><button className="button secondary compact" onClick={() => void disconnectSession(session.id).catch(notifyError)}>Cancel connection</button></div>}</div>
                {(session.status === 'error' || session.status === 'disconnected') && <div className={`session-notice ${session.status === 'error' ? 'error-message' : ''}`} role="status"><Unplug size={16} /><div><strong>{session.status === 'error' ? 'Connection failed' : 'Session disconnected'}</strong>{session.message && <span>{session.message}</span>}{session.retryMessage && <span>{session.retryMessage}</span>}</div><button className="button secondary compact" onClick={() => { void disconnectSession(session.id).catch(notifyError); chooseHost(profiles.find((profile) => profile.id === session.profile.id && sameEndpoint(profile, session.profile)) ?? session.profile); setCredentialSessionId(session.id) }}>Reconnect<ArrowRight size={13} /></button></div>}
                <div className="terminal-footer"><span><span className={`status-dot ${session.status === 'connected' ? 'online' : 'offline'}`} />{session.status === 'connected' ? 'Connected' : session.status === 'connecting' ? 'Connecting' : 'Disconnected'}</span><span>SSH · {session.profile.host}:{session.profile.port}</span><span>UTF-8</span></div></div>
              </section>)}
            </div>
            {sessions.map((session) => <div className="session-file-slot" key={session.id} hidden={!showFiles || activeTab !== session.id}><FileBrowser sessionId={session.id} connected={session.status === 'connected'} api={api} onClose={() => setShowFiles(false)} onEdit={(path) => setEditing({ sessionId: session.id, path })} refreshToken={editorRefreshToken} /></div>)}
          </div>
        </div>
      </div>
      <footer className="app-statusbar"><span><ShieldCheck size={13} />{active?.status === 'connected' ? 'Secure connection' : active?.status === 'connecting' ? 'Connecting to server…' : 'Ready to connect'}</span><span>{profiles.length} saved {profiles.length === 1 ? 'host' : 'hosts'}<span className="statusbar-divider">/</span>SSH + SFTP</span></footer>
    </main>
    {toast && <div className={`toast ${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>{toast.kind === 'error' ? <ShieldX size={17} /> : <CheckCheck size={17} />}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={15} /></button></div>}
    {paletteOpen && <CommandPalette sessions={sessions} activeSessionId={active?.id} onSelectSession={selectTerminalSession} onUpdates={checkUpdates} profiles={profiles} onSelectHost={chooseHost} onNewConnection={newConnection} onHelp={openHelp} onHome={openHome} onGenerateKey={openKeyGenerator} onAppearance={openAppearance} onBulkImport={openBulkImport} onGroupCommand={openGroupCommand} onWorkspaces={openWorkspaces} onManagement={openManagement} onDashboard={openDashboard} onTunnels={openTunnels} onMcp={openMcp} onScripts={openScripts} onVault={openVault} onToggleStreamMode={streamMode.toggle} streamMode={streamMode.enabled} onClose={closePalette} quickConnectIds={quickConnectIds} quickConnecting={quickConnecting} onQuickConnect={quickConnect} />}
    {keyGeneratorOpen && <KeyGenerator api={api} onClose={closeKeyGenerator} onUseKey={keyGeneratorForVault ? (key) => { void addGeneratedVaultKey(key) } : useGeneratedKey} useKeyLabel={keyGeneratorForVault ? 'Add key to vault' : undefined} useKeyBusy={addingVaultKey} />}
    {appearanceOpen && <Appearance onClose={closeAppearance} />}
    {editing && <RemoteEditor key={`${editing.sessionId}:${editing.path}`} sessionId={editing.sessionId} path={editing.path} api={api} onClose={closeEditor} />}
    {bulkImportOpen && <BulkImport api={api} profiles={profiles} groups={groups} library={library} onImported={refreshImportedHosts} onClose={closeBulkImport} />}
    {commandGroup !== null && <GroupCommand api={api} profiles={profiles} initialGroup={commandGroup} initialCommand={initialGroupCommand} onClose={closeGroupCommand} />}
    {managementOpen && <ManagementPanel key={managementStart} initialTab={managementStart} api={api} profiles={profiles} onChanged={refreshImportedHosts} onClose={closeManagement} onRunCommand={(group, command) => { setManagementOpen(false); setInitialGroupCommand(command); setCommandGroup(group) }} />}
    {mcpOpen && <McpPanel api={api} onClose={closeMcp} />}
    {workspacesOpen && <WorkspaceManager api={api} profiles={profiles} library={library} currentProfileIds={[...paneIds.map((id) => sessions.find((session) => session.id === id)?.profile.id).filter((id): id is string => !!id), ...sessions.map((session) => session.profile.id)]} layout={layout} onChanged={refreshLibrary} onRestore={restoreWorkspace} onClose={closeWorkspaces} />}
    {dashboardOpen && <ServerDashboard api={api} sessions={connectedSessions} initialSessionId={active?.status === 'connected' ? active.id : undefined} onClose={closeDashboard} />}
    {tunnelsOpen && <TunnelManager api={api} sessions={connectedSessions} initialSessionId={active?.status === 'connected' ? active.id : undefined} library={library} onChanged={refreshLibrary} onClose={closeTunnels} />}
    {closeTarget && <Modal title="Close this session?" onClose={cancelClose} className="small-modal"><p className="modal-description">Closing <strong>{closeTarget.profile.name}</strong> disconnects the active SSH session.</p><div className="modal-actions"><button className="button secondary" disabled={closing} onClick={cancelClose}>Keep open</button><button className="button danger-button" disabled={closing} onClick={() => void confirmCloseSession()}>{closing ? <LoaderCircle size={15} className="spin" /> : <Unplug size={15} />}Disconnect & close</button></div></Modal>}
    {challenges[0] && <Modal title={challenges[0].previousFingerprint ? 'Server identity has changed' : 'Verify server identity'} onClose={rejectTrust} className="trust-modal"><div className={`trust-icon ${challenges[0].previousFingerprint ? 'warning' : ''}`}>{challenges[0].previousFingerprint ? <ShieldX size={28} /> : <ShieldQuestion size={28} />}</div><p className="modal-description">{challenges[0].previousFingerprint ? 'This server is presenting a different host key than the one you previously trusted. Confirm the new fingerprint with your server administrator before continuing.' : 'This is your first connection to this server. Compare this fingerprint with the one provided by your server administrator.'}</p><div className="fingerprint-card"><span>SERVER</span><strong>{challenges[0].host}:{challenges[0].port}</strong><span>SHA256 FINGERPRINT</span><code>{challenges[0].fingerprint}</code>{challenges[0].previousFingerprint && <><span>PREVIOUS FINGERPRINT</span><code className="previous-fingerprint">{challenges[0].previousFingerprint}</code></>}</div><div className="modal-actions"><button className="button secondary" disabled={trustBusy} onClick={rejectTrust}>Cancel connection</button><button className={`button ${challenges[0].previousFingerprint ? 'danger-button' : 'primary'}`} disabled={trustBusy} onClick={() => void resolveTrust(true)}>{trustBusy ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}{challenges[0].previousFingerprint ? 'Trust new key & connect' : 'Trust & connect'}</button></div></Modal>}
    {deleteHost && <Modal title="Delete saved host?" onClose={closeDelete} className="small-modal"><p className="modal-description">Remove <strong>{deleteHost.name}</strong> from your saved hosts? Existing sessions will stay open.</p><div className="modal-actions"><button className="button secondary" onClick={closeDelete}>Cancel</button><button className="button danger-button" onClick={() => void api.deleteProfile(deleteHost.id).then(() => { setProfiles((current) => current.filter((profile) => profile.id !== deleteHost.id)); void refreshRecentHosts().catch(notifyError); void refreshCredentialStatus().catch(notifyError); setDeleteHost(null) }).catch(notifyError)}><Trash2 size={14} />Delete host</button></div></Modal>}
    {help && <Modal title="Make yourself at home" onClose={closeHelp} className="help-modal"><div className="help-step"><span>01</span><div><h3>Add a connection</h3><p>Enter your server’s address and username. Connect using a password or a private SSH key.</p></div></div><div className="help-step"><span>02</span><div><h3>Verify your server</h3><p>Check the host-key fingerprint before trusting a new server. We remember trusted keys on this device.</p></div></div><div className="help-step"><span>03</span><div><h3>Work, side by side</h3><p>Use the terminal and remote file browser together. Select a file to download; double-click a folder to open it.</p></div></div><div className="keyboard-hints"><span>Find hosts & actions<kbd>Ctrl K</kbd></span><span>New connection<kbd>Ctrl Shift N</kbd></span><span>Back / forward<kbd>Alt Left / Alt Right</kbd></span><span>Home / Connect / Scripts / Vault<kbd>Ctrl 1 / 2 / 3 / 4</kbd></span><span>Next / previous session<kbd>Ctrl Tab / Ctrl Shift Tab</kbd></span><span>Close active session<kbd>Ctrl W</kbd></span><span>Search terminal output<kbd>Ctrl Shift F</kbd></span><span>Stream mode<kbd>Ctrl Shift S</kbd></span><span>Copy terminal selection<kbd>Ctrl Shift C</kbd></span><span>Paste into terminal<kbd>Ctrl Shift V</kbd></span></div><p className="help-note">Server passwords can be remembered in encrypted storage on this device. Key passphrases are entered each time.</p><button className="button primary full-width" onClick={closeHelp}>Let’s connect<ArrowRight size={15} /></button></Modal>}
    {mcpState?.pendingApprovals[0] && <McpApprovalDialog api={api} request={mcpState.pendingApprovals[0]} onResolved={onMcpResolved} />}
  </div>
}
