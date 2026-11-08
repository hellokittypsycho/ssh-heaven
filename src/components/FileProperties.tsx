import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCog, LoaderCircle, RefreshCw, Save } from 'lucide-react'
import type { RemoteProperties, SshHeavenApi } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import { formatBytes } from './TransferPanel'
import './file-properties.css'

const octalMode = (mode: number) => (mode & 0o777).toString(8).padStart(3, '0')
const validMode = (value: string) => /^0?[0-7]{3}$/.test(value)
const timestamp = (seconds: number) => seconds ? new Date(seconds * 1000).toLocaleString() : 'Not reported'
const CLASSES = [{ name: 'Owner', shift: 6 }, { name: 'Group', shift: 3 }, { name: 'Others', shift: 0 }]
const BITS = [{ name: 'Read', value: 4 }, { name: 'Write', value: 2 }, { name: 'Execute', value: 1 }]

export function FileProperties({ sessionId, path, api, onClose, onChanged }: { sessionId: string; path: string; api: SshHeavenApi; onClose: () => void; onChanged: () => void }) {
  const [properties, setProperties] = useState<RemoteProperties | null>(null)
  const [mode, setMode] = useState('')
  const [busy, setBusy] = useState('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const operation = useRef(false)
  const generation = useRef(0)
  const mounted = useRef(true)
  const load = useCallback(async () => {
    if (operation.current) return
    operation.current = true; setBusy('loading'); setError(''); setNotice('')
    const request = ++generation.current
    try {
      const result = await api.getRemoteProperties(sessionId, path)
      if (mounted.current && request === generation.current) { setProperties(result); setMode(octalMode(result.mode)) }
    } catch (cause) { if (mounted.current && request === generation.current) setError(errorMessage(cause)) }
    finally { if (mounted.current && request === generation.current) { operation.current = false; setBusy('') } }
  }, [api, sessionId, path])
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; generation.current++; operation.current = false } }, [load])
  const close = useCallback(() => { if (!operation.current) onClose() }, [onClose])
  const special = !!properties && !!(properties.mode & 0o7000)
  const supported = !!properties && ['file', 'directory'].includes(properties.type) && !special
  const numeric = validMode(mode) ? parseInt(mode, 8) : null
  const changed = !!properties && numeric !== null && numeric !== (properties.mode & 0o777)
  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (!properties || operation.current || !supported || !changed || numeric === null) return
    operation.current = true; setBusy('saving'); setError(''); setNotice('')
    const request = generation.current
    try {
      const result = await api.chmodRemote(sessionId, properties.path, numeric, properties.version)
      if (!mounted.current || request !== generation.current) return
      setProperties(result); setMode(octalMode(result.mode)); setNotice('Permissions saved.'); onChanged()
    } catch (cause) { if (mounted.current && request === generation.current) setError(errorMessage(cause)) }
    finally { if (mounted.current && request === generation.current) { operation.current = false; setBusy('') } }
  }
  return <Modal title="File properties" onClose={close} className="file-properties-modal">
    <div className="file-properties-heading"><FileCog size={23} /><div><h3>{path.split('/').filter(Boolean).at(-1) || '/'}</h3><p>{path}</p></div></div>
    {error && <div className="form-error" role="alert">{error}<span className="file-properties-error-hint">Your permission choices are preserved. Reload to review the latest properties before trying again.</span></div>}
    {notice && <p className="file-properties-notice" role="status">{notice}</p>}
    {busy === 'loading' && !properties ? <div className="file-properties-loading" role="status"><LoaderCircle size={24} className="spin" />Reading file properties…</div> : properties && <>
      <dl className="file-properties-details"><div><dt>Type</dt><dd>{properties.type === 'directory' ? 'Folder' : properties.type === 'symlink' ? 'Symbolic link' : properties.type === 'file' ? 'File' : 'Special file'}</dd></div><div><dt>Size</dt><dd>{formatBytes(properties.size)} <span>({properties.size.toLocaleString()} bytes)</span></dd></div><div><dt>Owner</dt><dd>{properties.uid === undefined ? 'Not reported' : `UID ${properties.uid}`}</dd></div><div><dt>Group</dt><dd>{properties.gid === undefined ? 'Not reported' : `GID ${properties.gid}`}</dd></div><div><dt>Modified</dt><dd>{timestamp(properties.modified)}</dd></div><div><dt>Accessed</dt><dd>{timestamp(properties.accessed)}</dd></div></dl>
      <form onSubmit={(event) => void save(event)} noValidate><div className="file-permissions-heading"><h3>Permissions</h3><label>Octal<input aria-label="Octal permissions" value={mode} maxLength={4} inputMode="numeric" autoComplete="off" spellCheck={false} disabled={!!busy || !supported} onChange={(event) => { setMode(event.target.value); setNotice('') }} aria-invalid={!validMode(mode)} /></label></div>
        <div className="file-permissions-matrix" role="group" aria-label="File permissions"><span /><strong>Read</strong><strong>Write</strong><strong>Execute</strong>{CLASSES.map((group) => <div className="file-permissions-row" key={group.name}><span>{group.name}</span>{BITS.map((bit) => <label key={bit.name}><input type="checkbox" aria-label={`${group.name} ${bit.name.toLowerCase()} permission`} checked={numeric !== null && !!(numeric & (bit.value << group.shift))} disabled={!!busy || !supported || numeric === null} onChange={(event) => { const next = event.target.checked ? numeric! | bit.value << group.shift : numeric! & ~(bit.value << group.shift); setMode(octalMode(next)); setNotice('') }} /></label>)}</div>)}</div>
        {!supported && <p className="file-permissions-hint">{special ? 'Special permission bits are set on this item. Use the terminal to manage its permissions without removing those bits.' : 'Permissions for symbolic links and special files are read-only.'}</p>}
        {supported && !validMode(mode) && <p className="form-error" role="alert">Enter three octal digits, from 000 to 777.</p>}
        <div className="modal-actions"><button type="button" className="button secondary" aria-label="Reload file properties" disabled={!!busy} onClick={() => void load()}><RefreshCw size={15} />Reload</button><button type="button" className="button secondary" disabled={!!busy} onClick={close}>Done</button><button className="button primary" aria-label="Save file permissions" disabled={!!busy || !supported || !changed || !validMode(mode)}>{busy === 'saving' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}Save permissions</button></div>
      </form>
    </>}
    {!properties && !busy && <div className="modal-actions"><button className="button secondary" onClick={close}>Close</button><button className="button primary" onClick={() => void load()}>Try again</button></div>}
  </Modal>
}
