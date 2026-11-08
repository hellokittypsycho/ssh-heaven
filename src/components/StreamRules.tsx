import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Modal, errorMessage } from './Modal'
import { setStreamRules, useStreamRules } from '../stream-rules'
export function StreamRules({ onClose }: { onClose: () => void }) {
  const current = useStreamRules()
  const [draft, setDraft] = useState(() => current.map((rule) => ({ ...rule })))
  const [error, setError] = useState('')
  return <Modal title="Stream mode rules" onClose={onClose} className="stream-rules-modal">
    <p className="modal-description">IP addresses are hidden automatically. Add literal text to also hide domains, usernames, or server names. Rules are saved on this device and apply while Stream mode is on.</p>
    <div className="stream-rules-list">{draft.map((rule, index) => <div className="stream-rule" key={index}><input aria-label={`Hidden text ${index + 1}`} placeholder="e.g. production.example.com" maxLength={256} value={rule.text} onChange={(event) => setDraft((items) => items.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /><label className="checkbox-label"><input type="checkbox" checked={rule.caseSensitive} onChange={(event) => setDraft((items) => items.map((item, i) => i === index ? { ...item, caseSensitive: event.target.checked } : item))} />Match case</label><button className="icon-button" aria-label={`Remove Stream rule ${index + 1}`} onClick={() => setDraft((items) => items.filter((_, i) => i !== index))}><Trash2 size={15} /></button></div>)}</div>
    <button className="button secondary compact" disabled={draft.length >= 50} onClick={() => setDraft((items) => [...items, { text: '', caseSensitive: false }])}><Plus size={14} />Add rule</button>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" onClick={() => { try { setStreamRules(draft.filter((rule) => rule.text.trim())); onClose() } catch (cause) { setError(errorMessage(cause)) } }}>Save rules</button></div>
  </Modal>
}
