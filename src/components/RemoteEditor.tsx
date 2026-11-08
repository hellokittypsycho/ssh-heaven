import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { ExternalChange, type BasicSetupOptions, type ReactCodeMirrorRef, type Statistics } from '@uiw/react-codemirror'
import { EditorState, Prec, type Extension, type Text } from '@codemirror/state'
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { closeSearchPanel, openSearchPanel, search, searchKeymap, searchPanelOpen } from '@codemirror/search'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { sql } from '@codemirror/lang-sql'
import { rust } from '@codemirror/lang-rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { tags } from '@lezer/highlight'
import { ArrowLeft, CircleAlert, FileCode2, FolderOpen, LoaderCircle, Plus, RotateCcw, Save, Search, X } from 'lucide-react'
import type { RemoteFile, SshHeavenApi } from '../../shared/types'
import { useTheme } from '../theme'
import { useStreamMode } from '../stream-mode'
import { streamPrivacyExtension } from '../privacy-editor'
import { buildDiffPreview } from '../editor-diff'
import { stringBytes, updateDocumentBytes, type TextFormat } from '../editor-text'
import { Modal, errorMessage } from './Modal'
import './remote-editor.css'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const EDITOR_SETUP: BasicSetupOptions = { lineNumbers: true, foldGutter: true, highlightActiveLine: true, highlightActiveLineGutter: true, syntaxHighlighting: false, searchKeymap: false }
const LANGUAGES = [
  { id: 'plain', name: 'Plain text', extension: (): Extension => [] },
  { id: 'javascript', name: 'JavaScript / JSX', extension: () => javascript({ jsx: true }) },
  { id: 'typescript', name: 'TypeScript', extension: () => javascript({ typescript: true }) },
  { id: 'tsx', name: 'TypeScript / TSX', extension: () => javascript({ typescript: true, jsx: true }) },
  { id: 'python', name: 'Python', extension: python },
  { id: 'json', name: 'JSON', extension: json },
  { id: 'html', name: 'HTML', extension: html },
  { id: 'css', name: 'CSS', extension: css },
  { id: 'markdown', name: 'Markdown', extension: markdown },
  { id: 'yaml', name: 'YAML', extension: yaml },
  { id: 'shell', name: 'Shell', extension: () => StreamLanguage.define(shell) },
  { id: 'toml', name: 'TOML', extension: () => StreamLanguage.define(toml) },
  { id: 'sql', name: 'SQL', extension: sql },
  { id: 'rust', name: 'Rust', extension: rust },
  { id: 'properties', name: 'INI / properties', extension: () => StreamLanguage.define(properties) },
  { id: 'dockerfile', name: 'Dockerfile', extension: () => StreamLanguage.define(dockerFile) },
  { id: 'nginx', name: 'Nginx', extension: () => StreamLanguage.define(nginx) },
] as const
type Language = typeof LANGUAGES[number]['id']

function detectLanguage(filename: string): Language {
  const name = filename.split('/').at(-1)?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === 'nginx.conf') return 'nginx'
  if (/^(?:\.?(?:bashrc|bash_profile|zshrc|zprofile|profile)|\.env(?:\..*)?)$/.test(name)) return 'shell'
  const extension = name.split('.').at(-1)
  const extensions: Record<string, Language> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
    py: 'python', pyw: 'python', json: 'json', jsonc: 'json',
    html: 'html', htm: 'html', css: 'css', md: 'markdown', markdown: 'markdown',
    yaml: 'yaml', yml: 'yaml', sh: 'shell', bash: 'shell', zsh: 'shell',
    toml: 'toml', sql: 'sql', rs: 'rust', ini: 'properties', cfg: 'properties',
    conf: 'properties', properties: 'properties', service: 'properties',
  }
  return extensions[extension ?? ''] ?? 'plain'
}

function decodeForEditor(content: string): { draft: string; format: TextFormat } {
  const bom = content.startsWith('\uFEFF')
  const text = bom ? content.slice(1) : content
  const endings = text.match(/\r\n|\r|\n/g) ?? []
  const kinds = new Set(endings)
  const mixed = kinds.size > 1
  const ending = !mixed && endings[0] === '\r\n' ? '\r\n' : !mixed && endings[0] === '\r' ? '\r' : '\n'
  return { draft: text.replace(/\r\n?/g, '\n'), format: { bom, ending, mixed } }
}

