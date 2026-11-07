import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, LoaderCircle, Play, Server, ShieldCheck, Square, TerminalSquare } from 'lucide-react'
import type { GroupCommandEvent, HostProfile, SshHeavenApi } from '../../shared/types'
import { Modal, errorMessage } from './Modal'
import './group-command.css'

const terminalStatuses = new Set(['completed', 'failed', 'canceled'])
const commandFailed = (event: GroupCommandEvent | undefined) => event?.status === 'failed' || (event?.status === 'completed' && typeof event.exitCode === 'number' && event.exitCode !== 0)
const statusLabel = (event: GroupCommandEvent) => event.status === 'completed' || (event.status === 'failed' && typeof event.exitCode === 'number') ? `Exit ${event.exitCode ?? 'unknown'}` : ({ queued: 'Queued', connecting: 'Connecting', verifying: 'Verify host key', running: 'Running', failed: 'Failed', canceled: 'Canceled' } as const)[event.status]
type Review = { group: string; command: string; timeoutSeconds: number; targets: HostProfile[] }

export function GroupCommand({ api, profiles, initialGroup, initialCommand = '', onClose }: { api: SshHeavenApi; profiles: HostProfile[]; initialGroup?: string; initialCommand?: string; onClose: () => void }) {
  const groups = [...new Set(profiles.map((profile) => profile.group).filter((group): group is string => !!group))].sort((a, b) => a.localeCompare(b))
  const [group, setGroup] = useState(initialGroup || groups[0] || '')
  const [command, setCommand] = useState(initialCommand)
  const [timeoutSeconds, setTimeoutSeconds] = useState(300)
  const [passphrase, setPassphrase] = useState('')
  const [review, setReview] = useState<Review | null>(null)
  const [phase, setPhase] = useState<'edit' | 'review' | 'running'>('edit')
  const [results, setResults] = useState<Record<string, GroupCommandEvent>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [canceling, setCanceling] = useState(false)
  const [closeConfirmation, setCloseConfirmation] = useState(false)
  const runId = useRef<string | null>(null)
  const outputLimit = useRef(64 * 1024)
  const targets = group ? profiles.filter((profile) => profile.group === group) : []
  const currentTargets = review?.targets ?? targets
  const completed = currentTargets.filter((profile) => results[profile.id] && terminalStatuses.has(results[profile.id].status)).length
  const isActive = phase === 'running' && completed < currentTargets.length
  const failed = currentTargets.filter((profile) => commandFailed(results[profile.id])).length
  const canceled = currentTargets.filter((profile) => results[profile.id]?.status === 'canceled').length

  useEffect(() => api.onGroupCommand((event) => {
    if (event.runId !== runId.current) return
    setResults((current) => {
      const previous = current[event.profileId]
      if (previous && terminalStatuses.has(previous.status) && !terminalStatuses.has(event.status)) return current
      const output = event.output ?? previous?.output ?? ''
      return { ...current, [event.profileId]: { ...previous, ...event, output: output.slice(-outputLimit.current), truncated: event.truncated || previous?.truncated || output.length > outputLimit.current } }
    })
  }), [api])
  const close = useCallback(() => {
    if (isActive) setCloseConfirmation(true)
    else { setPassphrase(''); onClose() }
  }, [isActive, onClose])
  function prepare(event: React.FormEvent) {
    event.preventDefault(); setError('')
    if (!targets.length) { setError('Choose a group with at least one saved host.'); return }
    if (!command.trim()) { setError('Enter the command to run.'); return }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) { setError('Timeout must be between 1 and 3600 seconds.'); return }
    setReview({ group, command, timeoutSeconds, targets: targets.map((profile) => ({ ...profile })) })
    setPhase('review')
  }
  async function run() {
    if (!review || phase !== 'review' || runId.current) return
    const id = crypto.randomUUID()
    const keyPassphrase = review.targets.some((profile) => profile.authType === 'privateKey') ? passphrase : ''
    setPassphrase(''); setError('')
    runId.current = id
    outputLimit.current = Math.min(64 * 1024, Math.max(2048, Math.floor(4 * 1024 * 1024 / review.targets.length)))
    setResults(Object.fromEntries(review.targets.map((profile) => [profile.id, { runId: id, profileId: profile.id, host: profile.host, username: profile.username, name: profile.name, status: 'queued' as const } ])))
    setExpanded(new Set(review.targets.slice(0, 4).map((profile) => profile.id)))
    setPhase('running')
    try { await api.runGroupCommand({ runId: id, group: review.group, profileIds: review.targets.map((profile) => profile.id), command: review.command, timeoutSeconds: review.timeoutSeconds, ...(keyPassphrase ? { passphrase: keyPassphrase } : {}) }) }
    catch (cause) {
      const message = errorMessage(cause); setError(message)
      setResults((current) => Object.fromEntries(Object.entries(current).map(([profileId, event]) => [profileId, terminalStatuses.has(event.status) ? event : { ...event, status: 'failed' as const, error: message }])))
    }
  }
  async function cancel(closeAfter = false) {
    if (!runId.current || canceling) return
    setCanceling(true); setError('')
    try {
      await api.cancelGroupCommand(runId.current)
      if (closeAfter) { runId.current = null; onClose() }
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setCanceling(false) }
  }
  function another() {
    runId.current = null; setPhase('edit'); setReview(null); setResults({}); setCloseConfirmation(false); setError(''); setPassphrase('')
  }

  return <Modal title="Run group command" onClose={close} className="group-command-modal">
    {phase === 'edit' ? <form onSubmit={prepare}>
      <p className="group-command-intro">Run one command across the saved hosts in a group. Review the exact command and servers before starting.</p>
      <label className="field-label">Host group<select value={group} onChange={(event) => { setGroup(event.target.value); setPassphrase('') }} aria-label="Host group"><option value="">Choose a group</option>{groups.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
      {targets.length ? <div className="group-command-targets"><strong><Server size={13} />{targets.length} {targets.length === 1 ? 'server' : 'servers'} in {group}</strong><div className="group-target-list">{targets.map((profile) => <span key={profile.id} title={`${profile.username}@${profile.host}`}><Server size={11} />{profile.name}</span>)}</div></div> : <p className="group-command-note">Assign hosts to a named group in the connection editor or bulk import to run group commands.</p>}
      <label className="group-command-field">Command<textarea value={command} onChange={(event) => setCommand(event.target.value)} placeholder="Enter the command to run on every server" aria-label="Group command" required maxLength={32768} spellCheck={false} /></label>
      <div className="form-row group-command-settings"><label className="field-label">Timeout per server (seconds)<input type="number" value={timeoutSeconds} min={1} max={3600} onChange={(event) => setTimeoutSeconds(Number(event.target.value))} required /></label>{targets.some((profile) => profile.authType === 'privateKey') && <label className="field-label">Passphrase for SSH keys<span className="optional">optional</span><input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="off" maxLength={8192} placeholder="For encrypted keys in this run" /></label>}</div>
      <p className="group-command-note"><ShieldCheck size={15} /><span>Each server uses its saved password or SSH key. A key passphrase is used only for this run and is never saved.</span></p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="button secondary" onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={!targets.length || !command.trim()}><TerminalSquare size={15} />Review command</button></div>
    </form> : phase === 'review' && review ? <>
      <div className="group-command-review"><strong>Run on {review.targets.length} {review.targets.length === 1 ? 'server' : 'servers'} in {review.group}</strong><pre aria-label="Command to execute">{review.command}</pre><p>Timeout: {review.timeoutSeconds} seconds per server. The command will run on exactly the hosts listed below.</p></div>
      <div className="group-command-targets"><strong><Server size={13} />Reviewed servers</strong><div className="group-target-list">{review.targets.map((profile) => <span key={profile.id}>{profile.name} · {profile.username}@{profile.host}</span>)}</div></div>
      <div className="modal-actions"><button className="button secondary" onClick={() => setPhase('edit')}><ArrowLeft size={15} />Back to edit</button><button className="button primary" onClick={() => void run()}><Play size={15} />Run on {review.targets.length} {review.targets.length === 1 ? 'server' : 'servers'}</button></div>
    </> : <>
      <div className="group-run-heading"><TerminalSquare size={20} /><div><strong>{isActive ? 'Command running' : canceled ? 'Run canceled' : 'Run finished'}</strong><p>{completed} of {currentTargets.length} servers finished{failed ? ` · ${failed} failed` : ''}{canceled ? ` · ${canceled} canceled` : ''}</p></div>{isActive && <button className="button secondary compact" disabled={canceling} onClick={() => void cancel()}>{canceling ? <LoaderCircle size={13} className="spin" /> : <Square size={12} />}{canceling ? 'Canceling…' : 'Cancel run'}</button>}</div>
      <progress className="group-run-progress" value={completed} max={currentTargets.length || 1} aria-label="Group command progress" />
      <div className="group-run-results" aria-label="Group command results">{currentTargets.map((profile) => {
        const event = results[profile.id]
        if (!event) return null
        const open = expanded.has(profile.id)
        return <section key={profile.id} className="group-server-result" data-status={event.status} data-command-failed={commandFailed(event) ? 'true' : undefined}><header><button className="icon-button" aria-label={`${open ? 'Hide' : 'Show'} output for ${profile.name}`} aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (next.has(profile.id)) next.delete(profile.id); else next.add(profile.id); return next })}>{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button><div><strong>{profile.name}</strong><small>{profile.username}@{profile.host}</small></div><span>{event.status === 'running' || event.status === 'connecting' ? <LoaderCircle size={11} className="spin" /> : commandFailed(event) ? <AlertTriangle size={11} /> : event.status === 'completed' ? <Check size={11} /> : null}{statusLabel(event)}</span></header>{event.error && <p className="group-server-message">{event.error}</p>}{open && <pre aria-label={`Output from ${profile.name}`}>{event.output || (terminalStatuses.has(event.status) ? 'No output.' : 'Waiting for output…')}</pre>}{event.truncated && <p className="group-server-message">Output was shortened to keep this view responsive.</p>}</section>
      })}</div>
      {error && <div className="form-error" role="alert">{error}</div>}
      <p className="group-command-note">Canceling closes SSH channels and skips queued hosts. Remote processes that have started may continue.</p>
      {closeConfirmation && isActive && <div className="group-run-close-confirm"><p>Cancel this run and close its results?</p><div><button className="button secondary compact" disabled={canceling} onClick={() => setCloseConfirmation(false)}>Keep open</button><button className="button danger-button compact" disabled={canceling} onClick={() => void cancel(true)}>{canceling ? <LoaderCircle size={13} className="spin" /> : <Square size={12} />}Cancel run and close</button></div></div>}
      {!isActive && <div className="modal-actions"><button className="button secondary" onClick={another}>Another command</button><button className="button primary" onClick={close}>Done</button></div>}
    </>}
  </Modal>
}
