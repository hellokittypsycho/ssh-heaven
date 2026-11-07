import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { ArrowDown, ArrowDownToLine, ArrowLeft, ArrowUp, ArrowUpFromLine, CheckCheck, ChevronRight, Copy, Eye, EyeOff, File, FilePenLine, Folder, FolderPlus, Home, Link, LoaderCircle, Pencil, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { RemoteEntry, SshHeavenApi } from '../../shared/types'
import { useTransfers } from '../transfer-store'
import { Modal, errorMessage } from './Modal'
import { formatBytes, TransferPanel } from './TransferPanel'
import './file-browser.css'

const join = (directory: string, name: string) => `${directory === '/' ? '' : directory.replace(/\/$/, '')}/${name}`
const parent = (path: string) => path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
type Sort = { key: 'name' | 'size' | 'modified'; descending: boolean }
function initialWidth() {
  try { return Math.min(740, Math.max(320, Number(localStorage.getItem('ssh-heaven-files-width')) || 440)) } catch { return 440 }
}

export function FileBrowser({ sessionId, connected, api, onClose, onEdit, refreshToken }: { sessionId: string; connected: boolean; api: SshHeavenApi; onClose: () => void; onEdit?: (path: string) => void; refreshToken?: number }) {
  const [path, setPath] = useState('.')
  const [pathInput, setPathInput] = useState('.')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [operation, setOperation] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [dropping, setDropping] = useState(false)
  const [action, setAction] = useState<'mkdir' | 'rename' | 'remove' | null>(null)
  const [name, setName] = useState('')
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [sort, setSort] = useState<Sort>({ key: 'name', descending: false })
  const [width, setWidth] = useState(initialWidth)
  const [navigation, setNavigation] = useState<{ paths: string[]; index: number }>({ paths: [], index: -1 })
  const currentPath = useRef('.')
  const request = useRef(0)
  const mounted = useRef(true)
  const resize = useRef<{ x: number; width: number } | null>(null)
  const jobs = useTransfers(sessionId)
  const busy = loading || !!operation
  const visible = useMemo(() => entries.filter((entry) => (showHidden || !entry.name.startsWith('.')) && entry.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => {
    const directoryOrder = Number(b.type === 'directory') - Number(a.type === 'directory')
    const comparison = sort.key === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a[sort.key] - b[sort.key]
    return directoryOrder || (sort.descending ? -comparison : comparison) || a.name.localeCompare(b.name)
  }), [entries, showHidden, filter, sort])
  const selection = entries.filter((entry) => selected.has(entry.path))
  const single = selection.length === 1 ? selection[0] : null
  const downloadable = selection.length > 0 && selection.every((entry) => entry.type === 'file' || entry.type === 'directory')
  const removable = selection.length > 0 && selection.every((entry) => entry.type === 'file' || entry.type === 'directory')
  const allSelected = visible.length > 0 && visible.every((entry) => selected.has(entry.path))

  const load = useCallback(async (directory: string, navigate = true) => {
    const id = ++request.current
    setLoading(true); setError('')
    try {
      const result = await api.listDirectory(sessionId, directory)
      if (!mounted.current || id !== request.current) return
      const changed = currentPath.current !== result.path
      currentPath.current = result.path
      setPath(result.path); setPathInput(result.path); setEntries(result.entries)
      setSelected((current) => changed ? new Set() : new Set([...current].filter((item) => result.entries.some((entry) => entry.path === item))))
      if (changed) setFilter('')
      if (navigate) setNavigation((current) => current.paths[current.index] === result.path ? current : { paths: [...current.paths.slice(0, current.index + 1), result.path], index: current.index + 1 })
      return true
    } catch (cause) { if (mounted.current && id === request.current) setError(errorMessage(cause)); return false }
    finally { if (mounted.current && id === request.current) setLoading(false) }
  }, [api, sessionId])
  useEffect(() => {
    mounted.current = true
    if (connected) void load('.')
    return () => { mounted.current = false; request.current++ }
  }, [connected, load])
  useEffect(() => { try { localStorage.setItem('ssh-heaven-files-width', String(width)) } catch { /* UI preferences are optional. */ } }, [width])
  useEffect(() => { if (connected && refreshToken) void load(currentPath.current, false) }, [refreshToken, connected, load])
  function toggle(entry: RemoteEntry) {
    setSelected((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next })
  }
  function select(entry: RemoteEntry, additive: boolean) { if (additive) toggle(entry); else setSelected(new Set([entry.path])) }
  function openEntry(entry: RemoteEntry) {
    if (busy) return
    if (entry.type === 'directory' || entry.type === 'symlink') void load(entry.path)
    else if (entry.type === 'file') onEdit?.(entry.path)
  }
  function setSortKey(key: Sort['key']) { setSort((current) => ({ key, descending: current.key === key ? !current.descending : false })) }
  async function transfer(kind: 'upload' | 'upload-folder' | 'download', files?: File[]) {
    if (!connected || (kind === 'download' && !downloadable)) return
    setError(''); setNotice('')
    try {
      const result = files ? await api.uploadDropped(sessionId, path, files) : kind === 'upload-folder' ? await api.uploadFolder(sessionId, path) : kind === 'upload' ? await api.upload(sessionId, path) : await api.downloadFiles(sessionId, selection.map((entry) => entry.path))
      if (!mounted.current) return
      if (!result.canceled) {
        const folder = kind === 'upload-folder' || (kind === 'download' && selection.some((entry) => entry.type === 'directory'))
        const noun = folder ? (result.files.length === 1 ? 'item' : 'items') : (result.files.length === 1 ? 'file' : 'files')
        setNotice(`${result.files.length} ${noun} ${kind === 'download' ? 'downloaded' : 'uploaded'}.`)
        if (kind !== 'download') await load(currentPath.current, false)
      }
    } catch (cause) { if (mounted.current) setError(errorMessage(cause)) }
  }
  async function performAction(event: React.FormEvent) {
    event.preventDefault()
    if (operation) return
    const normalizedName = name.trim()
    if (action !== 'remove' && (!normalizedName || /[\/\\\u0000]/.test(normalizedName) || normalizedName === '.' || normalizedName === '..')) { setError('Enter a name without slashes or parent-directory references.'); return }
    setOperation(action === 'mkdir' ? 'Creating folder…' : action === 'rename' ? 'Renaming…' : 'Deleting…'); setError('')
    try {
      if (action === 'mkdir') await api.mkdir(sessionId, join(path, normalizedName))
      if (action === 'rename' && single) await api.rename(sessionId, single.path, join(path, normalizedName))
      if (action === 'remove') {
        let removed = 0
        try {
          for (const entry of selection) if (entry.type === 'file' || entry.type === 'directory') { await api.remove(sessionId, entry.path, entry.type); removed++ }
        } catch (cause) { setAction(null); await load(currentPath.current, false); throw new Error(`${removed ? `${removed} items deleted. ` : ''}${errorMessage(cause)}`) }
      }
      setAction(null); await load(currentPath.current, false)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setOperation('') }
  }
  const closeAction = useCallback(() => { if (!operation) setAction(null) }, [operation])
  const breadcrumbs = path === '.' ? [] : path.split('/').filter(Boolean)
  function resizeMove(event: PointerEvent<HTMLDivElement>) {
    if (resize.current) setWidth(Math.min(740, Math.max(320, resize.current.width + resize.current.x - event.clientX)))
  }
  return <aside className={`file-browser sftp-browser ${dropping ? 'drop-active' : ''}`} aria-label="Remote files" style={{ width }}
    onDragOver={(event) => { if (connected && event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true) } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false) }}
    onDrop={(event) => { event.preventDefault(); setDropping(false); if (connected && event.dataTransfer.files.length) void transfer('upload', [...event.dataTransfer.files]) }}>
    <div className="sftp-resizer" role="separator" aria-label="Resize file browser" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={740} aria-valuenow={width} tabIndex={0}
      onPointerDown={(event) => { resize.current = { x: event.clientX, width: event.currentTarget.parentElement!.getBoundingClientRect().width }; event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={resizeMove} onPointerUp={() => { resize.current = null }} onPointerCancel={() => { resize.current = null }}
      onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setWidth((value) => Math.max(320, Math.min(740, value + (event.key === 'ArrowLeft' ? 20 : -20)))) } }} />
    <div className="panel-heading"><div><Folder size={17} /><h2>Remote files</h2><span className="protocol-pill">SFTP</span></div><button className="icon-button" onClick={onClose} aria-label="Hide remote files" title="Hide file browser"><X size={17} /></button></div>
    <div className="sftp-nav-toolbar">
      <button className="icon-button" disabled={busy || !connected || navigation.index < 1} onClick={() => { const index = navigation.index - 1; void load(navigation.paths[index], false).then((success) => { if (success) setNavigation((current) => ({ ...current, index })) }) }} title="Previous folder" aria-label="Previous folder"><ArrowLeft size={16} /></button>
      <button className="icon-button" disabled={busy || !connected || path === '/'} onClick={() => void load(parent(path))} title="Parent folder" aria-label="Parent folder"><ArrowUp size={16} /></button>
      <button className="icon-button" disabled={busy || !connected} onClick={() => void load('.')} title="Home folder" aria-label="Remote home folder"><Home size={15} /></button>
      <form className="path-form" onSubmit={(event) => { event.preventDefault(); if (!busy && connected) void load(pathInput) }}><input aria-label="Remote path" value={pathInput} disabled={!connected} onChange={(event) => setPathInput(event.target.value)} spellCheck={false} /><button type="submit" className="icon-button" disabled={busy || !connected} aria-label="Go to remote path"><ChevronRight size={15} /></button></form>
      <button className="icon-button" disabled={busy || !connected} onClick={() => void load(path, false)} title="Refresh" aria-label="Refresh remote files"><RefreshCw size={16} className={loading ? 'spin' : ''} /></button>
    </div>
    <nav className="sftp-breadcrumbs" aria-label="Remote breadcrumbs"><button disabled={busy || !connected} onClick={() => void load('/')}>/</button>{breadcrumbs.map((part, index) => <span key={index}><ChevronRight size={11} /><button disabled={busy || !connected} title={`/${breadcrumbs.slice(0, index + 1).join('/')}`} onClick={() => void load(`/${breadcrumbs.slice(0, index + 1).join('/')}`)}>{part}</button></span>)}</nav>
    <div className="file-toolbar sftp-actions">
      <button className="sftp-action-button" disabled={!!operation || !connected} onClick={() => void transfer('upload')} title="Upload files" aria-label="Upload files"><ArrowUpFromLine size={15} /><span>Upload</span></button>
      <button className="icon-button" disabled={!!operation || !connected} onClick={() => void transfer('upload-folder')} title="Upload folder" aria-label="Upload folder"><FolderPlus size={15} /></button>
      <button className="sftp-action-button" disabled={!!operation || !connected || !downloadable} onClick={() => void transfer('download')} title="Download selected files" aria-label="Download selected file"><ArrowDownToLine size={15} /><span>Download{selection.length > 1 ? ` (${selection.length})` : ''}</span></button>
      <span className="toolbar-spacer" />
      <button className="icon-button" disabled={busy || !connected || single?.type !== 'file' || !onEdit} onClick={() => single && onEdit?.(single.path)} title="Edit file" aria-label="Edit selected file"><FilePenLine size={15} /></button>
      <button className="icon-button" disabled={busy || !connected} onClick={() => { setName(''); setError(''); setAction('mkdir') }} title="New folder" aria-label="New remote folder"><FolderPlus size={16} /></button>
      <button className="icon-button" disabled={busy || !connected || !single} onClick={() => { setName(single!.name); setError(''); setAction('rename') }} title="Rename (F2)" aria-label="Rename selected item"><Pencil size={15} /></button>
      <button className="icon-button danger-hover" disabled={busy || !connected || !removable} onClick={() => { setError(''); setAction('remove') }} title="Delete selected items" aria-label="Delete selected item"><Trash2 size={15} /></button>
    </div>
    <div className="sftp-filter-row"><label><Search size={14} /><input aria-label="Filter remote files" placeholder="Filter files…" value={filter} onChange={(event) => { setFilter(event.target.value); setSelected(new Set()) }} /></label><button className={`icon-button ${showHidden ? 'active' : ''}`} aria-label="Show hidden files" aria-pressed={showHidden} title={showHidden ? 'Hide hidden files' : 'Show hidden files'} onClick={() => { setShowHidden((current) => !current); setSelected(new Set()) }}>{showHidden ? <Eye size={16} /> : <EyeOff size={16} />}</button></div>
    {error && <div className="file-message error-message" role="alert">{error}<button className="icon-button" aria-label="Dismiss file error" onClick={() => setError('')}><X size={13} /></button></div>}
    {notice && <div className="file-message success-message" role="status"><CheckCheck size={14} />{notice}<button className="icon-button" onClick={() => setNotice('')} aria-label="Dismiss transfer message"><X size={13} /></button></div>}
    <div className="sftp-list-columns"><input type="checkbox" aria-label="Select all visible items" disabled={!connected || !visible.length || busy} checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map((entry) => entry.path)))} /><span /><button aria-label="Sort files by name" onClick={() => setSortKey('name')}>Name{sort.key === 'name' && (sort.descending ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</button><button aria-label="Sort files by size" onClick={() => setSortKey('size')}>Size{sort.key === 'size' && (sort.descending ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</button><button className="sftp-modified" aria-label="Sort files by date" onClick={() => setSortKey('modified')}>Modified{sort.key === 'modified' && (sort.descending ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}</button></div>
    <div className={`file-list ${loading ? 'is-loading' : ''}`} aria-busy={loading || !!operation} role="listbox" aria-label="Directory contents" aria-multiselectable="true" onKeyDown={(event) => {
      if (event.key === 'Delete' && removable && !busy) { event.preventDefault(); setAction('remove'); setError('') }
      if (event.key === 'F2' && single && !busy) { event.preventDefault(); setName(single.name); setAction('rename'); setError('') }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(new Set(visible.map((entry) => entry.path))) }
    }}>
      {!connected ? <div className="file-empty"><Folder size={30} /><p>Connect to browse files</p><span>Your remote filesystem appears here.</span></div> : !loading && !visible.length ? <div className="file-empty"><Folder size={30} /><p>{filter ? 'No matching files' : 'This folder is empty'}</p><span>{filter ? 'Try another name or show hidden files.' : 'Upload files or create a folder.'}</span></div> : visible.map((entry) => <div
        role="option" aria-selected={selected.has(entry.path)} tabIndex={0} key={entry.path} className={`file-entry sftp-entry ${selected.has(entry.path) ? 'selected' : ''}`}
        onClick={(event) => { if (!operation) select(entry, event.ctrlKey || event.metaKey || event.shiftKey) }} onDoubleClick={(event) => { if (!(event.target instanceof HTMLInputElement)) openEntry(entry) }}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); openEntry(entry) } else if (event.key === ' ') { event.preventDefault(); toggle(entry) } }}
        title={`${entry.name}\n${entry.permissions}${entry.modified ? `\nModified ${new Date(entry.modified * 1000).toLocaleString()}` : ''}`}>
        <input type="checkbox" aria-label={`Select ${entry.name}`} checked={selected.has(entry.path)} disabled={!!operation} onClick={(event) => event.stopPropagation()} onChange={() => toggle(entry)} />
        {entry.type === 'directory' ? <Folder className="folder-icon" size={16} /> : entry.type === 'symlink' ? <Link size={15} /> : <File size={15} />}<span className="sftp-entry-name">{entry.name}</span><small>{entry.type === 'directory' ? '—' : formatBytes(entry.size)}</small><small className="sftp-modified">{entry.modified ? new Date(entry.modified * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '—'}</small>
      </div>)}
    </div>
    <div className="sftp-selection-bar"><span>{selection.length ? `${selection.length} selected · ${formatBytes(selection.reduce((sum, entry) => sum + (entry.type === 'file' ? entry.size : 0), 0))}` : `${visible.length} of ${entries.length} items`}</span><button className="icon-button" disabled={!connected} title={single ? 'Copy selected path' : 'Copy folder path'} aria-label="Copy remote path" onClick={() => void api.writeClipboard(single?.path ?? path).then(() => setNotice('Remote path copied.')).catch((cause) => setError(errorMessage(cause)))}><Copy size={13} /></button></div>
    <TransferPanel sessionId={sessionId} jobs={jobs} api={api} onError={setError} onRetryComplete={() => { if (connected) void load(currentPath.current, false) }} />
    {dropping && <div className="sftp-drop-overlay"><ArrowUpFromLine size={30} /><strong>Drop files or folders to upload</strong><span>To {path}</span></div>}
    {operation && <div className="file-footer"><LoaderCircle size={12} className="spin" />{operation}</div>}
    {action && <Modal title={action === 'mkdir' ? 'Create a folder' : action === 'rename' ? 'Rename item' : selection.length > 1 ? `Delete ${selection.length} items?` : 'Delete item?'} onClose={closeAction} className="small-modal"><form onSubmit={(event) => void performAction(event)}>
      {action === 'remove' ? <p className="modal-description">Delete <strong>{single?.name ?? `${selection.length} selected items`}</strong>? Files cannot be recovered. Only empty folders can be deleted.</p> : <label className="field-label">{action === 'mkdir' ? 'Folder name' : 'New name'}<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={255} autoFocus /></label>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={!!operation} onClick={closeAction}>Cancel</button><button type="submit" className={`button ${action === 'remove' ? 'danger-button' : 'primary'}`} disabled={!!operation || (action !== 'remove' && !name.trim())}>{operation ? <LoaderCircle size={15} className="spin" /> : null}{action === 'remove' ? 'Delete' : action === 'mkdir' ? 'Create folder' : 'Rename'}</button></div>
    </form></Modal>}
  </aside>
}