function encodeForServer(draft: string, format: TextFormat): string {
  return `${format.bom ? '\uFEFF' : ''}${format.ending === '\n' ? draft : draft.replace(/\n/g, format.ending)}`
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

interface EditorTab { id: string; sessionId: string; path: string; label: string }
interface DocumentMeta { dirty: boolean; saving: boolean }
const documentId = (sessionId: string, path: string) => `${sessionId}\0${path}`
const fileName = (path: string) => path.split('/').filter(Boolean).at(-1) || path

export function RemoteEditor({ sessionId, path, api, onClose, requestId = 0, onSaved, visible = true, onHide, onTabCountChange, sessionLabels = {} }: {
  sessionId: string
  path: string
  api: SshHeavenApi
  onClose: () => void
  requestId?: number
  onSaved?: (sessionId: string) => void
  visible?: boolean
  onHide?: () => void
  onTabCountChange?: (count: number) => void
  sessionLabels?: Readonly<Record<string, string>>
}) {
  const initial = () => ({ id: documentId(sessionId, path), sessionId, path, label: sessionLabels[sessionId] || 'Connection' })
  const [tabs, setTabs] = useState<EditorTab[]>(() => [initial()])
  const [activeId, setActiveId] = useState(() => documentId(sessionId, path))
  const [meta, setMeta] = useState<Record<string, DocumentMeta>>({})
  const [closingAll, setClosingAll] = useState(false)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const [error, setError] = useState('')
  const closeRequests = useRef(new Map<string, () => void>())
  const tabButtons = useRef(new Map<string, HTMLButtonElement>())
  const tabStrip = useRef<HTMLDivElement>(null)
  const tabsRef = useRef(tabs); tabsRef.current = tabs
  const activeRef = useRef(activeId); activeRef.current = activeId
  const metaRef = useRef(meta); metaRef.current = meta
  const callbacks = useRef({ onClose, onSaved, onTabCountChange, sessionLabels })
  callbacks.current = { onClose, onSaved, onTabCountChange, sessionLabels }
  const open = useCallback((targetSession: string, targetPath: string) => {
    const id = documentId(targetSession, targetPath)
    if (!tabsRef.current.some((tab) => tab.id === id)) {
      if (tabsRef.current.length >= 12) { setError('Twelve files are open. Close an editor tab before opening another.'); return }
      setTabs((current) => current.some((tab) => tab.id === id) ? current : [...current, { id, sessionId: targetSession, path: targetPath, label: callbacks.current.sessionLabels[targetSession] || 'Connection' }])
    }
    setActiveId(id); setError('')
  }, [])
  useEffect(() => { open(sessionId, path) }, [sessionId, path, requestId, open])
  useEffect(() => { callbacks.current.onTabCountChange?.(tabs.length) }, [tabs.length])
  useEffect(() => {
    const strip = tabStrip.current, button = tabButtons.current.get(activeId)
    if (!strip || !button) return
    const bounds = strip.getBoundingClientRect(), tab = button.parentElement!.getBoundingClientRect()
    if (tab.left < bounds.left) strip.scrollLeft -= bounds.left - tab.left
    else if (tab.right > bounds.right) strip.scrollLeft += tab.right - bounds.right
  }, [activeId, tabs.length, visible])
  const updateMeta = useCallback((id: string, next: DocumentMeta) => {
    const current = metaRef.current
    if (current[id]?.dirty === next.dirty && current[id]?.saving === next.saving) return
    // Close requests may arrive in the same event as a document transaction.
    // Keep their guard authoritative before React paints the dirty indicator.
    metaRef.current = { ...current, [id]: next }
    setMeta(metaRef.current)
  }, [])
  const notifySaved = useCallback((id: string) => callbacks.current.onSaved?.(id), [])
  const registerClose = useCallback((id: string, callback: (() => void) | null) => { if (callback) closeRequests.current.set(id, callback); else closeRequests.current.delete(id) }, [])
  const requestTabClose = useCallback((id: string) => {
    // A document owns its confirmation. Bring an inactive dirty tab forward
    // before opening that guard so the user can review the draft being closed.
    if (metaRef.current[id]?.dirty) setActiveId(id)
    closeRequests.current.get(id)?.()
  }, [])
  const removeTab = useCallback((id: string) => {
    const current = tabsRef.current
    if (current.length === 1) { callbacks.current.onClose(); return }
    const remaining = current.filter((tab) => tab.id !== id)
    setTabs(remaining)
    setMeta((value) => { const next = { ...value }; delete next[id]; return next })
    if (activeRef.current === id) setActiveId(remaining[Math.min(current.findIndex((tab) => tab.id === id), remaining.length - 1)].id)
  }, [])
  const requestCloseAll = useCallback(() => {
    if (Object.values(metaRef.current).some((value) => value.saving)) return
    if (Object.values(metaRef.current).some((value) => value.dirty)) setClosingAll(true)
    else callbacks.current.onClose()
  }, [])
  const cancelCloseAll = useCallback(() => setClosingAll(false), [])
  const closePathForm = useCallback(() => setOpenPath(null), [])
  useEffect(() => {
    if (!visible) return
    const closeTab = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.code !== 'KeyW') return
      const top = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1)
      if (top?.getAttribute('aria-label') !== 'Remote file editor') return
      event.preventDefault(); event.stopPropagation(); requestTabClose(activeRef.current)
    }
    window.addEventListener('keydown', closeTab, true)
    return () => window.removeEventListener('keydown', closeTab, true)
  }, [visible, requestTabClose])
  const active = tabs.find((tab) => tab.id === activeId)
  return <>
    <Modal title="Remote file editor" onClose={requestCloseAll} className="remote-editor-modal" active={visible}>
      <div className="remote-editor-workspace-toolbar"><span><FileCode2 size={15} />{tabs.length} {tabs.length === 1 ? 'open file' : 'open files'}</span><div><button className="button secondary compact" aria-label="Open remote file path" onClick={() => { setOpenPath(''); setError('') }}><Plus size={14} />Open file</button>{onHide && <button className="button secondary compact" onClick={onHide}><ArrowLeft size={14} />Back to files</button>}</div></div>
      <div className="remote-editor-tabs" role="tablist" aria-label="Open remote files" ref={tabStrip}>{tabs.map((tab, index) => <div key={tab.id} className={`remote-editor-tab ${activeId === tab.id ? 'active' : ''}`}><button role="tab" id={`remote-editor-tab-${index}`} aria-selected={activeId === tab.id} aria-label={`${fileName(tab.path)} on ${tab.label}${meta[tab.id]?.dirty ? ' (unsaved changes)' : ''}`} aria-controls={`remote-editor-document-${index}`} tabIndex={activeId === tab.id ? 0 : -1} ref={(node) => { if (node) tabButtons.current.set(tab.id, node); else tabButtons.current.delete(tab.id) }} title={`${tab.label}\n${tab.path}`} onClick={() => setActiveId(tab.id)} onKeyDown={(event) => {
        if (event.key === 'Delete') { event.preventDefault(); requestTabClose(tab.id); return }
        let next = index
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
        else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
        else if (event.key === 'Home') next = 0
        else if (event.key === 'End') next = tabs.length - 1
        else return
        event.preventDefault(); setActiveId(tabs[next].id); tabButtons.current.get(tabs[next].id)?.focus({ preventScroll: true })
      }}><FileCode2 size={13} /><span>{fileName(tab.path)}<small>{tab.label}</small></span>{meta[tab.id]?.dirty && <i className="remote-editor-dirty-dot" aria-hidden="true" />}</button><button className="icon-button" aria-label={`Close ${fileName(tab.path)} on ${tab.label}`} disabled={meta[tab.id]?.saving} onClick={() => requestTabClose(tab.id)}><X size={13} /></button></div>)}</div>
      {error && <div className="remote-editor-message" role="alert">{error}</div>}
      {tabs.map((tab, index) => <EditorDocument key={tab.id} tabId={tab.id} index={index} active={visible && activeId === tab.id} sessionId={tab.sessionId} path={tab.path} api={api} onClose={removeTab} onSaved={notifySaved} onMetaChange={updateMeta} registerClose={registerClose} />)}
    </Modal>
    {visible && closingAll && <Modal title="Discard unsaved changes?" onClose={cancelCloseAll} className="small-modal"><p className="modal-description">{Object.values(meta).filter((value) => value.dirty).length} {Object.values(meta).filter((value) => value.dirty).length === 1 ? 'file has' : 'files have'} unsaved changes. Closing the editor discards those drafts.</p><div className="modal-actions"><button className="button secondary" onClick={cancelCloseAll}>Keep editing</button><button className="button danger-button" onClick={() => callbacks.current.onClose()}>Discard and close</button></div></Modal>}
    {visible && openPath !== null && <Modal title="Open remote file" onClose={closePathForm} className="small-modal"><form onSubmit={(event) => {
      event.preventDefault()
      const value = openPath.trim()
      if (!value || /\0/.test(value) || value.length > 4096 || !active) return
      const combined = value.startsWith('/') ? value : `${active.path.slice(0, active.path.lastIndexOf('/') + 1)}${value}`
      const parts: string[] = []; for (const part of combined.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part) }
      open(active.sessionId, `/${parts.join('/')}`); setOpenPath(null)
    }}><p className="modal-description">Open another text file on <strong>{active?.label}</strong>. Relative paths start beside the current file.</p><label className="field-label">Remote file path<input required value={openPath} onChange={(event) => setOpenPath(event.target.value)} maxLength={4096} autoComplete="off" spellCheck={false} placeholder="/etc/app/config.json" /></label><div className="modal-actions"><button type="button" className="button secondary" onClick={closePathForm}>Cancel</button><button className="button primary" disabled={!openPath.trim()}><FolderOpen size={15} />Open file</button></div></form></Modal>}
  </>
}

