import { useCallback, useState } from 'react'
import { Check, Copy, FileKey2, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import type { GeneratedKey, KeyGenerationRequest, SshHeavenApi } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import './key-generator.css'

export function KeyGenerator({ api, onClose, onUseKey, useKeyLabel = 'Use key in connection', useKeyBusy = false }: { api: SshHeavenApi; onClose: () => void; onUseKey: (key: GeneratedKey) => void; useKeyLabel?: string; useKeyBusy?: boolean }) {
  const [type, setType] = useState<KeyGenerationRequest['type']>('ed25519')
  const [comment, setComment] = useState('ssh-heaven')
  const [passphrase, setPassphrase] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<GeneratedKey | null>(null)
  const [copied, setCopied] = useState(false)
  const close = useCallback(() => { if (!busy && !useKeyBusy) onClose() }, [busy, useKeyBusy, onClose])
  async function generate(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    if (passphrase !== confirmation) { setError('Passphrases do not match.'); return }
    setError('')
    setBusy(true)
    try {
      const key = await api.generateKey({ type, comment: comment.trim(), ...(passphrase ? { passphrase } : {}) })
      setPassphrase('')
      setConfirmation('')
      if (key) setResult(key)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }
  async function copy() {
    if (!result) return
    try { await api.writeClipboard(result.publicKey); setCopied(true) }
    catch (cause) { setError(errorMessage(cause)) }
  }

  return <Modal title="Generate SSH key" onClose={close} className="key-generator-modal">
    {!result ? <form onSubmit={(event) => void generate(event)}>
      <div className="keygen-intro"><span><KeyRound size={24} /></span><div><h3>A key of your own.</h3><p>Create a key pair on this device for password-free SSH authentication.</p></div></div>
      <label className="field-label">Key type<select aria-label="Key type" value={type} disabled={busy} onChange={(event) => setType(event.target.value as KeyGenerationRequest['type'])}><option value="ed25519">Ed25519 (recommended)</option><option value="rsa">RSA 3072-bit</option></select></label>
      <p className="keygen-field-hint">{type === 'ed25519' ? 'Compact, fast, and supported by modern SSH servers.' : 'For servers that require RSA keys.'}</p>
      <label className="field-label">Key comment <span className="optional">optional</span><input value={comment} disabled={busy} onChange={(event) => setComment(event.target.value)} maxLength={200} placeholder="e.g. workstation or email address" autoComplete="off" /></label>
      <div className="form-row keygen-passphrase-row"><label className="field-label">Passphrase <span className="optional">optional</span><input type="password" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} maxLength={8192} autoComplete="new-password" placeholder="Protect your private key" /></label><label className="field-label">Confirm passphrase<input type="password" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} maxLength={8192} autoComplete="new-password" placeholder="Repeat passphrase" /></label></div>
      <div className="keygen-local-note"><ShieldCheck size={16} /><p>Your private key is saved to a location you choose. Add the public key to your server’s <code>authorized_keys</code> file to use it.</p></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}{busy ? 'Generating key…' : 'Generate key pair'}</button></div>
      {busy && <p className="keygen-busy-note" role="status">Choose a save location in the file dialog to continue.</p>}
    </form> : <div className="keygen-result">
      <div className="keygen-success"><span><Check size={25} /></span><div><h3>Your SSH key is ready</h3><p>{result.type === 'ed25519' ? 'Ed25519' : 'RSA 3072-bit'} key pair saved on this device.</p></div></div>
      <dl className="keygen-paths"><div><dt><FileKey2 size={14} />Private key</dt><dd data-testid="private-key-path">{result.privateKeyPath}</dd></div><div><dt><KeyRound size={14} />Public key</dt><dd data-testid="public-key-path">{result.publicKeyPath}</dd></div><div><dt>Fingerprint</dt><dd className="keygen-fingerprint">{result.fingerprint}</dd></div></dl>
      <label className="field-label keygen-public-label">Public key<textarea readOnly value={result.publicKey} aria-label="Generated public key" rows={3} spellCheck={false} /></label>
      <div className="keygen-copy-row"><span>Share this public key with your server.</span><button className="button secondary compact" onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Public key copied' : 'Copy public key'}</button></div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button className="button secondary" disabled={useKeyBusy} onClick={close}>Done</button><button className="button primary" disabled={useKeyBusy} onClick={() => onUseKey(result)}>{useKeyBusy ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}{useKeyLabel}</button></div>
    </div>}
  </Modal>
}
