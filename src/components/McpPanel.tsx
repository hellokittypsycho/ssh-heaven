import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, Link2, LoaderCircle, ShieldCheck, Unplug } from 'lucide-react'
import type { McpState, SshHeavenApi } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import './mcp-panel.css'

export function McpPanel({ api, onClose }: { api: SshHeavenApi; onClose: () => void }) {
  const [state, setState] = useState<McpState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const close = useCallback(() => { if (!busyRef.current) onClose() }, [onClose])
  useEffect(() => {
    let mounted = true
    let received = false
    const stop = api.onMcpState((value) => { received = true; if (mounted) setState(value) })
    void api.getMcpState().then((value) => { if (mounted && !received) setState(value) }).catch((cause) => { if (mounted) setError(errorMessage(cause)) }).finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false; stop() }
  }, [api])
  async function toggle() {
    if (!state || busyRef.current) return
    busyRef.current = true; setBusy(true); setError(''); setNotice('')
    try { setState(await api.setMcpEnabled(!state.enabled)) }
    catch (cause) { setError(errorMessage(cause)) }
    finally { busyRef.current = false; setBusy(false) }
  }
  async function copy(value: string, label: string) {
    try { await api.writeClipboard(value); setNotice(`${label} configuration copied.`); setError('') }
    catch (cause) { setError(errorMessage(cause)) }
  }
  const message = error || state?.error
  return <Modal title="AI tools (MCP)" onClose={close} className="mcp-panel-modal">
    <div className="mcp-panel-content">
      <div className="mcp-panel-intro"><span><Link2 size={23} /></span><div><h3>Connect your AI tools.</h3><p>Use an external MCP client with the hosts and SSH sessions you manage in SSH Heaven.</p></div></div>
      {message && <div className="form-error" role="alert">{message}</div>}
      {loading ? <div className="mcp-panel-empty" role="status"><LoaderCircle className="spin" size={21} />Checking local MCP server…</div> : <>
        <section className="mcp-server-state" aria-label="MCP server status"><div><strong><span className={`mcp-state-dot${state?.enabled ? ' active' : ''}`} />{state?.enabled ? 'MCP server enabled' : 'MCP server disabled'}</strong><small>{state?.enabled ? state.endpoint || 'Listening on localhost only.' : 'External clients cannot access SSH Heaven while the server is disabled.'}</small>{state?.enabled && !!state.pendingApprovals.length && <small>{state.pendingApprovals.length} {state.pendingApprovals.length === 1 ? 'request' : 'requests'} waiting for your approval.</small>}</div><button className={`button ${state?.enabled ? 'secondary' : 'primary'}`} disabled={!state || busy} aria-label={state?.enabled ? 'Disable MCP server' : 'Enable MCP server'} onClick={() => void toggle()}>{busy ? <LoaderCircle className="spin" size={15} /> : state?.enabled ? <Unplug size={15} /> : <Link2 size={15} />}{busy ? 'Updating…' : state?.enabled ? 'Disable server' : 'Enable server'}</button></section>
        <div className="mcp-panel-rule"><ShieldCheck size={18} /><p>Read tools can inspect connected sessions and their remote data. Commands and file changes require your approval here, with the exact targets shown before they run.</p></div>
        <p className="mcp-panel-copy">Keep SSH Heaven open while using your client. Open an SSH session for session-based tools. Enabling MCP starts a local listener; remote work begins only when a client calls a tool.</p>
        {notice && <div className="mcp-panel-notice" role="status"><Check size={15} />{notice}</div>}
        {state?.claudeConfig ? <section className="mcp-config-card"><header className="mcp-config-heading"><div><h3>Claude · JSON</h3><p>Add this server entry to your MCP client configuration.</p></div><button className="button secondary compact" aria-label="Copy Claude MCP configuration" onClick={() => void copy(state.claudeConfig, 'Claude')}><Copy size={14} />Copy JSON</button></header><textarea aria-label="Claude MCP configuration" readOnly value={state.claudeConfig} spellCheck={false} rows={7} /></section> : <div className="mcp-config-disabled">Enable the local server to generate its client configuration.</div>}
        {state?.codexConfig && <section className="mcp-config-card"><header className="mcp-config-heading"><div><h3>Codex · TOML</h3><p>The bridge uses SSH Heaven’s bundled runtime.</p></div><button className="button secondary compact" aria-label="Copy Codex MCP configuration" onClick={() => void copy(state.codexConfig, 'Codex')}><Copy size={14} />Copy TOML</button></header><textarea aria-label="Codex MCP configuration" readOnly value={state.codexConfig} spellCheck={false} rows={7} /></section>}
        <p className="mcp-panel-footer">MCP is disabled when the application starts. Client configurations contain the local bridge command, not server passwords or the bridge authentication token.{state?.tools.length ? ` Available tools: ${state.tools.join(', ')}.` : ''}</p>
      </>}
    </div>
  </Modal>
}
