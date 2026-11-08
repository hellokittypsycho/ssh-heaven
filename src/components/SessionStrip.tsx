import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, Copy, Layers, MoreHorizontal, Pin, Plus, RotateCcw, Search, TerminalSquare, X } from 'lucide-react'
import { HostIcon } from './HostIdentity'
import type { HostProfile } from '../../shared/types'
import { Modal } from './Modal'
import './SessionStrip.css'

export interface SessionStripSession {
  readonly id: string
  readonly profile: Pick<HostProfile, 'name' | 'host' | 'username' | 'group' | 'icon' | 'color' | 'notes'>
  readonly status: string
  readonly pinned?: boolean
}
export interface SessionStripProps {
  sessions: readonly SessionStripSession[]
  activeId?: string
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onPin?: (id: string) => void
  onMove?: (id: string, targetId: string) => void
  onDuplicate?: (id: string) => void
  onReopen?: () => void
}

function statusLabel(status: string): string {
  return status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting' : status === 'error' ? 'Connection failed' : status === 'disconnected' ? 'Disconnected' : status
}
function statusClass(status: string): string {
  return status === 'connected' ? 'online' : status === 'connecting' ? 'pending' : status === 'error' ? 'failed' : 'offline'
}

export function SessionStrip({ sessions, activeId, onSelect, onClose, onNew, onPin, onMove, onDuplicate, onReopen }: SessionStripProps) {
  const scroll = useRef<HTMLDivElement>(null)
  const items = useRef(new Map<string, HTMLDivElement>())
  const tabs = useRef(new Map<string, HTMLButtonElement>())
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const [focusedId, setFocusedId] = useState<string | undefined>(activeId)
  const [overflow, setOverflow] = useState({ any: false, left: false, right: false })
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [actionsId, setActionsId] = useState<string | null>(null)
  const dragging = useRef<string | null>(null)
  const actionSession = sessions.find((session) => session.id === actionsId)
  const results = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const instructionsId = useId()
  const listId = useId()
  const connectedCount = sessions.filter((session) => session.status === 'connected').length
  const sessionIds = sessions.map((session) => session.id).join('\0')
  const rovingId = sessions.some((session) => session.id === focusedId) ? focusedId : sessions.some((session) => session.id === activeId) ? activeId : sessions[0]?.id
  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase()
    return sessions.filter((session) => `${session.profile.name} ${session.profile.username} ${session.profile.host} ${session.profile.group || ''} ${statusLabel(session.status)}`.toLowerCase().includes(value))
  }, [sessions, query])

  const updateOverflow = useCallback(() => {
    const element = scroll.current
    if (!element) return
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth)
    const next = { any: maximum > 1, left: element.scrollLeft > 1, right: maximum - element.scrollLeft > 1 }
    setOverflow((previous) => previous.any === next.any && previous.left === next.left && previous.right === next.right ? previous : next)
  }, [])
  const reveal = useCallback((id: string) => {
    const element = scroll.current
    const item = items.current.get(id)
    if (!element || !item) return
    const viewport = element.getBoundingClientRect()
    const tab = item.getBoundingClientRect()
    const left = viewport.left + element.clientLeft
    const right = left + element.clientWidth
    let next = element.scrollLeft
    if (tab.left < left + 2) next += tab.left - left - 2
    else if (tab.right > right - 2) next += tab.right - right + 2
    // scrollIntoView can also move the document or a terminal's parent. Only
    // change this strip's horizontal offset, including after a window resize.
    if (Math.abs(next - element.scrollLeft) > .5) element.scrollTo({ left: Math.max(0, next), top: element.scrollTop, behavior: 'auto' })
    updateOverflow()
  }, [updateOverflow])
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    let frame = 0
    const resized = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        updateOverflow()
        if (activeRef.current) reveal(activeRef.current)
      })
    }
    const observer = new ResizeObserver(resized)
    observer.observe(element)
    resized()
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [sessionIds, updateOverflow, reveal])
  useEffect(() => {
    if (!activeId || !sessions.some((session) => session.id === activeId)) return
    setFocusedId(activeId)
    const previous = document.activeElement
    if (previous instanceof HTMLElement && scroll.current?.contains(previous) && previous.matches('[role="tab"][data-session-keyboard-focus="true"]')) {
      const next = tabs.current.get(activeId)
      if (next && next !== previous) {
        previous.removeAttribute('data-session-keyboard-focus')
        next.dataset.sessionKeyboardFocus = 'true'
        next.focus({ preventScroll: true })
      }
    }
    const frame = requestAnimationFrame(() => reveal(activeId))
    return () => cancelAnimationFrame(frame)
  }, [activeId, sessionIds, reveal])
  useEffect(() => {
    if (sessions.length) return
    setSwitcherOpen(false); setQuery(''); setFocusedId(undefined)
    setOverflow((previous) => previous.any || previous.left || previous.right ? { any: false, left: false, right: false } : previous)
  }, [sessions.length])
  const closeSwitcher = useCallback(() => { setSwitcherOpen(false); setQuery('') }, [])
  const selectFromSwitcher = (id: string) => { closeSwitcher(); setFocusedId(id); onSelect(id); requestAnimationFrame(() => reveal(id)) }
  function scrollTabs(direction: -1 | 1) {
    const element = scroll.current
    if (!element) return
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollBy({ left: direction * Math.max(180, element.clientWidth * .72), top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, id: string) {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const index = sessions.findIndex((session) => session.id === id)
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % sessions.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + sessions.length) % sessions.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = sessions.length - 1
    else if (event.key === 'Delete') { event.preventDefault(); event.stopPropagation(); onClose(id); return }
    else return
    event.preventDefault(); event.stopPropagation()
    const selected = sessions[next]
    if (!selected) return
    for (const button of tabs.current.values()) button.removeAttribute('data-session-keyboard-focus')
    const button = tabs.current.get(selected.id)
    if (button) button.dataset.sessionKeyboardFocus = 'true'
    setFocusedId(selected.id); onSelect(selected.id)
    button?.focus({ preventScroll: true })
    reveal(selected.id)
  }
  function focusResult(index: number) {
    const buttons = results.current?.querySelectorAll<HTMLButtonElement>('.session-switcher-select')
    const item = buttons?.[index]
    if (!item || !results.current) return
    item.focus({ preventScroll: true })
    const viewport = results.current.getBoundingClientRect()
    const row = item.getBoundingClientRect()
    if (row.top < viewport.top) results.current.scrollTop += row.top - viewport.top
    else if (row.bottom > viewport.bottom) results.current.scrollTop += row.bottom - viewport.bottom
  }

  if (!sessions.length) return onReopen ? <div className="tabbar ssh-session-strip"><button className="button subtle compact" onClick={onReopen}><RotateCcw size={14} />Reopen closed session</button></div> : null
  return <>
    <div className="tabbar ssh-session-strip" aria-label="SSH session strip">
      <div ref={scroll} className="ssh-session-scroll" role="tablist" aria-label="Connection sessions" aria-orientation="horizontal" aria-describedby={instructionsId} onScroll={updateOverflow}>
        {sessions.map((session) => <div key={session.id} ref={(element) => { if (element) items.current.set(session.id, element); else items.current.delete(session.id) }} className={`session-tab ${session.id === activeId ? 'active' : ''} ${session.pinned ? 'is-pinned' : ''}`} style={session.profile.color ? { borderTopColor: session.profile.color } : undefined} draggable={!!onMove} onDragStart={(event) => { dragging.current = session.id; event.dataTransfer.setData('text/ssh-heaven-session', session.id); event.dataTransfer.effectAllowed = 'move' }} onDragEnd={() => { dragging.current = null }} onDragOver={(event) => { if (dragging.current) { event.preventDefault(); event.dataTransfer.dropEffect = 'move' } }} onDrop={(event) => { event.preventDefault(); if (dragging.current) onMove?.(dragging.current, session.id); dragging.current = null }} onContextMenu={(event) => { event.preventDefault(); setActionsId(session.id) }}>
          <button type="button" role="tab" ref={(element) => { if (element) tabs.current.set(session.id, element); else tabs.current.delete(session.id) }} aria-selected={session.id === activeId} tabIndex={session.id === rovingId ? 0 : -1} className="session-tab-label" title={`${session.profile.username}@${session.profile.host} · ${statusLabel(session.status)}`} onFocus={(event) => { setFocusedId(session.id); if (event.currentTarget.matches(':focus-visible')) event.currentTarget.dataset.sessionKeyboardFocus = 'true' }} onBlur={(event) => event.currentTarget.removeAttribute('data-session-keyboard-focus')} onClick={(event) => { for (const button of tabs.current.values()) button.removeAttribute('data-session-keyboard-focus'); if (event.detail === 0) event.currentTarget.dataset.sessionKeyboardFocus = 'true'; onSelect(session.id); requestAnimationFrame(() => reveal(session.id)) }} onKeyDown={(event) => { if (event.key === 'F10' && event.shiftKey) { event.preventDefault(); setActionsId(session.id) } else navigate(event, session.id) }}><span className={`status-dot ${statusClass(session.status)}`} aria-hidden="true" /><HostIcon profile={session.profile} size={13} />{session.pinned && <Pin size={11} aria-label="Pinned session" />}<span>{session.profile.name}</span></button>
          <button type="button" className="tab-actions" aria-label={`Session actions for ${session.profile.name}`} title="Session actions" onClick={() => setActionsId(session.id)}><MoreHorizontal size={14} /></button><button type="button" className="tab-close" tabIndex={-1} aria-label={`Close ${session.profile.name} session`} title="Close session" onClick={() => onClose(session.id)}><X size={13} /></button>
        </div>)}
      </div>
      <div className="ssh-session-controls">{onReopen && <button className="ssh-session-new" aria-label="Reopen closed session" title="Reopen closed session" onClick={onReopen}><RotateCcw size={15} /></button>}
        {overflow.any && <div className="ssh-session-scroll-controls"><button type="button" aria-label="Scroll sessions left" title="Scroll sessions left" disabled={!overflow.left} onClick={() => scrollTabs(-1)}><ChevronLeft size={16} /></button><button type="button" aria-label="Scroll sessions right" title="Scroll sessions right" disabled={!overflow.right} onClick={() => scrollTabs(1)}><ChevronRight size={16} /></button></div>}
        <button type="button" className="ssh-session-new" aria-label="Open a new connection" title="New SSH connection" onClick={onNew}><Plus size={17} /></button>
        <button type="button" className="ssh-session-menu" aria-label="All sessions" aria-description={`${connectedCount} active ${connectedCount === 1 ? 'session' : 'sessions'}; ${sessions.length} open ${sessions.length === 1 ? 'session' : 'sessions'}`} title="Find an SSH session" aria-haspopup="dialog" aria-expanded={switcherOpen} onClick={() => { setQuery(''); setSwitcherOpen(true) }}><Layers size={15} /><span className="session-count" role="status" aria-label="SSH session summary" aria-live="off" title={`${connectedCount} active ${connectedCount === 1 ? 'session' : 'sessions'}`}><span className={`status-dot ${connectedCount ? 'online' : 'offline'}`} aria-hidden="true" />{connectedCount} online</span><span className="ssh-session-total" aria-hidden="true">{sessions.length}</span><ChevronDown size={12} /></button>
      </div>
      <span id={instructionsId} className="ssh-session-sr-only">Use Left and Right arrows, Home or End to switch sessions. Delete closes the focused session.</span>
    </div>
    {actionSession && <Modal title="Session actions" onClose={() => setActionsId(null)} className="small-modal"><p className="modal-description">{actionSession.profile.name}</p>{actionSession.profile.notes && <p className="session-host-notes">{actionSession.profile.notes}</p>}<div className="session-action-list"><button className="button secondary" onClick={() => { onPin?.(actionSession.id); setActionsId(null) }}><Pin size={14} />{actionSession.pinned ? 'Unpin session' : 'Pin session'}</button><button className="button secondary" onClick={() => { onDuplicate?.(actionSession.id); setActionsId(null) }}><Copy size={14} />Duplicate connection</button>{([-1, 1] as const).map((direction) => { const index = sessions.findIndex((item) => item.id === actionSession.id), neighbor = sessions[index + direction]; return <button key={direction} className="button secondary" disabled={!neighbor || !!neighbor.pinned !== !!actionSession.pinned} onClick={() => { if (neighbor) onMove?.(actionSession.id, neighbor.id); setActionsId(null) }}>{direction < 0 ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}{direction < 0 ? 'Move session earlier' : 'Move session later'}</button> })}<button className="button danger-button" onClick={() => { onClose(actionSession.id); setActionsId(null) }}><X size={14} />Close session</button></div></Modal>}
    {switcherOpen && <Modal title="All sessions" onClose={closeSwitcher} className="session-switcher-modal">
      <div className="session-switcher-search"><Search size={18} /><input ref={searchInput} type="search" aria-label="Search sessions" aria-controls={listId} autoComplete="off" spellCheck={false} placeholder="Find by nickname, host, user, or group…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && filtered.length) { event.preventDefault(); focusResult(0) }
        if (event.key === 'Enter' && filtered[0]) { event.preventDefault(); selectFromSwitcher(filtered[0].id) }
      }} />{query && <button type="button" aria-label="Clear session search" onClick={() => { setQuery(''); searchInput.current?.focus({ preventScroll: true }) }}><X size={14} /></button>}</div>
      <div id={listId} ref={results} className="session-switcher-results" role="list" aria-label="Matching sessions">
        {filtered.map((session, index) => <div key={session.id} role="listitem" className={`session-switcher-row ${session.id === activeId ? 'is-current' : ''}`}>
          <button type="button" className="session-switcher-select" aria-label={`Select ${session.profile.name} session`} aria-current={session.id === activeId ? 'true' : undefined} onClick={() => selectFromSwitcher(session.id)} onKeyDown={(event) => {
            if (event.ctrlKey || event.altKey || event.metaKey) return
            if (event.key === 'ArrowDown') { event.preventDefault(); focusResult((index + 1) % filtered.length) }
            if (event.key === 'ArrowUp') { event.preventDefault(); if (index === 0) searchInput.current?.focus({ preventScroll: true }); else focusResult(index - 1) }
          }}><span className="session-switcher-icon"><TerminalSquare size={18} /></span><span className="session-switcher-detail"><strong>{session.profile.name}</strong><small>{session.profile.group && <span className="session-switcher-group">{session.profile.group}<span aria-hidden="true"> · </span></span>}{session.profile.username}@{session.profile.host}</small></span><span className="session-switcher-status"><span className={`status-dot ${statusClass(session.status)}`} aria-hidden="true" />{statusLabel(session.status)}</span></button>
          <button type="button" className="session-switcher-close" aria-label={`Close ${session.profile.name} from session list`} title="Close session" onClick={() => onClose(session.id)}><X size={15} /></button>
        </div>)}
        {!filtered.length && <div className="session-switcher-empty"><Search size={25} /><strong>No matching sessions</strong><span>Try another nickname, address, or group.</span></div>}
      </div>
      <footer className="session-switcher-footer"><span>{filtered.length === sessions.length ? `${sessions.length} open ${sessions.length === 1 ? 'session' : 'sessions'}` : `${filtered.length} of ${sessions.length} sessions`}</span><span><kbd>Enter</kbd> Open first match</span></footer>
    </Modal>}
  </>
}
