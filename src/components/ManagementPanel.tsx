import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, Check, Download, Folder, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Save, ShieldCheck, Trash2, Upload } from 'lucide-react'
import type { BackupPreview, GroupDefaults, HostProfile, LibraryItem, LibraryKind, LibraryState, Runbook, SavedKey, SshHeavenApi, UpdateState } from '../../shared/types'
import { setTheme } from '../theme'
import { Modal, errorMessage } from './Modal'
import { renderRunbook, runbookVariables } from './Runbooks'
import './management.css'
import { UpdateControls } from './UpdateControls'

type Tab = 'runbooks' | 'keys' | 'groups' | 'backup' | 'updates'
const blankLibrary: LibraryState = { runbooks: [], keys: [], groupDefaults: [], workspaces: [], tunnelRules: [] }
const preferences = ['ssh-heaven:theme', 'ssh-heaven:terminal-font-size', 'ssh-heaven-files-width']
const newRunbook = (): Runbook => ({ id: crypto.randomUUID(), name: '', command: '', description: '', group: '' })
const newKey = (): SavedKey => ({ id: crypto.randomUUID(), name: '', path: '' })
const newGroup = (): GroupDefaults => ({ id: crypto.randomUUID(), group: '', username: 'root', port: 22 })
function restorePreferences(values: Record<string, string>) {
  for (const [name, value] of Object.entries(values)) if (preferences.includes(name)) {
    try { localStorage.setItem(name, value) } catch { /* Keep the restored library usable if UI storage is unavailable. */ }
  }
  if (values['ssh-heaven:theme']) setTheme(values['ssh-heaven:theme'])
  const size = Number(values['ssh-heaven:terminal-font-size'])
  if (Number.isInteger(size) && size >= 10 && size <= 24) window.dispatchEvent(new CustomEvent('ssh-heaven:terminal-font-size-change', { detail: size }))
}

