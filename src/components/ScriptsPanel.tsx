import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type BasicSetupOptions, type Statistics } from '@uiw/react-codemirror'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { search as editorSearch } from '@codemirror/search'
import { tags } from '@lezer/highlight'
import { Check, FileCode2, LoaderCircle, Play, Plus, Save, Search, TerminalSquare, Trash2 } from 'lucide-react'
import type { Runbook, ScriptRun } from '../../shared/types'
import { useTheme } from '../theme'
import { useStreamMode } from '../stream-mode'
import { streamPrivacyExtension } from '../privacy-editor'
import { Modal, errorMessage } from './Modal'
import './scripts.css'

const MAX_SCRIPT = 32768
const SETUP: BasicSetupOptions = { lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true, syntaxHighlighting: false }
const SHELL = StreamLanguage.define(shell)
const SEARCH = editorSearch({ top: true })
const blankScript = (): Runbook => ({ id: crypto.randomUUID(), name: '', command: '', description: '', group: '' })
const signature = (script: Runbook) => JSON.stringify([script.id, script.name, script.command, script.description || '', script.group || ''])

export interface ScriptsTarget { sessionId: string; name: string; host: string; username: string; port: number }
interface Review { token: string; script: Runbook; target: ScriptsTarget; unsaved: boolean }
const sameTarget = (a: ScriptsTarget | null, b: ScriptsTarget) => !!a && a.sessionId === b.sessionId && a.host === b.host && a.port === b.port && a.username === b.username