const EditorDocument = memo(function EditorDocument({ sessionId, path, api, onClose, tabId, index, active, onSaved, onMetaChange, registerClose }: {
  sessionId: string
  path: string
  api: SshHeavenApi
  onClose: (id: string) => void
  tabId: string
  index: number
  active: boolean
  onSaved: (sessionId: string) => void
  onMetaChange: (id: string, meta: DocumentMeta) => void
  registerClose: (id: string, callback: (() => void) | null) => void
}) {
  const { preset } = useTheme()
  const streamMode = useStreamMode()
  const editor = useRef<ReactCodeMirrorRef>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [file, setFile] = useState<RemoteFile | null>(null)
  const [baseline, setBaseline] = useState('')
  const baselineTree = useRef<Text | null>(null)
  const [dirty, setDirty] = useState(false)
  const [format, setFormat] = useState<TextFormat>({ bom: false, ending: '\n', mixed: false })
  const [language, setLanguage] = useState<Language>(() => detectLanguage(path))
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saved, setSaved] = useState(false)
  const [guard, setGuard] = useState<'close' | 'reload' | null>(null)
  const [review, setReview] = useState<{ content: string; version: string; draft: string; baseline: string; document: Text } | null>(null)
  const [cursor, setCursor] = useState({ line: 1, column: 1, lines: 1 })
  const operation = useRef<'read' | 'write' | null>(null)
  const generation = useRef(0)
  const current = useRef({ dirty, guard })
  current.current = { dirty, guard }
  const formatRef = useRef(format)
  const [byteCount, setByteCount] = useState(0)
  const byteCountRef = useRef(0)
  const tooLarge = byteCount > MAX_FILE_BYTES
  const saveRef = useRef<() => Promise<void>>(async () => {})
  const activeRef = useRef(active); activeRef.current = active
  useEffect(() => onMetaChange(tabId, { dirty, saving }), [tabId, dirty, saving, onMetaChange])
  const handleUpdate = useCallback((update: ViewUpdate) => {
    if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(ExternalChange))) return
    if (!baselineTree.current) baselineTree.current = update.startState.doc
    const nextDirty = !baselineTree.current.eq(update.state.doc)
    const bytes = updateDocumentBytes(byteCountRef.current, update.startState.doc, update.state.doc, update.changes, formatRef.current)
    byteCountRef.current = bytes; current.current.dirty = nextDirty
    setByteCount(bytes); setDirty(nextDirty); setSaved(false)
    onMetaChange(tabId, { dirty: nextDirty, saving: operation.current === 'write' })
  }, [onMetaChange, tabId])
  const captureEditor = useCallback((view: EditorView) => { baselineTree.current = view.state.doc }, [])
  const handleStatistics = useCallback((statistics: Statistics) => {
    const next = { line: statistics.line.number, column: statistics.selection.main.head - statistics.line.from + 1, lines: statistics.lineCount }
    setCursor((previous) => previous.line === next.line && previous.column === next.column && previous.lines === next.lines ? previous : next)
  }, [])
  const applyFile = useCallback((result: RemoteFile) => {
    const decoded = decodeForEditor(result.content)
    formatRef.current = decoded.format
    const view = editor.current?.view
    if (view && (view.state.doc.length !== decoded.draft.length || view.state.doc.toString() !== decoded.draft)) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: decoded.draft }, annotations: [ExternalChange.of(true)] })
    }
    baselineTree.current = view?.state.doc ?? null
    const bytes = stringBytes(decoded.draft, decoded.format)
    byteCountRef.current = bytes; current.current.dirty = false
    setFile(result); setBaseline(decoded.draft); setFormat(decoded.format)
    setByteCount(bytes); setDirty(false)
    onMetaChange(tabId, { dirty: false, saving: operation.current === 'write' })
  }, [onMetaChange, tabId])

  const load = useCallback(async () => {
    if (operation.current) return
    operation.current = 'read'
    const request = ++generation.current
    setLoading(true)
    setError('')
    try {
      const result = await api.readRemoteFile(sessionId, path)
      if (request !== generation.current) return
      applyFile(result)
      setConflict(false)
      setSaved(false)
    } catch (cause) {
      if (request === generation.current) setError(errorMessage(cause))
    } finally {
      if (request === generation.current) { operation.current = null; setLoading(false) }
    }
  }, [api, sessionId, path, applyFile])

  useEffect(() => {
    setLanguage(detectLanguage(path))
    void load()
    return () => { generation.current++; operation.current = null }
  }, [load, path])

  async function save(reviewed: NonNullable<typeof review>) {
    if (!file || operation.current || !dirty || tooLarge || conflict || guard) return
    if (!editor.current?.view?.state.doc.eq(reviewed.document)) { setReview(null); setError('The draft changed after review. Review the latest changes before saving.'); return }
    operation.current = 'write'
    const request = generation.current
    setSaving(true)
    setError('')
    try {
      const result = await api.saveRemoteFile(sessionId, file.path, reviewed.content, reviewed.version)
      if (request !== generation.current) return
      applyFile(result)
      setSaved(true)
      setConflict(false)
      setReview(null)
      onSaved(sessionId)
    } catch (cause) {
      if (request !== generation.current) return
      const message = errorMessage(cause)
      setConflict(/changed|conflict|version|no longer matches/i.test(message))
      setError(message)
      setReview(null)
    } finally {
      if (request === generation.current) { operation.current = null; setSaving(false) }
    }
  }
  const requestSave = async () => {
    const document = editor.current?.view?.state.doc
    if (!file || !document || operation.current || !current.current.dirty || byteCountRef.current > MAX_FILE_BYTES || conflict || current.current.guard) return
    const draft = document.toString()
    setReview({ content: encodeForServer(draft, formatRef.current), version: file.version, draft, baseline, document })
  }
  saveRef.current = requestSave

  const requestClose = useCallback(() => {
    if (operation.current === 'write') return
    if (current.current.dirty) setGuard('close')
    else onCloseRef.current(tabId)
  }, [tabId])
  const cancelGuard = useCallback(() => setGuard(null), [])
  const closeReview = useCallback(() => { if (operation.current !== 'write') setReview(null) }, [])
  useEffect(() => { registerClose(tabId, requestClose); return () => registerClose(tabId, null) }, [tabId, registerClose, requestClose])
  function requestReload() {
    if (operation.current) return
    if (dirty) setGuard('reload')
    else void load()
  }

  useEffect(() => {
    const handleSave = (event: KeyboardEvent) => {
      if (!activeRef.current || !(event.ctrlKey || event.metaKey) || event.altKey || event.code !== 'KeyS') return
      const top = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].at(-1)
      if (top?.getAttribute('aria-label') !== 'Remote file editor') return
      event.preventDefault()
      event.stopPropagation()
      void saveRef.current()
    }
    window.addEventListener('keydown', handleSave, true)
    return () => window.removeEventListener('keydown', handleSave, true)
  }, [])

  const editorTheme = useMemo(() => EditorView.theme({
    '&': { color: 'var(--text)', backgroundColor: 'var(--input)', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace', lineHeight: '1.65' },
    '.cm-content': { caretColor: 'var(--accent)', padding: '12px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--text-muted)', borderRight: '1px solid var(--border)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-active)', color: 'var(--text)' },
    '.cm-activeLine': { backgroundColor: 'var(--surface-hover)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--surface-active)' },
    '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent-border)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--surface-active)', outline: '1px solid var(--accent)' },
    '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' },
    '.cm-panels': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)', borderColor: 'var(--border)' },
    '.cm-panel.cm-search': { padding: '10px 12px', fontSize: '12px' },
    '.cm-textfield': { backgroundColor: 'var(--input)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '6px', padding: '5px 8px', fontSize: '12px' },
    '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '6px', padding: '4px 8px', fontSize: '12px' },
    '.cm-button:hover': { backgroundImage: 'none', backgroundColor: 'var(--surface-hover)' },
    '.cm-tooltip': { backgroundColor: 'var(--surface-raised)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: '8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--surface-active)', color: 'var(--text)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-raised)', color: 'var(--text-muted)', border: '1px solid var(--border)' },
  }, { dark: preset.appearance === 'dark' }), [preset.appearance])

  const highlighting = useMemo(() => syntaxHighlighting(HighlightStyle.define([
    { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: preset.terminal.magenta ?? 'var(--accent)' },
    { tag: [tags.string, tags.attributeValue, tags.regexp], color: preset.terminal.green ?? 'var(--success)' },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: preset.terminal.yellow ?? 'var(--warning)' },
    { tag: [tags.typeName, tags.className, tags.tagName], color: preset.terminal.blue ?? 'var(--accent)' },
    { tag: [tags.function(tags.variableName), tags.propertyName, tags.attributeName], color: preset.terminal.cyan ?? 'var(--accent)' },
    { tag: tags.comment, color: 'var(--text-muted)', fontStyle: 'italic' },
    { tag: [tags.heading, tags.strong], color: 'var(--text)', fontWeight: '600' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
    { tag: tags.invalid, color: 'var(--danger)' },
  ])), [preset.terminal])
  const languageExtension = useMemo(() => LANGUAGES.find((option) => option.id === language)!.extension(), [language])
  const editorKeys = useMemo(() => Prec.highest(keymap.of([
    { key: 'Mod-s', run: () => { void saveRef.current(); return true } },
    ...searchKeymap,
  ])), [])
  const extensions = useMemo(() => [
    EditorState.lineSeparator.of('\n'),
    EditorView.contentAttributes.of({ 'aria-label': 'Remote file contents', spellcheck: 'false' }),
    languageExtension, editorTheme, highlighting, editorKeys, search({ top: true }), streamPrivacyExtension(streamMode.enabled),
  ], [languageExtension, editorTheme, highlighting, editorKeys, streamMode.enabled, streamMode.rules])
  const lineEndingLabel = format.mixed ? 'Mixed endings → LF' : format.ending === '\r\n' ? 'CRLF' : format.ending === '\r' ? 'CR' : 'LF'
  const status = saving ? 'Saving to server…' : conflict ? 'Server file changed · draft preserved' : dirty ? 'Unsaved changes' : saved ? 'Saved to server' : 'Ready'

  return <>
    <section className="remote-editor-document" role="tabpanel" id={`remote-editor-document-${index}`} aria-labelledby={`remote-editor-tab-${index}`} hidden={!active}>
      <div className="remote-editor-file-heading"><FileCode2 size={17} /><span title={file?.path ?? path}>{file?.path ?? path}</span>{dirty && <span className="remote-editor-dirty-dot" aria-label="Unsaved changes" />}</div>
      <div className="remote-editor-toolbar">
        <label className="remote-editor-language">Language<select aria-label="Editor language" value={language} onChange={(event) => setLanguage(event.target.value as Language)}>{LANGUAGES.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
        <div className="remote-editor-actions">
          <button className="button secondary compact" aria-label="Find and replace" disabled={!file || loading} onClick={() => { if (editor.current?.view) openSearchPanel(editor.current.view) }}><Search size={14} /><span>Find / replace</span></button>
          <button className="button secondary compact" aria-label="Reload remote file" disabled={loading || saving} onClick={requestReload}><RotateCcw size={14} /><span>Reload</span></button>
          <button className="button primary compact" aria-label="Save remote file" disabled={!file || loading || saving || !dirty || tooLarge || conflict} onClick={() => void requestSave()}>{saving ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}<span>{saving ? 'Saving…' : 'Save'}</span><kbd>Ctrl S</kbd></button>
        </div>
      </div>
      {error && <div className={`remote-editor-message${conflict ? ' remote-editor-conflict' : ''}`} role="alert"><CircleAlert size={16} /><div>{conflict && <strong>The server file has changed. Your edits are still here.</strong>}<span>{error}</span>{conflict && <span>Reload to review the latest server version before saving.</span>}</div></div>}
      {tooLarge && <div className="remote-editor-message" role="alert"><CircleAlert size={16} /><span>This draft exceeds the 2 MiB text limit. Reduce its size before saving.</span></div>}
      <div className="remote-editor-body" aria-busy={loading} onKeyDownCapture={(event) => {
        const view = editor.current?.view
        if (event.key === 'Escape' && view && searchPanelOpen(view.state)) {
          event.preventDefault(); event.stopPropagation(); closeSearchPanel(view); view.focus()
        }
      }}>
        {loading && !file ? <div className="remote-editor-empty" role="status"><LoaderCircle className="spin" size={26} /><span>Opening remote file…</span></div>
          : !file ? <div className="remote-editor-empty"><FileCode2 size={30} /><strong>This file could not be opened.</strong><span>Choose a UTF-8 text file up to 2 MiB.</span><button className="button secondary" aria-label="Retry opening remote file" onClick={() => void load()}>Try again</button></div>
            : <CodeMirror ref={editor} className="remote-editor-code" height="100%" value={baseline} theme="none" extensions={extensions} readOnly={saving || loading} basicSetup={EDITOR_SETUP} onCreateEditor={captureEditor} onUpdate={handleUpdate} onStatistics={handleStatistics} />}
      </div>
      <footer className="remote-editor-footer"><span className={dirty ? 'remote-editor-unsaved' : ''} role="status">{loading ? 'Loading…' : status}</span><span className="remote-editor-position">Ln {cursor.line}, Col {cursor.column}</span><span>{formatSize(byteCount)}</span><span>{format.bom ? 'UTF-8 BOM' : 'UTF-8'}</span><span title={format.mixed ? 'Saving will normalize mixed line endings to LF.' : 'Original line endings are preserved when saving.'}>{lineEndingLabel}</span></footer>
    </section>
    {active && review && <SaveReview path={path} before={review.baseline} after={review.draft} busy={saving} onClose={closeReview} onSave={() => void save(review)} />}
    {active && guard && <Modal title="Discard unsaved changes?" onClose={cancelGuard} className="small-modal"><p className="modal-description">{guard === 'reload' ? 'Reloading replaces your draft with the latest version from the server.' : 'Your changes have not been saved to the server.'}</p><div className="modal-actions"><button className="button secondary" onClick={cancelGuard}>Keep editing</button><button className="button danger-button" onClick={() => { const action = guard; setGuard(null); if (action === 'reload') void load(); else onCloseRef.current(tabId) }}>{guard === 'reload' ? 'Discard and reload' : 'Discard and close'}</button></div></Modal>}
  </>
})

