import { useState } from 'react'
import { FolderOpen, Layers, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import type { HostProfile, LibraryState, SavedWorkspace, SshHeavenApi, WorkspaceLayout } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import './workspaces.css'

export function WorkspaceManager({ api, profiles, library, currentProfileIds, layout, onChanged, onRestore, onClose }: {
  api: SshHeavenApi; profiles: HostProfile[]; library: LibraryState; currentProfileIds: string[]; layout: WorkspaceLayout
  onChanged: () => Promise<void>; onRestore: (workspace: SavedWorkspace) => void; onClose: () => void
}) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>([...new Set(currentProfileIds.filter((id) => profiles.some((profile) => profile.id === id)))])
  const [savedLayout, setSavedLayout] = useState(layout)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (busy || !name.trim() || !selected.length) return
    setBusy(true); setError('')
    try { await api.saveLibraryItem('workspace', { id: crypto.randomUUID(), name: name.trim(), profileIds: selected, layout: savedLayout }); await onChanged(); setNotice(`${name.trim()} saved.`); setName('') }
    catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function remove(id: string) {
    setBusy(true); setError('')
    try { await api.deleteLibraryItem('workspace', id); await onChanged(); setDeleting(null) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <Modal title="Workspaces" onClose={() => { if (!busy) onClose() }} className="workspace-manager">
    <p className="workspace-note">Save named host selections and a terminal layout. Restoring a workspace opens its layout; connections start only when you choose Connect.</p>
    <div className="workspace-manager-grid"><form onSubmit={(event) => void save(event)}><h3>Save a workspace</h3><label className="field-label">Workspace name<input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required placeholder="e.g. Production monitoring" /></label><label className="field-label">Terminal layout<select aria-label="Workspace layout" value={savedLayout} onChange={(event) => setSavedLayout(event.target.value as WorkspaceLayout)}><option value="tabs">Tabs</option><option value="split">Split · 2 panes</option><option value="grid">Grid · up to 4 panes</option></select></label><div className="workspace-host-picker" aria-label="Workspace hosts">{profiles.map((profile) => <label key={profile.id}><input type="checkbox" checked={selected.includes(profile.id)} disabled={selected.length >= 20 && !selected.includes(profile.id)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, profile.id] : current.filter((id) => id !== profile.id))} /><span><strong>{profile.name}</strong><small>{profile.username}@{profile.host}</small></span></label>)}{!profiles.length && <p>Save a host before creating a workspace.</p>}</div><p className="workspace-note">{selected.length} of 20 hosts selected. Passwords and terminal contents are not stored in workspaces.</p><button className="button primary" disabled={busy || !name.trim() || !selected.length}>{busy ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}Save workspace</button></form><section className="workspace-saved-list" aria-label="Saved workspaces"><h3>Saved workspaces</h3>{library.workspaces.map((workspace) => <article key={workspace.id}><div><Layers size={17} /><strong>{workspace.name}</strong><button className="icon-button danger-hover" disabled={busy} aria-label={`Delete workspace ${workspace.name}`} onClick={() => setDeleting(workspace.id)}><Trash2 size={14} /></button></div><p>{workspace.profileIds.length} hosts · {workspace.layout}</p>{deleting === workspace.id ? <div className="workspace-delete-confirm"><span>Delete this workspace?</span><button className="button secondary compact" onClick={() => setDeleting(null)}>Keep</button><button className="button danger-button compact" disabled={busy} onClick={() => void remove(workspace.id)}>Delete</button></div> : <button className="button secondary compact" aria-label={`Restore workspace ${workspace.name}`} disabled={busy} onClick={() => { onRestore(workspace); onClose() }}><FolderOpen size={14} />Restore layout</button>}</article>)}{!library.workspaces.length && <div className="workspace-empty"><Layers size={26} /><p>No saved workspaces yet.</p></div>}</section></div>
    {notice && <div className="workspace-notice" role="status">{notice}</div>}{error && <div className="form-error" role="alert">{error}</div>}
  </Modal>
}
