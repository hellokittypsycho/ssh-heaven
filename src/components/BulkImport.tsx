import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, CheckCheck, FileKey2, KeyRound, ListPlus, LoaderCircle, LockKeyhole, ShieldCheck } from 'lucide-react'
import type { AuthType, BulkImportRequest, BulkImportResult, HostProfile, ImportPreview, LibraryState, SshHeavenApi } from '../../shared/types'
import { parseBulkHosts } from '../../shared/import'
import { Modal, errorMessage } from './Modal'
import './bulk-import.css'

export function BulkImport({ api, profiles, groups, library, onImported, onClose }: {
  api: SshHeavenApi
  profiles: HostProfile[]
  groups: string[]
  library?: LibraryState
  onImported: () => Promise<void>
  onClose: () => void
}) {
  const [text, setText] = useState('')
  const [group, setGroup] = useState('')
  const [port, setPort] = useState(22)
  const [authType, setAuthType] = useState<AuthType>('password')
  const [privateKeyPath, setPrivateKeyPath] = useState('')
  const [preview, setPreview] = useState<{ request: BulkImportRequest; parsed: ImportPreview } | null>(null)
  const [result, setResult] = useState<BulkImportResult | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const committing = useRef(false)
  useEffect(() => {
    let mounted = true
    void api.getCredentialStatus().then((status) => { if (mounted) setAvailable(status.available) }).catch((cause) => { if (mounted) { setAvailable(false); setError(errorMessage(cause)) } })
    return () => { mounted = false }
  }, [api])
  const close = useCallback(() => {
    if (busy || committing.current) return
    setText(''); setPreview(null); onClose()
  }, [busy, onClose])
  const isExisting = (host: string, username: string) => profiles.some((profile) => profile.host.toLowerCase() === host.toLowerCase() && profile.username === username && profile.port === (preview?.request.port ?? port))
  const existing = preview?.parsed.entries.filter((entry) => isExisting(entry.host, entry.username)).length ?? 0
  const ready = (preview?.parsed.entries.length ?? 0) - existing
  const skipped = (preview?.parsed.duplicates ?? 0) + existing
  const defaults = library?.groupDefaults.find((item) => item.group === group.trim())
  function applyDefaults() {
    if (!defaults) return
    const key = defaults.keyId ? library?.keys.find((item) => item.id === defaults.keyId) : undefined
    if (defaults.keyId && (!key || key.available === false)) { setError('The default SSH key is missing. Relink it in the key library before applying these defaults.'); return }
    setPort(defaults.port)
    if (key) { setAuthType('privateKey'); setPrivateKeyPath(key.path) }
    setError('')
  }
  function review(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    if (authType === 'privateKey' && !privateKeyPath) { setError('Choose the private key to use for these hosts.'); return }
    try {
      const request: BulkImportRequest = { text, port, authType, ...(group.trim() ? { group: group.trim() } : {}), ...(authType === 'privateKey' ? { privateKeyPath } : {}) }
      setPreview({ request, parsed: parseBulkHosts(request) })
    } catch (cause) { setError(errorMessage(cause)) }
  }
  async function importHosts() {
    if (!preview || busy || committing.current || ready < 1 || preview.parsed.errors.length) return
    committing.current = true
    setBusy(true); setError('')
    try {
      const imported = await api.importHosts(preview.request)
      // Raw lines and parsed passwords are discarded as soon as the import commits.
      setText(''); setPreview(null); setResult(imported)
      await onImported()
    } catch (cause) { setError(errorMessage(cause)) }
    finally { committing.current = false; setBusy(false) }
  }
  return <Modal title="Bulk import hosts" onClose={close} className="bulk-import-modal">
    {result ? <><div className="bulk-import-success"><CheckCheck size={28} /><div><h3>{result.imported} {result.imported === 1 ? 'host imported' : 'hosts imported'}</h3><p>{result.skipped ? `${result.skipped} duplicate ${result.skipped === 1 ? 'entry was' : 'entries were'} skipped. ` : ''}{group.trim() ? `Added to ${group.trim()}.` : 'Your hosts are ready in the host library.'}</p></div></div>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button primary" disabled={busy} onClick={close}><Check size={15} />Done</button></div></> : preview ? <>
      <p className="bulk-import-intro">Review the hosts below. Existing hosts and repeated entries will be skipped.</p>
      <div className="bulk-preview-summary"><span className="success">{ready} ready to import</span>{skipped > 0 && <span className="warning">{skipped} {skipped === 1 ? 'duplicate' : 'duplicates'} skipped</span>}{preview.parsed.errors.length > 0 && <span className="error">{preview.parsed.errors.length} invalid {preview.parsed.errors.length === 1 ? 'line' : 'lines'}</span>}<span>{preview.request.group || 'Ungrouped'} · port {preview.request.port}</span></div>
      <div className="bulk-preview-list" aria-label="Import preview">{[...preview.parsed.entries.map((entry) => ({ line: entry.line, entry, message: '' })), ...preview.parsed.errors.map((entry) => ({ line: entry.line, entry: null, message: entry.message }))].sort((a, b) => a.line - b.line).map((row) => <div className={`bulk-preview-row ${!row.entry ? 'error' : isExisting(row.entry.host, row.entry.username) ? 'skipped' : ''}`} key={row.line}><small>#{row.line}</small><div><strong>{row.entry ? `${row.entry.username}@${row.entry.host}` : `Line ${row.line}: ${row.message}`}</strong>{row.entry && <p>{preview.request.authType === 'password' ? 'Password supplied · hidden from preview' : 'Shared SSH key'}</p>}</div><span className="preview-badge">{!row.entry ? 'Fix line' : isExisting(row.entry.host, row.entry.username) ? 'Existing' : 'Import'}</span></div>)}</div>
      <p className="bulk-import-review-note">{preview.parsed.errors.length ? 'Go back and fix the invalid lines before importing.' : preview.parsed.totalLines === 0 ? 'No hosts were found. Go back and add at least one host line.' : preview.request.authType === 'password' ? 'Passwords will be saved in encrypted storage on this device.' : 'All imported hosts will use the selected private key. Passwords in the list are ignored.'}</p>
      {preview.request.authType === 'password' && available === false && <div className="form-error" role="alert">Encrypted storage is unavailable. Password lists cannot be imported on this device.</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setPreview(null)}><ArrowLeft size={15} />Back to edit</button><button className="button primary" disabled={busy || !ready || !!preview.parsed.errors.length || (preview.request.authType === 'password' && available !== true)} onClick={() => void importHosts()}>{busy ? <LoaderCircle size={15} className="spin" /> : <ListPlus size={16} />}{busy ? 'Importing…' : `Import ${ready} ${ready === 1 ? 'host' : 'hosts'}`}</button></div>
    </> : <form onSubmit={review}>
      <p className="bulk-import-intro">Add up to 200 hosts at once. Use one host per line, with an optional username.</p>
      <div className="bulk-import-modes"><button type="button" className={authType === 'password' ? 'active' : ''} aria-pressed={authType === 'password'} onClick={() => setAuthType('password')}><LockKeyhole size={15} />Passwords from list</button><button type="button" className={authType === 'privateKey' ? 'active' : ''} aria-pressed={authType === 'privateKey'} onClick={() => setAuthType('privateKey')}><KeyRound size={15} />One SSH key for all</button></div>
      <div className="bulk-import-options"><label className="field-label">Port<input type="number" min={1} max={65535} value={port} onChange={(event) => setPort(Number(event.target.value))} required /></label><label className="field-label">Group <span className="optional">optional</span><input list="bulk-import-groups" value={group} onChange={(event) => setGroup(event.target.value)} maxLength={100} placeholder="e.g. Production" /><datalist id="bulk-import-groups">{groups.map((item) => <option value={item} key={item} />)}</datalist></label></div>
      {defaults && <div className="bulk-group-defaults"><span>Group defaults: port {defaults.port}{defaults.keyId ? ' · SSH key' : ''}. Usernames follow the import lines.</span><button type="button" className="button secondary compact" onClick={applyDefaults}>Apply group defaults</button></div>}
      {authType === 'privateKey' && <div className="bulk-import-key"><div className="key-picker"><FileKey2 size={15} /><span title={privateKeyPath}>{privateKeyPath || 'No private key selected'}</span><button type="button" className="button secondary compact" onClick={() => void api.pickPrivateKey().then((path) => { if (path) setPrivateKeyPath(path) }).catch((cause) => setError(errorMessage(cause)))}>Browse</button></div><p>Bare hostnames use root. Passwords in the list are ignored; key passphrases are entered when connecting.</p></div>}
      <label className="bulk-import-source"><span>Hosts to import<small>Up to 200 hosts</small></span><textarea aria-label="Hosts to import" value={text} onChange={(event) => setText(event.target.value)} placeholder={authType === 'password' ? 'host:username:password\nhost:password' : 'host\nhost:username\nhost:username:password'} required maxLength={1024 * 1024} spellCheck={false} autoComplete="off" /></label>
      <div className="bulk-import-security"><ShieldCheck size={15} /><span>{authType === 'password' ? 'For host:password, the username defaults to root. Imported passwords use encrypted storage.' : 'One selected SSH key will be used for every imported host.'}</span></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={!text.trim()}><ListPlus size={16} />Preview import</button></div>
    </form>}
  </Modal>
}
