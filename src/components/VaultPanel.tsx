import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, EyeOff, FileKey2, KeyRound, LoaderCircle, LockKeyhole, Pencil, Plus, Search, ShieldCheck, Trash2, UnlockKeyhole } from 'lucide-react'
import type { HostProfile, SavedKey, SshHeavenApi, VaultSnapshot, VaultState } from '../../shared/types'
import { isStreamModeEnabled, useStreamMode } from '../stream-mode'
import { Modal, errorMessage } from './Modal'
import './vault.css'

const validPin = (value: string) => /^[0-9]{5}$/.test(value)
const pinInput = (value: string) => value.replace(/[^0-9]/g, '').slice(0, 5)
const endpoint = (profile: HostProfile) => `${profile.username}@${profile.host.includes(':') ? `[${profile.host}]` : profile.host}:${profile.port}`
type PasswordEdit = { profile: HostProfile; password: string; confirmation: string; replacing: boolean }
type PinEdit = { kind: 'change' | 'disable'; current: string; next: string; confirmation: string }

export function VaultPanel({ api, onChanged, onGenerateKey, active, refreshToken = 0 }: {
  api: SshHeavenApi
  onChanged: () => Promise<void>
  onGenerateKey: () => void
  active: boolean
  refreshToken?: number
}) {
  const { enabled: streamMode } = useStreamMode()
  const [state, setState] = useState<VaultState | null>(null)
  const stateRef = useRef<VaultState | null>(null)
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)
  const [grantVersion, setGrantVersion] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const busyRef = useRef(false)
  const [tab, setTab] = useState<'passwords' | 'keys' | 'settings'>('passwords')
  const [search, setSearch] = useState('')
  const [pin, setPin] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [passwordEdit, setPasswordEdit] = useState<PasswordEdit | null>(null)
  const [forgetTarget, setForgetTarget] = useState<HostProfile | null>(null)
  const [keyEdit, setKeyEdit] = useState<SavedKey | null>(null)
  const [deleteKey, setDeleteKey] = useState<SavedKey | null>(null)
  const [pinEdit, setPinEdit] = useState<PinEdit | null>(null)
  const [revealed, setRevealed] = useState<{ id: string; value: string; expiresAt: number } | null>(null)
  const [now, setNow] = useState(Date.now)
  const activeRef = useRef(active)
  activeRef.current = active
  const securityEpoch = useRef(0)
  const stateRevision = useRef(0)
  const mounted = useRef(true)
  const wasActive = useRef(active)
  const hideSecret = useCallback(() => { securityEpoch.current++; setRevealed(null) }, [])
  const clearSensitive = useCallback(() => {
    securityEpoch.current++; setRevealed(null); setSnapshot(null)
    setPin(''); setConfirmation(''); setPasswordEdit(null); setForgetTarget(null)
    setKeyEdit(null); setDeleteKey(null); setPinEdit(null)
  }, [])
  const applyState = useCallback((next: VaultState, authoritative = false) => {
    const previous = stateRef.current
    stateRevision.current++; stateRef.current = next
    if (!mounted.current) return
    setState(next)
    if (!next.unlocked && (authoritative || !previous || previous.unlocked || previous.pinEnabled !== next.pinEnabled)) clearSensitive()
    else if (!previous?.unlocked || previous.unlocksUntil !== next.unlocksUntil) setGrantVersion((version) => version + 1)
  }, [clearSensitive])
  const readState = useCallback(async () => {
    const revision = stateRevision.current
    const next = await api.getVaultState()
    if (mounted.current && revision === stateRevision.current) applyState(next)
    return next
  }, [api, applyState])
  const readSnapshot = useCallback(async () => {
    const epoch = securityEpoch.current
    if (!activeRef.current || !stateRef.current?.unlocked) return
    const next = await api.getVaultSnapshot()
    if (mounted.current && activeRef.current && stateRef.current?.unlocked && epoch === securityEpoch.current) setSnapshot(next)
  }, [api])
  useEffect(() => {
    mounted.current = true
    const stop = api.onVaultState((next) => applyState(next, true))
    void readState().catch((cause) => { if (mounted.current) setError(errorMessage(cause)) }).finally(() => { if (mounted.current) setLoading(false) })
    return () => { mounted.current = false; securityEpoch.current++; stop() }
  }, [api, applyState, readState])
  useEffect(() => {
    if (!active) {
      clearSensitive(); setError(''); setNotice('')
      if (wasActive.current) void api.lockVault().then(() => readState()).catch(() => {})
    } else {
      void readState().catch((cause) => setError(errorMessage(cause)))
    }
    wasActive.current = active
  }, [active, api, applyState, clearSensitive, readState])
  useEffect(() => {
    if (!active || !state?.unlocked) return
    setLoading(true)
    void readSnapshot().catch((cause) => { setError(errorMessage(cause)); void readState().catch(() => {}) }).finally(() => setLoading(false))
  }, [active, state?.unlocked, readSnapshot, readState, refreshToken, grantVersion])
  useEffect(() => {
    if (streamMode) hideSecret()
  }, [streamMode, hideSecret])
  useEffect(() => {
    if (!active || !state?.pinEnabled) return
    const timer = setInterval(() => {
      const value = Date.now(); setNow(value)
      if (stateRef.current?.unlocked && stateRef.current.unlocksUntil && value >= stateRef.current.unlocksUntil) {
        clearSensitive(); void api.lockVault().then(() => readState()).catch(() => {})
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [active, state?.pinEnabled, api, readState, clearSensitive])
  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(hideSecret, Math.max(0, revealed.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [revealed, hideSecret])

  async function perform(name: string, action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(name); setError(''); setNotice('')
    try { await action() }
    catch (cause) { setError(errorMessage(cause)); void readState().catch(() => {}) }
    finally { busyRef.current = false; if (mounted.current) setBusy('') }
  }
  async function enter() {
    if (!validPin(pin)) { setError('Enter a five-digit PIN using numbers 0–9.'); return }
    if (!state?.pinEnabled && pin !== confirmation) { setError('The PINs do not match. Enter the same five digits twice.'); return }
    const value = pin
    setPin(''); setConfirmation('')
    await perform(state?.pinEnabled ? 'unlock' : 'setup', async () => {
      await (state?.pinEnabled ? api.unlockVault(value) : api.setupVaultPin(value))
      await readState()
      setTab('passwords')
    })
  }
  async function lock() {
    clearSensitive()
    if (stateRef.current) applyState({ ...stateRef.current, unlocked: false })
    // Locking must remain available while a reveal or save is in flight.
    // Revoking the native grant also invalidates those pending operations.
    try { await api.lockVault(); await readState() }
    catch (cause) { setError(errorMessage(cause)) }
  }
  async function reveal(profile: HostProfile) {
    if (streamMode || isStreamModeEnabled() || busyRef.current) return
    if (revealed?.id === profile.id) { hideSecret(); return }
    hideSecret()
    const epoch = securityEpoch.current
    await perform(`reveal:${profile.id}`, async () => {
      const value = await api.revealVaultPassword(profile.id)
      if (activeRef.current && stateRef.current?.unlocked && !isStreamModeEnabled() && epoch === securityEpoch.current) setRevealed({ id: profile.id, value, expiresAt: Date.now() + 30_000 })
    })
  }
  async function copy(profile: HostProfile) {
    await perform(`copy:${profile.id}`, async () => { await api.copyVaultPassword(profile.id); setNotice('Password copied. The clipboard clears after 30 seconds if it is unchanged.') })
  }
  async function savePassword() {
    if (!passwordEdit) return
    if (!passwordEdit.password) { setError('Enter the password to store for this server.'); return }
    if (passwordEdit.password !== passwordEdit.confirmation) { setError('The passwords do not match.'); return }
    const value = passwordEdit
    await perform('password', async () => {
      await api.saveVaultPassword(value.profile.id, value.password)
      setPasswordEdit(null); hideSecret(); await readSnapshot(); await onChanged(); setNotice(`Password saved for ${value.profile.name}.`)
    })
  }
  async function forget() {
    if (!forgetTarget) return
    const profile = forgetTarget
    await perform('forget', async () => { await api.forgetVaultPassword(profile.id); setForgetTarget(null); hideSecret(); await readSnapshot(); await onChanged(); setNotice(`Saved password removed for ${profile.name}.`) })
  }
  async function browseKey() {
    const epoch = securityEpoch.current
    await perform('browse', async () => { const filename = await api.pickPrivateKey(); if (filename && activeRef.current && stateRef.current?.unlocked && epoch === securityEpoch.current) setKeyEdit((current) => current ? { ...current, path: filename } : current) })
  }
  async function saveKey() {
    if (!keyEdit?.name.trim() || !keyEdit.path) { setError('Give the SSH key a name and choose its private key file.'); return }
    const key = { ...keyEdit, name: keyEdit.name.trim() }
    await perform('key', async () => { await api.saveVaultKey(key); setKeyEdit(null); await readSnapshot(); await onChanged(); setNotice(`${key.name} added to the key library.`) })
  }
  async function removeKey() {
    if (!deleteKey) return
    const key = deleteKey
    await perform('delete-key', async () => { await api.deleteVaultKey(key.id); setDeleteKey(null); await readSnapshot(); await onChanged(); setNotice(`${key.name} removed from the key library.`) })
  }
  async function updatePin() {
    if (!pinEdit) return
    if (!validPin(pinEdit.current) || pinEdit.kind === 'change' && !validPin(pinEdit.next)) { setError('Use exactly five digits for each PIN.'); return }
    if (pinEdit.kind === 'change' && pinEdit.next !== pinEdit.confirmation) { setError('The new PINs do not match.'); return }
    const value = pinEdit
    setPinEdit({ ...pinEdit, current: '', next: '', confirmation: '' })
    await perform('pin', async () => {
      await (value.kind === 'change' ? api.changeVaultPin(value.current, value.next) : api.disableVaultPin(value.current))
      await readState()
      setPinEdit(null); setNotice(value.kind === 'change' ? 'Vault PIN changed.' : 'Vault PIN disabled. Set up a PIN to use the manager again.')
    })
  }
  const closePassword = useCallback(() => { if (!busyRef.current) { setPasswordEdit(null); setError('') } }, [])
  const closeForget = useCallback(() => { if (!busyRef.current) { setForgetTarget(null); setError('') } }, [])
  const closeKey = useCallback(() => { if (!busyRef.current) { setKeyEdit(null); setError('') } }, [])
  const closeDeleteKey = useCallback(() => { if (!busyRef.current) { setDeleteKey(null); setError('') } }, [])
  const closePin = useCallback(() => { if (!busyRef.current) { setPinEdit(null); setError('') } }, [])
  const unlocked = !!state?.unlocked && (!state.unlocksUntil || now < state.unlocksUntil)
  const throttled = !!state?.lockedUntil && state.lockedUntil > now
  const retrySeconds = state?.lockedUntil ? Math.max(0, Math.ceil((state.lockedUntil - now) / 1000)) : 0
  const profiles = (snapshot?.profiles || []).filter((profile) => profile.authType === 'password' && `${profile.name} ${profile.host} ${profile.username} ${profile.group || ''}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))
  const keys = (snapshot?.keys || []).filter((key) => `${key.name} ${key.path}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name))
  const modalOpen = passwordEdit || forgetTarget || keyEdit || deleteKey || pinEdit

  return <section className="vault-panel" aria-label="Vault workspace">
    <header className="vault-heading"><div><span><ShieldCheck size={23} /></span><div><h1>Vault</h1><p>Password and SSH key management, protected by your PIN.</p></div></div>{unlocked && <button className="button secondary" aria-label="Lock vault" onClick={() => void lock()}><LockKeyhole size={15} />Lock vault</button>}</header>
    {loading && !state ? <div className="vault-empty" role="status"><LoaderCircle size={25} className="spin" />Checking the vault…</div> : !unlocked ? <div className="vault-gate"><div className="vault-gate-icon">{state?.pinEnabled ? <LockKeyhole size={30} /> : <ShieldCheck size={30} />}</div><h2>{state?.pinEnabled ? 'Your vault is locked.' : 'Protect your vault controls.'}</h2><p>{state?.pinEnabled ? 'Enter your five-digit PIN to manage saved passwords and SSH keys.' : 'Set a five-digit PIN to enable the vault manager. Quick connect can keep using saved passwords while the vault is locked.'}</p>{(error || state?.error) && <div className="form-error" role="alert">{error || state?.error}</div>}{notice && <div className="vault-notice" role="status">{notice}</div>}{state && !state.available && <div className="form-error" role="alert">Encrypted password storage is unavailable on this device.</div>}<form noValidate onSubmit={(event) => { event.preventDefault(); void enter() }}><label className="field-label">{state?.pinEnabled ? 'Vault PIN' : 'New vault PIN'}<input type="password" inputMode="numeric" autoComplete="off" maxLength={5} value={pin} disabled={!!busy || throttled || !state?.available} onChange={(event) => setPin(pinInput(event.target.value))} placeholder="5 digits" /></label>{!state?.pinEnabled && <label className="field-label">Confirm vault PIN<input type="password" inputMode="numeric" autoComplete="off" maxLength={5} value={confirmation} disabled={!!busy || !state?.available} onChange={(event) => setConfirmation(pinInput(event.target.value))} placeholder="Repeat your PIN" /></label>}<button className="button primary" disabled={!!busy || throttled || !state?.available}>{busy ? <LoaderCircle size={15} className="spin" /> : state?.pinEnabled ? <UnlockKeyhole size={15} /> : <ShieldCheck size={15} />}{state?.pinEnabled ? 'Unlock vault' : 'Enable vault'}</button></form>{throttled && <p className="vault-lockout" role="status">Too many attempts. Try again in {retrySeconds} seconds.</p>}<small>The PIN protects vault management. Saved passwords still use your device’s encrypted storage.</small></div> : <>
      <nav className="vault-tabs" aria-label="Vault sections">{(['passwords', 'keys', 'settings'] as const).map((value) => <button key={value} aria-pressed={tab === value} disabled={!!busy} className={tab === value ? 'active' : ''} onClick={() => { hideSecret(); setTab(value); setSearch(''); setError(''); setNotice('') }}>{value === 'passwords' ? 'Passwords' : value === 'keys' ? 'SSH keys' : 'PIN settings'}{value === 'passwords' && <span>{snapshot?.passwordProfileIds.length || 0}</span>}{value === 'keys' && <span>{snapshot?.keys.length || 0}</span>}</button>)}</nav>
      <div className="vault-content">{!modalOpen && error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="vault-notice" role="status"><Check size={15} />{notice}</div>}
      {tab === 'settings' ? <div className="vault-settings"><section><LockKeyhole size={24} /><div><h2>Your PIN, your control.</h2><p>The vault locks automatically after five minutes, when the window is minimized, or when you leave this tab. Quick connect stays available.</p></div></section><div className="vault-setting-actions"><button className="button secondary" onClick={() => { setError(''); setPinEdit({ kind: 'change', current: '', next: '', confirmation: '' }) }}><Pencil size={15} />Change vault PIN</button><button className="button secondary" onClick={() => { setError(''); setPinEdit({ kind: 'disable', current: '', next: '', confirmation: '' }) }}>Disable vault PIN</button></div><p className="vault-management-note">Disabling the PIN turns off this manager. Saved server passwords and key files stay available to your existing connections.</p></div> : <>
        <div className="vault-section-toolbar"><label className="vault-search"><Search size={16} /><input aria-label={tab === 'passwords' ? 'Search vault passwords' : 'Search vault keys'} placeholder={tab === 'passwords' ? 'Find a saved host…' : 'Find an SSH key…'} value={search} onChange={(event) => setSearch(event.target.value)} /></label>{tab === 'keys' && <div><button className="button secondary" disabled={!!busy} onClick={() => { hideSecret(); onGenerateKey() }}><KeyRound size={15} />Generate SSH key</button><button className="button primary" disabled={!!busy} onClick={() => { hideSecret(); setError(''); setKeyEdit({ id: crypto.randomUUID(), name: '', path: '' }) }}><Plus size={15} />Add SSH key</button></div>}</div>
        {streamMode && tab === 'passwords' && <p className="vault-stream-note"><EyeOff size={15} />Password reveal is disabled in Stream mode. Native copy remains available.</p>}
        {loading && !snapshot ? <div className="vault-empty" role="status"><LoaderCircle size={23} className="spin" />Loading vault entries…</div> : tab === 'passwords' ? <div className="vault-entry-list">{profiles.map((profile) => {
          const stored = !!snapshot?.passwordProfileIds.includes(profile.id)
          return <article className="vault-password-entry" key={profile.id}><div className="vault-entry-summary"><span className="vault-entry-icon"><LockKeyhole size={18} /></span><div><h3>{profile.name}</h3><p>{endpoint(profile)}</p><small className={stored ? 'vault-stored' : ''}>{stored ? 'Password saved' : 'No saved password'}</small></div><div className="vault-entry-actions">{stored && <><button className="button secondary compact" aria-label={`${revealed?.id === profile.id ? 'Hide' : 'Reveal'} password for ${profile.name}`} disabled={!!busy || streamMode} onClick={() => void reveal(profile)}>{busy === `reveal:${profile.id}` ? <LoaderCircle size={14} className="spin" /> : revealed?.id === profile.id ? <EyeOff size={14} /> : <Eye size={14} />}{revealed?.id === profile.id ? 'Hide' : 'Reveal'}</button><button className="button secondary compact" aria-label={`Copy password for ${profile.name}`} disabled={!!busy} onClick={() => void copy(profile)}><Copy size={14} />Copy</button></>}<button className="button secondary compact" aria-label={`${stored ? 'Replace' : 'Set'} password for ${profile.name}`} disabled={!!busy} onClick={() => { hideSecret(); setError(''); setPasswordEdit({ profile, password: '', confirmation: '', replacing: stored }) }}><Pencil size={14} />{stored ? 'Replace' : 'Set password'}</button>{stored && <button className="icon-button danger-hover" aria-label={`Forget password for ${profile.name}`} disabled={!!busy} onClick={() => { hideSecret(); setError(''); setForgetTarget(profile) }}><Trash2 size={15} /></button>}</div></div>{revealed?.id === profile.id && <div className="vault-revealed"><code className="vault-secret" aria-label={`Revealed password for ${profile.name}`}>{revealed.value}</code><small>Hides automatically after 30 seconds.</small></div>}</article>
        })}{!profiles.length && <div className="vault-empty"><LockKeyhole size={30} /><strong>{search ? 'No matching hosts' : 'Add a password connection first'}</strong><p>{search ? 'Try another nickname or address.' : 'Saved hosts using password authentication appear here for management.'}</p></div>}</div> : <div className="vault-entry-list">{keys.map((key) => <article className="vault-key-entry" key={key.id}><span className="vault-entry-icon"><FileKey2 size={19} /></span><div><h3>{key.name}</h3><p>{key.path}</p><small>{key.available === false ? 'File is unavailable. Choose its current location.' : 'Private key file on this device'}</small></div><button className="icon-button" aria-label={`Edit vault key ${key.name}`} disabled={!!busy} onClick={() => { setError(''); setKeyEdit({ ...key }) }}><Pencil size={15} /></button><button className="icon-button danger-hover" aria-label={`Remove vault key ${key.name}`} disabled={!!busy} onClick={() => { setError(''); setDeleteKey(key) }}><Trash2 size={15} /></button></article>)}{!keys.length && <div className="vault-empty"><FileKey2 size={30} /><strong>{search ? 'No matching keys' : 'Give your SSH keys a home'}</strong><p>{search ? 'Try another key name.' : 'Add an existing private key file or generate a new pair, then add it to your library.'}</p></div>}</div>}
      </>}
      </div><footer className="vault-footer"><ShieldCheck size={13} /><span>Unlocked · reveals hide after 30 seconds · automatic locking is on</span></footer>
    </>}
    {unlocked && passwordEdit && <Modal title={passwordEdit.replacing ? 'Replace saved password?' : 'Set saved password'} onClose={closePassword} className="vault-edit-modal"><p className="modal-description">{passwordEdit.replacing ? 'Replace the saved password for' : 'Store a password for'} <strong>{passwordEdit.profile.name}</strong> ({endpoint(passwordEdit.profile)}). Quick connect will use this value.</p><label className="field-label">New server password<input type="password" autoComplete="new-password" maxLength={8192} disabled={!!busy} value={passwordEdit.password} onChange={(event) => setPasswordEdit({ ...passwordEdit, password: event.target.value })} /></label><label className="field-label">Confirm server password<input type="password" autoComplete="new-password" maxLength={8192} disabled={!!busy} value={passwordEdit.confirmation} onChange={(event) => setPasswordEdit({ ...passwordEdit, confirmation: event.target.value })} /></label>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={closePassword}>Cancel</button><button className="button primary" aria-label="Save vault password" disabled={!!busy} onClick={() => void savePassword()}>{busy === 'password' ? <LoaderCircle size={15} className="spin" /> : <ShieldCheck size={15} />}Save password</button></div></Modal>}
    {unlocked && forgetTarget && <Modal title="Forget saved password?" onClose={closeForget} className="small-modal"><p className="modal-description">Remove the stored password for <strong>{forgetTarget.name}</strong>? You will enter a password the next time you connect.</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={closeForget}>Keep password</button><button className="button danger-button" aria-label="Confirm forget password" disabled={!!busy} onClick={() => void forget()}><Trash2 size={15} />Forget password</button></div></Modal>}
    {unlocked && keyEdit && <Modal title={snapshot?.keys.some((key) => key.id === keyEdit.id) ? 'Edit SSH key' : 'Add SSH key'} onClose={closeKey} className="vault-edit-modal"><label className="field-label">Vault key name<input value={keyEdit.name} maxLength={100} disabled={!!busy} onChange={(event) => setKeyEdit({ ...keyEdit, name: event.target.value })} placeholder="e.g. Work laptop" /></label><div className="key-picker"><FileKey2 size={16} /><span>{keyEdit.path || 'Choose a private key file'}</span><button className="button secondary compact" disabled={!!busy} aria-label="Browse vault SSH key" onClick={() => void browseKey()}>{busy === 'browse' ? <LoaderCircle size={14} className="spin" /> : null}Browse</button></div><p className="vault-management-note">This library stores the name and path. Private key contents are never displayed here.</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={closeKey}>Cancel</button><button className="button primary" aria-label="Save vault key" disabled={!!busy} onClick={() => void saveKey()}><ShieldCheck size={15} />Save key</button></div></Modal>}
    {unlocked && deleteKey && <Modal title="Remove SSH key from library?" onClose={closeDeleteKey} className="small-modal"><p className="modal-description">Remove <strong>{deleteKey.name}</strong> from your named key library? Its private key file stays on this device.</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={closeDeleteKey}>Keep key</button><button className="button danger-button" aria-label="Confirm remove vault key" disabled={!!busy} onClick={() => void removeKey()}><Trash2 size={15} />Remove key</button></div></Modal>}
    {unlocked && pinEdit && <Modal title={pinEdit.kind === 'change' ? 'Change vault PIN' : 'Disable vault PIN?'} onClose={closePin} className="vault-edit-modal">{pinEdit.kind === 'disable' && <p className="modal-description">Disabling the PIN turns off vault management. Saved passwords remain available to Quick connect. Enter your current PIN to continue.</p>}<label className="field-label">Current vault PIN<input type="password" inputMode="numeric" autoComplete="off" maxLength={5} disabled={!!busy} value={pinEdit.current} onChange={(event) => setPinEdit({ ...pinEdit, current: pinInput(event.target.value) })} /></label>{pinEdit.kind === 'change' && <><label className="field-label">New vault PIN<input type="password" inputMode="numeric" autoComplete="off" maxLength={5} disabled={!!busy} value={pinEdit.next} onChange={(event) => setPinEdit({ ...pinEdit, next: pinInput(event.target.value) })} /></label><label className="field-label">Confirm vault PIN<input type="password" inputMode="numeric" autoComplete="off" maxLength={5} disabled={!!busy} value={pinEdit.confirmation} onChange={(event) => setPinEdit({ ...pinEdit, confirmation: pinInput(event.target.value) })} /></label></>}{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={closePin}>Cancel</button><button className={`button ${pinEdit.kind === 'change' ? 'primary' : 'danger-button'}`} aria-label={pinEdit.kind === 'change' ? 'Confirm change vault PIN' : 'Confirm disable vault PIN'} disabled={!!busy} onClick={() => void updatePin()}>{busy === 'pin' ? <LoaderCircle size={15} className="spin" /> : <LockKeyhole size={15} />}{pinEdit.kind === 'change' ? 'Change PIN' : 'Disable PIN'}</button></div></Modal>}
  </section>
}
