import { useCallback, useEffect, useRef, useState } from 'react'
import { FilePenLine, LoaderCircle, ShieldCheck, ShieldX, TerminalSquare } from 'lucide-react'
import type { McpApproval, SshHeavenApi } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import './mcp-approval.css'

function visibleText(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
function visiblePath(value: string): string {
  return visibleText(value).replace(/[\t\n]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
function endpoint(host?: string, username?: string, port?: number): string {
  const address = host?.includes(':') && !host.startsWith('[') ? `[${host}]` : host ?? ''
  return `${username ? `${username}@` : ''}${address}${port ? `:${port}` : ''}`
}

export function McpApprovalDialog({ api, request, onResolved }: {
  api: SshHeavenApi
  request: McpApproval
  onResolved: (id: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now)
  const busyRef = useRef(false)
  const currentId = useRef(request.id)
  currentId.current = request.id
  const resolvedRef = useRef(onResolved)
  resolvedRef.current = onResolved
  const remaining = Math.max(0, Math.ceil((request.expiresAt - now) / 1000))
  useEffect(() => {
    setError(''); setBusy(false); busyRef.current = false; setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [request.id])
  const resolve = useCallback(async (approved: boolean) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    const id = request.id
    try { await api.resolveMcpApproval(id, approved); resolvedRef.current(id) }
    catch (cause) { if (currentId.current === id) setError(errorMessage(cause)) }
    finally { if (currentId.current === id) { busyRef.current = false; setBusy(false) } }
  }, [api, request.id])
  const deny = useCallback(() => { void resolve(false) }, [resolve])
  const isWrite = request.tool === 'write_remote_file'
  const title = isWrite ? 'Change a remote file' : request.tool === 'run_group_command' ? 'Run a command on this group' : 'Run a command on this server'
  const hasEscapes = [request.command, request.content, request.previousContent].some((value) => value !== undefined && visibleText(value) !== value) || request.path !== undefined && visiblePath(request.path) !== request.path
  return <Modal key={request.id} title="Review AI request" onClose={deny} className="mcp-approval-modal">
    <div className="mcp-approval-content">
      <div className="mcp-approval-intro"><span className="mcp-approval-icon">{isWrite ? <FilePenLine size={21} /> : <TerminalSquare size={21} />}</span><div><h3>{title}</h3><p>{request.summary}</p></div></div>
      <dl className="mcp-approval-details"><dt>MCP tool</dt><dd>{request.tool}</dd>{request.host && <><dt>Server</dt><dd>{endpoint(request.host, request.username, request.port)}</dd></>}{request.group && <><dt>Group</dt><dd>{request.group}</dd></>}{request.path && <><dt>Remote path</dt><dd>{visiblePath(request.path)}</dd></>}{request.sessionId && <><dt>Session</dt><dd>{request.sessionId}</dd></>}</dl>
      {!!request.targets?.length && <section className="mcp-approval-targets" aria-label="Reviewed MCP targets"><span className="mcp-approval-label">Exact targets · {request.targets.length}</span>{request.targets.map((target) => <div key={target.id}><strong>{target.name}</strong><code>{endpoint(target.host, target.username, target.port)}</code></div>)}</section>}
      {request.command !== undefined && <section><span className="mcp-approval-label">Exact command</span><pre className="mcp-approval-preview" tabIndex={0} aria-label="MCP command preview">{visibleText(request.command)}</pre></section>}
      {isWrite && <>
        {request.previousContent !== undefined && <section className="mcp-file-preview"><span className="mcp-approval-label">Current file · {new TextEncoder().encode(request.previousContent).byteLength} bytes</span><pre className="mcp-approval-preview" tabIndex={0} aria-label="Current remote file contents">{visibleText(request.previousContent)}</pre></section>}
        <section className="mcp-file-preview"><span className="mcp-approval-label">Proposed file · {new TextEncoder().encode(request.content ?? '').byteLength} bytes</span><pre className="mcp-approval-preview" tabIndex={0} aria-label="Proposed remote file contents">{visibleText(request.content ?? '')}</pre></section>
      </>}
      {hasEscapes && <p className="mcp-approval-truncated">Invisible control and text-direction characters are shown as Unicode escapes. The request itself is unchanged.</p>}
      <p className="mcp-approval-expiry">{remaining ? `This approval expires in ${remaining} seconds.` : 'This approval has expired.'} Approving applies only to this request.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
    </div>
    <div className="mcp-approval-actions"><button className="button secondary" aria-label="Deny MCP request" disabled={busy} onClick={deny}><ShieldX size={15} />Deny request</button><button className="button primary" aria-label="Approve MCP request" disabled={busy || remaining === 0} onClick={() => void resolve(true)}>{busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}Approve request</button></div>
  </Modal>
}