function SaveReview({ path, before, after, busy, onClose, onSave }: { path: string; before: string; after: string; busy: boolean; onClose: () => void; onSave: () => void }) {
  const streamMode = useStreamMode()
  const diff = useMemo(() => buildDiffPreview(before, after), [before, after])
  // The shared JSX privacy layer masks these rendered lines. Reading the store
  // here also redraws an already-open review when custom rules change.
  void streamMode.enabled; void streamMode.rules
  return <Modal title="Review file changes" onClose={onClose} className="remote-editor-review-modal"><div className="remote-editor-review-heading"><p>{path}</p><span className="diff-added">+{diff.added}</span><span className="diff-removed">−{diff.removed}</span></div><p className="modal-description">Review this file’s changes before writing to the server. The saved version is checked again when you confirm.</p><div className="remote-editor-diff" role="region" aria-label="File changes" tabIndex={0}>{diff.rows.map((row, index) => row.kind === 'omitted' ? <div key={index} className="diff-omitted">{row.count} unchanged lines</div> : <div key={index} className={`diff-line diff-${row.kind}`}><span>{row.oldLine ?? ''}</span><span>{row.newLine ?? ''}</span><b aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</b><code>{row.text || ' '}</code></div>)}</div>{(diff.truncated || diff.coarse) && <p className="remote-editor-review-limit">{diff.truncated ? 'Preview shows the first 500 lines of changes. The complete draft will be saved. ' : ''}{diff.coarse ? 'Large edits are shown as replacement blocks.' : ''}</p>}<div className="modal-actions"><button className="button secondary" disabled={busy} onClick={onClose}>Keep editing</button><button className="button primary" disabled={busy} onClick={onSave}>{busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{busy ? 'Saving…' : 'Confirm save to server'}</button></div></Modal>
}