export function ManagementPanel({ api, profiles, onChanged, onClose, onRunCommand, onInstallUpdate, initialTab = 'runbooks' }: {
  api: SshHeavenApi
  profiles: HostProfile[]
  onChanged: () => Promise<void>
  onClose: () => void
  onRunCommand?: (group: string, command: string) => void
  onInstallUpdate: () => void
  initialTab?: Tab
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [library, setLibrary] = useState<LibraryState>(blankLibrary)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [runbook, setRunbook] = useState<Runbook>(newRunbook)
  const [key, setKey] = useState<SavedKey>(newKey)
  const [group, setGroup] = useState<GroupDefaults>(newGroup)
  const [selectedRunbook, setSelectedRunbook] = useState<Runbook | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [runGroup, setRunGroup] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{ kind: LibraryKind; id: string; name: string } | null>(null)
  const [backupPassword, setBackupPassword] = useState('')
  const [backupConfirmation, setBackupConfirmation] = useState('')
  const [includePasswords, setIncludePasswords] = useState(false)
  const [includeKeys, setIncludeKeys] = useState(false)
  const [restorePassword, setRestorePassword] = useState('')
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const groups = [...new Set([...profiles.map((profile) => profile.group), ...library.groupDefaults.map((item) => item.group)].filter((value): value is string => !!value))].sort()
  const close = useCallback(() => { if (!busyRef.current) onClose() }, [onClose])
  useEffect(() => {
    let mounted = true
    let receivedUpdate = false
    void api.getLibrary().then((value) => { if (mounted) setLibrary(value) }).catch((cause) => { if (mounted) setError(errorMessage(cause)) }).finally(() => { if (mounted) setLoading(false) })
    const stop = api.onUpdate((state) => { receivedUpdate = true; if (mounted) setUpdate(state) })
    void api.getUpdateState().then((state) => { if (mounted && !receivedUpdate) setUpdate(state) }).catch(() => {})
    return () => { mounted = false; stop() }
  }, [api])
  async function act(action: () => Promise<void>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true); setError(''); setNotice('')
    try { await action() } catch (cause) { setError(errorMessage(cause)) } finally { busyRef.current = false; setBusy(false) }
  }
  async function save(kind: LibraryKind, item: LibraryItem) {
    await act(async () => {
      if (kind === 'runbook') runbookVariables((item as Runbook).command)
      await api.saveLibraryItem(kind, item); setLibrary(await api.getLibrary()); await onChanged(); setNotice('Saved to your library.')
      if (kind === 'runbook') setRunbook(newRunbook())
      if (kind === 'key') setKey(newKey())
      if (kind === 'group') setGroup(newGroup())
    })
  }
  function useRunbook() {
    try {
      if (!selectedRunbook || !runGroup) throw new Error('Choose a host group before continuing.')
      const command = renderRunbook(selectedRunbook.command, values)
      setValues({}); onRunCommand?.(runGroup, command)
    } catch (cause) { setError(errorMessage(cause)) }
  }
  let variableNames: string[] = []
  try { if (selectedRunbook) variableNames = runbookVariables(selectedRunbook.command) } catch { /* Display validation on use. */ }

  return <>
    <Modal title="Workspace library" onClose={close} className="management-modal">
      <nav className="management-tabs" aria-label="Library sections">{(['runbooks', 'keys', 'groups', 'backup', 'updates'] as Tab[]).map((name) => <button key={name} className={tab === name ? 'active' : ''} aria-pressed={tab === name} onClick={() => { setTab(name); setError(''); setNotice('') }}>{name === 'runbooks' ? 'Runbooks' : name === 'keys' ? 'SSH keys' : name === 'groups' ? 'Group defaults' : name === 'backup' ? 'Backup & restore' : 'Updates'}</button>)}</nav>
      <div className="management-content">
        {error && <div className="form-error" role="alert">{error}</div>}{notice && <div className="management-notice" role="status"><Check size={15} />{notice}</div>}
        {loading ? <div className="management-empty"><LoaderCircle className="spin" size={24} />Loading your library…</div> : tab === 'runbooks' ? <>
          <div className="management-intro"><BookOpen size={23} /><div><h3>Repeat the useful work.</h3><p>Save commands once. Fill variables, then review the exact command and targets before running.</p></div></div>
          <div className="management-list">{library.runbooks.map((item) => <article className="management-item" key={item.id}><div><strong>{item.name}</strong><p>{item.description || item.command}</p><small>{item.group || 'Choose a group when running'}</small></div><button className="button secondary compact" disabled={!onRunCommand} onClick={() => { setSelectedRunbook(item); setValues({}); setRunGroup(item.group || groups[0] || '') }}>Use runbook</button><button className="icon-button" aria-label={`Edit runbook ${item.name}`} onClick={() => setRunbook({ ...item })}><Pencil size={14} /></button><button className="icon-button danger-hover" aria-label={`Delete runbook ${item.name}`} onClick={() => setDeleteTarget({ kind: 'runbook', id: item.id, name: item.name })}><Trash2 size={14} /></button></article>)}</div>
          {selectedRunbook && <section className="management-use-runbook"><h3>Use {selectedRunbook.name}</h3><label className="field-label">Target group<select aria-label="Runbook target group" value={runGroup} onChange={(event) => setRunGroup(event.target.value)}><option value="">Choose a group</option>{groups.map((name) => <option key={name}>{name}</option>)}</select></label>{variableNames.map((name) => <label className="field-label" key={name}>{name}<input aria-label={`Runbook variable ${name}`} value={values[name] ?? ''} maxLength={8192} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} /></label>)}<pre>{selectedRunbook.command}</pre><button className="button primary" onClick={useRunbook}>Continue to target review</button></section>}
          <form className="management-form" onSubmit={(event) => { event.preventDefault(); void save('runbook', runbook) }}><h3>{library.runbooks.some((item) => item.id === runbook.id) ? 'Edit runbook' : 'New runbook'}</h3><div className="form-row"><label className="field-label">Runbook name<input value={runbook.name} required maxLength={100} onChange={(event) => setRunbook({ ...runbook, name: event.target.value })} /></label><label className="field-label">Default group <span className="optional">optional</span><input list="management-groups" value={runbook.group ?? ''} onChange={(event) => setRunbook({ ...runbook, group: event.target.value })} /></label></div><label className="field-label">Description <span className="optional">optional</span><input value={runbook.description ?? ''} maxLength={2000} onChange={(event) => setRunbook({ ...runbook, description: event.target.value })} /></label><label className="field-label">Runbook command<textarea aria-label="Runbook command" value={runbook.command} required maxLength={32768} rows={4} placeholder="systemctl status {{service}}" onChange={(event) => setRunbook({ ...runbook, command: event.target.value })} /></label><p className="management-hint">Use unquoted {'{{variables}}'}. Values are quoted as shell arguments automatically. Heredoc substitutions are unsupported.</p><div className="management-form-actions"><button className="button subtle" type="button" onClick={() => setRunbook(newRunbook())}><Plus size={14} />New</button><button className="button primary" disabled={busy}><Save size={14} />Save runbook</button></div></form>
        </> : tab === 'keys' ? <>
          <div className="management-intro"><KeyRound size={23} /><div><h3>Your SSH key library.</h3><p>Give existing key files useful names. Private-key contents stay outside the interface.</p></div></div>
          <div className="management-list">{library.keys.map((item) => <article className="management-item" key={item.id}><KeyRound size={17} /><div><strong>{item.name}</strong><p title={item.path}>{item.path}</p>{item.available !== undefined && <small className={item.available ? 'management-key-available' : 'management-key-missing'}>{item.available ? 'Available' : 'Missing file · use Browse to relink'}</small>}</div><button className="icon-button" aria-label={`Edit key ${item.name}`} onClick={() => setKey({ ...item })}><Pencil size={14} /></button><button className="icon-button danger-hover" aria-label={`Remove key ${item.name}`} onClick={() => setDeleteTarget({ kind: 'key', id: item.id, name: item.name })}><Trash2 size={14} /></button></article>)}</div>
          <form className="management-form" onSubmit={(event) => { event.preventDefault(); void save('key', key) }}><h3>{library.keys.some((item) => item.id === key.id) ? 'Edit key' : 'Add a key'}</h3><label className="field-label">Key name<input value={key.name} required maxLength={100} onChange={(event) => setKey({ ...key, name: event.target.value })} /></label><div className="key-picker"><KeyRound size={15} /><span title={key.path}>{key.path || 'Choose a private key file'}</span><button type="button" className="button secondary compact" onClick={() => void api.pickPrivateKey().then((filename) => { if (filename) setKey({ ...key, path: filename }) }).catch((cause) => setError(errorMessage(cause)))}>Browse</button></div><p className="management-hint">Removing a key from this list keeps its file on disk.</p><div className="management-form-actions"><button type="button" className="button subtle" onClick={() => setKey(newKey())}>New</button><button className="button primary" disabled={busy || !key.path}>Save key</button></div></form>
        </> : tab === 'groups' ? <>
          <div className="management-intro"><Folder size={23} /><div><h3>A useful starting point for every group.</h3><p>Choose the username, SSH port, and named key used when preparing new connections.</p></div></div>
          <div className="management-list">{library.groupDefaults.map((item) => <article className="management-item" key={item.id}><Folder size={17} /><div><strong>{item.group}</strong><p>{item.username} · port {item.port}{item.keyId ? ` · ${library.keys.find((key) => key.id === item.keyId)?.name ?? 'Key unavailable'}` : ''}</p></div><button className="icon-button" aria-label={`Edit defaults for ${item.group}`} onClick={() => setGroup({ ...item })}><Pencil size={14} /></button><button className="icon-button danger-hover" aria-label={`Remove defaults for ${item.group}`} onClick={() => setDeleteTarget({ kind: 'group', id: item.id, name: item.group })}><Trash2 size={14} /></button></article>)}</div>
          <form className="management-form" onSubmit={(event) => { event.preventDefault(); void save('group', group) }}><h3>Group defaults</h3><label className="field-label">Group name<input list="management-groups" value={group.group} maxLength={100} required onChange={(event) => setGroup({ ...group, group: event.target.value })} /></label><div className="form-row"><label className="field-label">Default username<input value={group.username} required maxLength={256} onChange={(event) => setGroup({ ...group, username: event.target.value })} /></label><label className="field-label">Default SSH port<input type="number" value={group.port} required min={1} max={65535} onChange={(event) => setGroup({ ...group, port: Number(event.target.value) })} /></label></div><label className="field-label">Default SSH key<select aria-label="Default SSH key" value={group.keyId ?? ''} onChange={(event) => setGroup({ ...group, keyId: event.target.value || undefined })}><option value="">No key default</option>{library.keys.map((key) => <option key={key.id} value={key.id}>{key.name}</option>)}</select></label><div className="management-form-actions"><button className="button subtle" type="button" onClick={() => setGroup(newGroup())}>New</button><button className="button primary" disabled={busy}>Save group defaults</button></div></form>
        </> : tab === 'backup' ? <>
          <div className="management-intro"><ShieldCheck size={23} /><div><h3>Your workspace, safely portable.</h3><p>Encrypted backups include hosts, library items, workspaces, and appearance preferences.</p></div></div>
          <form className="management-form" onSubmit={(event) => { event.preventDefault(); void act(async () => {
            if (backupPassword !== backupConfirmation) throw new Error('Backup passphrases do not match.')
            const selected: Record<string, string> = {}
            for (const name of preferences) { const value = localStorage.getItem(name); if (value !== null) selected[name] = value }
            const result = await api.exportBackup({ password: backupPassword, includePasswords, includePrivateKeys: includeKeys, preferences: selected })
            if (!result.canceled) { setBackupPassword(''); setBackupConfirmation(''); setNotice(`Encrypted backup saved (${result.hosts} hosts, ${result.keys} private keys).`) }
          }) }}><h3>Create an encrypted backup</h3><div className="form-row"><label className="field-label">Backup passphrase<input type="password" minLength={12} required autoComplete="new-password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} /></label><label className="field-label">Confirm backup passphrase<input type="password" minLength={12} required autoComplete="new-password" value={backupConfirmation} onChange={(event) => setBackupConfirmation(event.target.value)} /></label></div><label className="checkbox-label"><input type="checkbox" checked={includePasswords} onChange={(event) => setIncludePasswords(event.target.checked)} />Include remembered server passwords</label><label className="checkbox-label"><input type="checkbox" checked={includeKeys} onChange={(event) => setIncludeKeys(event.target.checked)} />Include private key files</label><p className="management-hint">Use at least 12 characters. This passphrase is required to restore the backup and is never saved.</p><button className="button primary" disabled={busy}><Upload size={14} />Choose location & export</button></form>
          <section className="management-form"><h3>Restore and merge a backup</h3>{preview ? <><div className="management-restore-summary"><strong>{preview.filename}</strong><p>{preview.newHosts} new hosts · {preview.skippedHosts} existing hosts skipped</p><p>{preview.keys} private keys · {preview.passwords} passwords · {preview.runbooks} runbooks · {preview.workspaces} workspaces</p></div><p className="management-hint">Existing hosts and credentials are preserved. Restored private keys receive new managed paths.</p><div className="management-form-actions"><button className="button secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel restore</button><button className="button primary" disabled={busy} onClick={() => void act(async () => { const result = await api.restoreBackup(preview.token); restorePreferences(result.preferences); setPreview(null); setLibrary(await api.getLibrary()); await onChanged(); setNotice(`Restored ${result.hosts} hosts and ${result.keys} keys. ${result.skippedHosts} existing hosts skipped. Reopen file panels to apply saved widths.`) })}><Download size={14} />Merge backup</button></div></> : <form onSubmit={(event) => { event.preventDefault(); void act(async () => { const result = await api.previewBackup(restorePassword); if (result) { setPreview(result); setRestorePassword('') } }) }}><label className="field-label">Restore passphrase<input type="password" minLength={12} required autoComplete="off" value={restorePassword} onChange={(event) => setRestorePassword(event.target.value)} /></label><button className="button secondary" disabled={busy}><Download size={14} />Choose backup & preview</button></form>}</section>
        </> : <>
          <div className="management-intro"><RefreshCw size={23} /><div><h3>Stay up to date.</h3><p>Download an update here, then install when you are ready.</p></div></div><section className="management-form"><h3>SSH Heaven {update?.currentVersion ?? ''}</h3><p className="management-update-message" role="status">{update?.message || (update?.status === 'available' ? `Version ${update.version} is available.` : update?.status === 'not-available' ? 'You have the latest release.' : update?.status === 'checking' ? 'Checking for updates…' : 'Updates have not been checked.')}</p><div className="management-update-actions">{update?.status === 'unconfigured' ? <p className="management-hint">Release hosting has not been configured for this build.</p> : <button className="button secondary compact" disabled={busy || ['checking', 'downloading', 'installing'].includes(update?.status || '')} onClick={() => void act(async () => { setUpdate(await api.checkForUpdates()) })}><RefreshCw size={14} />Check for updates</button>}{update && <UpdateControls api={api} state={update} onInstall={onInstallUpdate} onError={(cause) => setError(errorMessage(cause))} />}</div><p className="update-install-note">Downloads begin only when you choose Download update. Install now closes SSH Heaven and starts the verified installer.</p></section>
        </>}
        <datalist id="management-groups">{groups.map((name) => <option key={name}>{name}</option>)}</datalist>
      </div>
      {busy && <div className="management-busy" role="status"><LoaderCircle className="spin" size={15} />Working…</div>}
    </Modal>
    {deleteTarget && <Modal title="Remove library item?" onClose={() => { if (!busy) setDeleteTarget(null) }} className="small-modal"><p className="modal-description">Remove <strong>{deleteTarget.name}</strong> from the library?{deleteTarget.kind === 'key' ? ' The key file stays on disk.' : ''}</p><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setDeleteTarget(null)}>Keep item</button><button className="button danger-button" disabled={busy} onClick={() => void act(async () => { setLibrary(await api.deleteLibraryItem(deleteTarget.kind, deleteTarget.id)); setDeleteTarget(null); await onChanged() })}>Remove item</button></div></Modal>}
  </>
}