export function ScriptsPanel({ scripts, target, targets, onTargetChange, onSave, onDelete, onRun, onDirtyChange, runs = [], notifyOnCompletion = false, onNotifyChange }: {
  scripts: Runbook[]
  target: ScriptsTarget | null
  targets?: ScriptsTarget[]
  onTargetChange?: (sessionId: string) => void
  onSave: (script: Runbook) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onRun: (script: Runbook) => Promise<ScriptRun | void>
  onDirtyChange?: (dirty: boolean) => void
  runs?: ScriptRun[]
  notifyOnCompletion?: boolean
  onNotifyChange?: (enabled: boolean) => void
}) {
  const { preset } = useTheme()
  const { enabled: streamMode, rules } = useStreamMode()
  const [draft, setDraft] = useState<Runbook>(blankScript)
  const [baseline, setBaseline] = useState(() => signature(draft))
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState<'save' | 'delete' | 'run' | null>(null)
  const busyRef = useRef(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pendingSelection, setPendingSelection] = useState<Runbook | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Runbook | null>(null)
  const [review, setReview] = useState<Review | null>(null)
  const consumedReview = useRef<string | null>(null)
  const [position, setPosition] = useState({ line: 1, column: 1, lines: 1 })
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const reviewRef = useRef<() => void>(() => {})
  const dirtyCallback = useRef(onDirtyChange)
  dirtyCallback.current = onDirtyChange
  const dirty = signature(draft) !== baseline
  const savedScript = scripts.find((script) => script.id === draft.id)
  const tooLarge = draft.command.length > MAX_SCRIPT
  const targetRunning = !!target && runs.some((run) => run.sessionId === target.sessionId && run.status === 'running')
  const recentRuns = [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 6)
  const filtered = [...scripts].sort((a, b) => a.name.localeCompare(b.name)).filter((script) => `${script.name} ${script.description || ''} ${script.group || ''}`.toLowerCase().includes(search.toLowerCase()))
  const groups = [...new Set(scripts.map((script) => script.group).filter((group): group is string => !!group))].sort((a, b) => a.localeCompare(b))

  useEffect(() => { dirtyCallback.current?.(dirty) }, [dirty])
  useEffect(() => () => dirtyCallback.current?.(false), [])
  useEffect(() => {
    // The same records can be edited in the runbook library. Refresh a clean
    // selection while preserving an unsaved script when metadata changes.
    if (!dirty && savedScript && signature(savedScript) !== baseline) {
      setDraft({ ...savedScript }); setBaseline(signature(savedScript))
    }
  }, [savedScript, baseline, dirty])
  const closeSelection = useCallback(() => setPendingSelection(null), [])
  const closeDelete = useCallback(() => { if (!busyRef.current) setDeleteTarget(null) }, [])
  const closeReview = useCallback(() => { if (!busyRef.current) setReview(null) }, [])

  function select(next: Runbook) {
    setDraft({ ...next }); setBaseline(signature(next)); setError(''); setNotice('')
  }
  function requestSelection(next: Runbook) {
    if (busyRef.current || next.id === draft.id && signature(next) === baseline) return
    if (dirty) setPendingSelection({ ...next })
    else select(next)
  }
  function snapshot(requireName: boolean): Runbook | null {
    if (requireName && !draft.name.trim()) { setError('Give this script a name before saving.'); return null }
    if (!draft.command.trim()) { setError('Write a shell script before saving or running it.'); return null }
    if (tooLarge) { setError('Scripts can contain up to 32,768 characters. Shorten this draft before continuing.'); return null }
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(draft.command)) { setError('Remove non-printing control characters from the script. Tabs and new lines are supported.'); return null }
    return { id: draft.id, name: draft.name.trim() || 'Untitled script', command: draft.command, ...(draft.description?.trim() ? { description: draft.description.trim() } : {}), ...(draft.group?.trim() ? { group: draft.group.trim() } : {}) }
  }
  async function save() {
    if (busyRef.current) return
    const script = snapshot(true)
    if (!script) return
    busyRef.current = true; setBusy('save'); setError(''); setNotice('')
    try {
      await onSave(script)
      setDraft(script); setBaseline(signature(script)); setNotice(`${script.name} saved.`)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { busyRef.current = false; setBusy(null) }
  }
  saveRef.current = save
  function requestRun() {
    if (busyRef.current || !target || targetRunning) return
    const script = snapshot(false)
    if (!script) return
    setError(''); setNotice('')
    setReview({ token: crypto.randomUUID(), script, target: { ...target }, unsaved: dirty || !savedScript })
  }
  reviewRef.current = requestRun
  async function runReviewed() {
    if (!review || busyRef.current || consumedReview.current === review.token) return
    if (!sameTarget(target, review.target)) { setReview(null); setError('The target terminal changed. Review the script again before running it.'); return }
    consumedReview.current = review.token
    busyRef.current = true; setBusy('run'); setError('')
    try {
      const run = await onRun({ ...review.script })
      setNotice(run ? `${review.script.name} started in ${review.target.name}. Its result will appear below.` : `${review.script.name} sent once to ${review.target.name}.`)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setReview(null); busyRef.current = false; setBusy(null) }
  }
  async function remove() {
    if (!deleteTarget || busyRef.current) return
    const script = deleteTarget
    busyRef.current = true; setBusy('delete'); setError(''); setNotice('')
    try {
      await onDelete(script.id)
      setDeleteTarget(null)
      if (draft.id === script.id) select(blankScript())
      setNotice(`${script.name} deleted.`)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { busyRef.current = false; setBusy(null) }
  }
  const statistics = useCallback((value: Statistics) => {
    const next = { line: value.line.number, column: value.selection.main.head - value.line.from + 1, lines: value.lineCount }
    setPosition((current) => current.line === next.line && current.column === next.column && current.lines === next.lines ? current : next)
  }, [])
  const changeCommand = useCallback((command: string) => { setDraft((current) => ({ ...current, command })); setNotice('') }, [])
  const editorTheme = useMemo(() => EditorView.theme({
    '&': { color: 'var(--text)', backgroundColor: 'var(--input)', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace', lineHeight: '1.7' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '13px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-active)', color: 'var(--text)' },
    '.cm-activeLine': { backgroundColor: 'var(--surface-hover)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--surface-active)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' },
    '.cm-panels': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)', borderColor: 'var(--border)' },
    '.cm-textfield': { backgroundColor: 'var(--input)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '6px', padding: '4px 7px' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '6px' },
    '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent-border)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--surface-active)', outline: '1px solid var(--accent)' },
  }, { dark: preset.appearance === 'dark' }), [preset.appearance])
  const highlighting = useMemo(() => syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.operatorKeyword], color: preset.terminal.magenta || 'var(--accent)' },
    { tag: [tags.string, tags.regexp], color: preset.terminal.green || 'var(--success)' },
    { tag: [tags.number, tags.bool, tags.atom], color: preset.terminal.yellow || 'var(--warning)' },
    { tag: [tags.function(tags.variableName), tags.propertyName], color: preset.terminal.cyan || 'var(--accent)' },
    { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
    { tag: tags.invalid, color: 'var(--danger)' },
  ])), [preset.terminal])
  const shortcuts = useMemo(() => Prec.highest(keymap.of([
    { key: 'Mod-s', run: () => { void saveRef.current(); return true } },
    { key: 'Mod-Enter', run: () => { reviewRef.current(); return true } },
  ])), [])
  const privacy = useMemo(() => streamPrivacyExtension(streamMode), [streamMode, rules])
  const extensions = useMemo(() => [EditorState.lineSeparator.of('\n'), EditorView.contentAttributes.of({ 'aria-label': 'Script contents', spellcheck: 'false' }), SHELL, SEARCH, editorTheme, highlighting, shortcuts, privacy], [editorTheme, highlighting, shortcuts, privacy])

  return <section className="scripts-panel" aria-label="Scripts workspace">
    <header className="scripts-heading"><div><span className="scripts-heading-icon"><FileCode2 size={21} /></span><div><h1>Scripts</h1><p>Keep useful shell scripts close, then run them in your terminal.</p></div></div><button className="button secondary" disabled={!!busy} onClick={() => requestSelection(blankScript())}><Plus size={15} />New script</button></header>
    <div className="script-library-layout">
      <aside className="scripts-library" aria-label="Saved scripts">
        <label className="scripts-search"><Search size={15} /><input aria-label="Search scripts" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search scripts…" /></label>
        <div className="scripts-library-caption"><span>Saved scripts</span><span>{scripts.length}</span></div>
        <div className="scripts-list">{filtered.map((script) => <button key={script.id} className={`scripts-list-item ${draft.id === script.id ? 'selected' : ''}`} aria-label={`Open script ${script.name}`} aria-pressed={draft.id === script.id} disabled={!!busy} onClick={() => requestSelection(script)}><FileCode2 size={17} /><span><strong>{script.name}</strong><small>{script.group || script.description || `${script.command.split('\n').length} lines`}</small></span>{draft.id === script.id && dirty && <i aria-label="Unsaved script changes" />}</button>)}{!filtered.length && <div className="scripts-empty"><FileCode2 size={27} /><strong>{search ? 'No matching scripts' : 'Your scripts, ready to reuse'}</strong><p>{search ? 'Try another name or group.' : 'Write your first script and save it to this device.'}</p></div>}</div>
        <p className="scripts-library-note">Shared with your runbook library and included in workspace backups.</p>
      </aside>
      <div className="scripts-editor">
        <div className="scripts-editor-scroll">
          <div className="scripts-metadata"><div className="scripts-editor-caption"><h2>{savedScript ? 'Edit script' : 'New script'}</h2><span className={dirty ? 'scripts-unsaved' : ''}>{dirty ? 'Unsaved changes' : savedScript ? 'Saved' : 'Not saved yet'}</span>{savedScript && <button className="icon-button danger-hover" aria-label={`Delete script ${savedScript.name}`} disabled={!!busy} onClick={() => setDeleteTarget({ ...savedScript })}><Trash2 size={15} /></button>}</div><div className="scripts-metadata-row"><label className="field-label">Script name<input value={draft.name} maxLength={100} disabled={!!busy} onChange={(event) => { setDraft((current) => ({ ...current, name: event.target.value })); setNotice('') }} placeholder="e.g. Check service health" /></label><label className="field-label">Group <span className="optional">optional</span><input aria-label="Script group" list="script-groups" maxLength={100} disabled={!!busy} value={draft.group || ''} onChange={(event) => { setDraft((current) => ({ ...current, group: event.target.value })); setNotice('') }} placeholder="e.g. Maintenance" /><datalist id="script-groups">{groups.map((group) => <option key={group}>{group}</option>)}</datalist></label></div><label className="field-label">Description <span className="optional">optional</span><input aria-label="Script description" value={draft.description || ''} maxLength={2000} disabled={!!busy} onChange={(event) => { setDraft((current) => ({ ...current, description: event.target.value })); setNotice('') }} placeholder="What does this script do?" /></label></div>
          {error && <div className="scripts-message scripts-error" role="alert">{error}</div>}{notice && <div className="scripts-message scripts-notice" role="status"><Check size={15} />{notice}</div>}
          {tooLarge && <div className="scripts-message scripts-error" role="alert">This draft exceeds the 32,768 character limit.</div>}
          <div className="scripts-code-heading"><span><FileCode2 size={14} />Shell (sh)</span><span>{position.lines} {position.lines === 1 ? 'line' : 'lines'} · {draft.command.length.toLocaleString()} / 32,768 characters</span></div>
          <div className="scripts-code"><CodeMirror height="100%" value={draft.command} theme="none" extensions={extensions} basicSetup={SETUP} readOnly={!!busy} onChange={changeCommand} onStatistics={statistics} placeholder="# Write your shell script here" /></div>
          <div className="scripts-editor-status"><span>Ln {position.line}, Col {position.column}</span><span>UTF-8 · LF</span></div>
          {draft.command.includes('{{') && <p className="scripts-literal-note">Runbook variables are sent literally here. Replace any {'{{variables}}'} in the script before running.</p>}
          {recentRuns.length > 0 && <section className="scripts-run-history" aria-label="Script run history"><div className="scripts-run-history-heading"><h3>Recent runs</h3><span>Output stays in its terminal</span></div><ol>{recentRuns.map((run) => <li key={run.id} className={`script-run-result ${run.status}`} data-run-id={run.id} data-status={run.status}><div><strong>{run.name}</strong><span>{targets?.find((item) => item.sessionId === run.sessionId)?.name || 'Terminal session'}{run.message ? ` · ${run.message}` : ''}</span></div><span className="script-run-outcome">{run.status === 'running' ? <><LoaderCircle size={12} className="spin" />Running</> : run.status === 'completed' ? 'Completed' : run.status === 'failed' ? 'Failed' : 'Disconnected'}{run.exitCode !== undefined && <small>Exit {run.exitCode}</small>}{run.durationMs !== undefined && <small>{(run.durationMs / 1000).toFixed(1)}s</small>}</span></li>)}</ol></section>}
        </div>
        <footer className="scripts-actions"><div className="scripts-target"><TerminalSquare size={16} /><div>{targets && onTargetChange ? <label>Target terminal<select aria-label="Script target terminal" disabled={!!busy || !targets.length} value={target?.sessionId || ''} onChange={(event) => onTargetChange(event.target.value)}>{!target && <option value="">Choose a connected terminal</option>}{targets.map((item) => <option key={item.sessionId} value={item.sessionId}>{item.name} · {item.username}@{item.host}:{item.port}</option>)}</select></label> : <><span>Target terminal</span><strong>{target?.name || 'No connected terminal'}</strong></>}<small>{targetRunning ? 'A script is running in this terminal. Follow its output there.' : target ? 'Runs once using sh. Start at an idle shell prompt.' : 'Connect a terminal to run this script.'}</small>{onNotifyChange && <label className="scripts-notification-option"><input type="checkbox" checked={notifyOnCompletion} onChange={(event) => onNotifyChange(event.target.checked)} />Notify when scripts finish</label>}</div></div><div className="scripts-action-buttons"><button className="button secondary" aria-label="Save script" disabled={!!busy || !dirty || tooLarge} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}Save<kbd>Ctrl S</kbd></button><button className="button primary" aria-label="Review script run" disabled={!!busy || !target || targetRunning || !draft.command.trim() || tooLarge} onClick={requestRun}><Play size={15} />Run script</button></div></footer>
      </div>
    </div>
    {pendingSelection && <Modal title="Discard script changes?" onClose={closeSelection} className="small-modal"><p className="modal-description">Your edits have not been saved. Discard them before opening {pendingSelection.name || 'a new script'}?</p><div className="modal-actions"><button className="button secondary" onClick={closeSelection}>Keep editing</button><button className="button danger-button" onClick={() => { select(pendingSelection); setPendingSelection(null) }}>Discard changes</button></div></Modal>}
    {deleteTarget && <Modal title="Delete saved script?" onClose={closeDelete} className="small-modal"><p className="modal-description">Delete <strong>{deleteTarget.name}</strong> from your scripts and runbook library?{draft.id === deleteTarget.id && dirty ? ' Unsaved changes to this script will also be discarded.' : ''}</p>{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={closeDelete}>Keep script</button><button className="button danger-button" aria-label="Confirm delete script" disabled={!!busy} onClick={() => void remove()}>{busy === 'delete' ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}Delete script</button></div></Modal>}
    {review && <Modal title="Run script in terminal?" onClose={closeReview} className="scripts-run-modal"><div className="scripts-run-content"><div className="scripts-run-target"><TerminalSquare size={20} /><div><strong>{review.target.name}</strong><span>{review.target.username}@{review.target.host}:{review.target.port}</span></div></div><h3>{review.script.name}{review.unsaved && <span>Unsaved draft</span>}</h3><p>This script will be sent once to this terminal using Shell (sh). Its output appears in the terminal. Start at an idle shell prompt.</p><pre tabIndex={0} aria-label="Script run preview">{review.script.command}</pre>{!sameTarget(target, review.target) && <div className="form-error" role="alert">The target terminal changed. Close this review and select a terminal again.</div>}</div><div className="scripts-run-actions"><button className="button secondary" disabled={!!busy} onClick={closeReview}>Cancel run</button><button className="button primary" aria-label="Run reviewed script" disabled={!!busy || !sameTarget(target, review.target)} onClick={() => void runReviewed()}>{busy === 'run' ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}Run on {review.target.name}</button></div></Modal>}
  </section>
}
