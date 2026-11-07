import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search'
import { ArrowDown, ArrowDownToLine, ArrowUp, Eraser, Minus, Plus, Search, X } from 'lucide-react'
import { useTheme } from '../theme'
import { useWallpaper } from '../wallpaper'
import { isStreamModeEnabled, useStreamMode } from '../stream-mode'
import { redactIPs } from '../../shared/ip-redaction'
import { TerminalPrivacyRenderer } from '../terminal-privacy'
import '@xterm/xterm/css/xterm.css'
import './terminal.css'

const DEFAULT_FONT_SIZE = 13
const MIN_FONT_SIZE = 10
const MAX_FONT_SIZE = 24
const FONT_SIZE_KEY = 'ssh-heaven:terminal-font-size'
const FONT_SIZE_EVENT = 'ssh-heaven:terminal-font-size-change'
const SEARCH_HIGHLIGHT_LIMIT = 1000
// Search decorations require opaque six-digit hex colors. Composite the
// terminal's selection tint against its background when a preset uses alpha.
function opaqueTerminalColor(value: string | undefined, background?: string): string | undefined {
  if (!value) return undefined
  let hex = value.replace(/^#/, '')
  if (/^[\da-f]{3,4}$/i.test(hex)) hex = [...hex].map((digit) => digit.repeat(2)).join('')
  if (!/^[\da-f]{6}(?:[\da-f]{2})?$/i.test(hex)) return undefined
  if (hex.length === 6) return `#${hex}`
  const base = opaqueTerminalColor(background)?.slice(1)
  if (!base) return `#${hex.slice(0, 6)}`
  const alpha = parseInt(hex.slice(6), 16) / 255
  return `#${[0, 2, 4].map((index) => Math.round(parseInt(hex.slice(index, index + 2), 16) * alpha + parseInt(base.slice(index, index + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
}

function terminalSearchDecorations(theme: ITheme): ISearchOptions['decorations'] {
  const accent = opaqueTerminalColor(theme.cursor ?? theme.foreground) ?? ''
  const selection = opaqueTerminalColor(theme.selectionBackground, theme.background)
  return {
    matchBackground: selection,
    matchBorder: opaqueTerminalColor(theme.brightBlack),
    matchOverviewRuler: accent,
    activeMatchBackground: selection,
    activeMatchBorder: accent,
    activeMatchColorOverviewRuler: accent,
  }
}

function storedFontSize(): number {
  try {
    const size = Number(localStorage.getItem(FONT_SIZE_KEY))
    if (Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) return size
  } catch { /* Font preferences are optional when browser storage is unavailable. */ }
  return DEFAULT_FONT_SIZE
}

function dialogIsOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"]'))
}

export interface TerminalTransport {
  history: (sessionId: string) => Uint8Array[]
  subscribe: (sessionId: string, listener: (data: Uint8Array) => void) => () => void
  write: (sessionId: string, data: string) => Promise<void>
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>
  readClipboard: () => Promise<string>
  writeClipboard: (text: string) => Promise<void>
}

export function TerminalView({ sessionId, active, connected, transport, onError }: {
  sessionId: string
  active: boolean
  connected: boolean
  transport: TerminalTransport
  onError: (error: unknown) => void
}) {
  const { preset } = useTheme()
  const streamMode = useStreamMode()
  const wallpaper = useWallpaper()
  const wallpaperActive = wallpaper.enabled && !!wallpaper.assetUrl
  const terminalTheme = wallpaperActive ? { ...preset.terminal, background: '#00000000' } : preset.terminal
  const themeRef = useRef(terminalTheme)
  const searchDecorationsRef = useRef(terminalSearchDecorations(preset.terminal))
  themeRef.current = terminalTheme
  searchDecorationsRef.current = terminalSearchDecorations(preset.terminal)
  const wrapper = useRef<HTMLDivElement>(null)
  const container = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const rawTerminalRef = useRef<Terminal | null>(null)
  const privacyRendererRef = useRef<TerminalPrivacyRenderer | null>(null)
  const switchPrivacyRef = useRef<((enabled: boolean) => void) | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchRef = useRef<SearchAddon | null>(null)
  const errorRef = useRef(onError)
  const activeRef = useRef(active)
  const connectedRef = useRef(connected)
  const [fontSize, setFontSize] = useState(storedFontSize)
  const fontSizeRef = useRef(fontSize)
  const [searchOpen, setSearchOpen] = useState(false)
  const [scrolledBack, setScrolledBack] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [results, setResults] = useState({ resultIndex: -1, resultCount: 0 })
  const searchStateRef = useRef({ open: searchOpen, query, caseSensitive })
  errorRef.current = onError
  activeRef.current = active
  connectedRef.current = connected
  fontSizeRef.current = fontSize
  searchStateRef.current = { open: searchOpen, query, caseSensitive }

  const runSearch = useCallback((direction: 'next' | 'previous', incremental = false) => {
    const search = searchRef.current
    const state = searchStateRef.current
    if (!search) return
    if (!state.open || !state.query) {
      search.clearDecorations()
      terminalRef.current?.clearSelection()
      setResults({ resultIndex: -1, resultCount: 0 })
      return
    }
    const options: ISearchOptions = { caseSensitive: state.caseSensitive, incremental, decorations: searchDecorationsRef.current }
    try {
      if (direction === 'previous') search.findPrevious(state.query, options)
      else search.findNext(state.query, options)
    } catch (error) { errorRef.current(error) }
  }, [])

  const closeSearch = () => {
    setSearchOpen(false)
    searchRef.current?.clearDecorations()
    terminalRef.current?.clearSelection()
    if (activeRef.current && !dialogIsOpen()) terminalRef.current?.focus()
  }

  const changeFontSize = (size: number) => {
    const bounded = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size))
    setFontSize(bounded)
    try { localStorage.setItem(FONT_SIZE_KEY, String(bounded)) } catch { /* Keep the current-session preference. */ }
    // Apply the preference to the other terminal tabs in this window as well.
    window.dispatchEvent(new CustomEvent<number>(FONT_SIZE_EVENT, { detail: bounded }))
  }

  const clearView = () => {
    searchRef.current?.clearDecorations()
    rawTerminalRef.current?.clear()
    if (privacyRendererRef.current) privacyRendererRef.current.schedule(true)
    if (searchStateRef.current.open) runSearch('next', true)
  }

  const jumpToLatest = () => {
    terminalRef.current?.scrollToBottom()
    setScrolledBack(false)
    if (activeRef.current && !dialogIsOpen()) terminalRef.current?.focus()
  }

  useEffect(() => {
    if (!container.current) return
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, monospace',
      fontSize: fontSizeRef.current,
      lineHeight: 1.3,
      scrollback: 10000,
      // The official search addon's match decorations use this xterm API.
      allowProposedApi: true,
      // Enable once so wallpaper changes update the existing terminal in place.
      allowTransparency: true,
      disableStdin: !connectedRef.current,
      theme: themeRef.current
    })
    const fit = new FitAddon()
    const search = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT })
    const extraModes = new Map<number, boolean>()
    const trackModes = (enabled: boolean) => (parameters: (number | number[])[]) => {
      for (const value of parameters.flat()) if ([25, 1005, 1006, 1007, 1015, 1016].includes(value)) extraModes.set(value, enabled)
      return false // Observe the public parser hook, then let xterm handle it.
    }
    const setModes = terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, trackModes(true))
    const resetModes = terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, trackModes(false))
    terminal.loadAddon(fit)
    terminal.loadAddon(search)
    terminal.open(container.current)
    rawTerminalRef.current = terminal
    terminalRef.current = terminal
    fitRef.current = fit
    searchRef.current = search
    const searchResults = search.onDidChangeResults(setResults)
    const updateScrollPosition = () => {
      const visible = terminalRef.current
      if (visible) setScrolledBack(visible.buffer.active.viewportY < visible.buffer.active.baseY)
    }
    const scroll = terminal.onScroll(updateScrollPosition)
    const parsed = terminal.onWriteParsed(() => { if (privacyRendererRef.current) privacyRendererRef.current.schedule(); else updateScrollPosition() })
    for (const chunk of transport.history(sessionId)) terminal.write(chunk)
    const unsubscribe = transport.subscribe(sessionId, (data) => terminal.write(data))
    const bindInput = (target: Terminal) => {
      const input = target.onData((data) => {
        if (connectedRef.current) void transport.write(sessionId, data).catch(errorRef.current)
      })
      target.attachCustomKeyEventHandler((event) => {
        if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
          event.preventDefault(); event.stopPropagation()
          const selected = target.getSelection()
          const text = isStreamModeEnabled() ? redactIPs(selected) : selected
          if (text) void transport.writeClipboard(text).catch(errorRef.current)
          return false
        }
        if (event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
          // Returning false stops xterm's key parser; preventDefault also stops
          // the browser from issuing a second native paste for this shortcut.
          event.preventDefault(); event.stopPropagation()
          if (connectedRef.current) void transport.readClipboard().then((text) => target.paste(text)).catch(errorRef.current)
          return false
        }
        return true
      })
      return () => input.dispose()
    }
    const stopInput = bindInput(terminal)
    const resize = terminal.onResize(({ cols, rows }) => {
      updateScrollPosition()
      if (connectedRef.current) void transport.resize(sessionId, cols, rows).catch(errorRef.current)
    })
    let privacy: { terminal: Terminal; dispose: () => void } | undefined
    const switchPrivacy = (enabled: boolean) => {
      const host = container.current
      if (!host || enabled === !!privacy) return
      host.dataset.streamReady = 'false'
      terminal.clearSelection(); window.getSelection()?.removeAllRanges()
      if (enabled) {
        terminal.element?.remove()
        const masked = new Terminal({ ...terminal.options, cols: terminal.cols, rows: terminal.rows, theme: themeRef.current, fontSize: fontSizeRef.current })
        const maskedFit = new FitAddon(), maskedSearch = new SearchAddon({ highlightLimit: SEARCH_HIGHLIGHT_LIMIT })
        masked.loadAddon(maskedFit); masked.loadAddon(maskedSearch); masked.open(host)
        terminalRef.current = masked; fitRef.current = maskedFit; searchRef.current = maskedSearch
        const stopMaskedInput = bindInput(masked)
        const maskedScroll = masked.onScroll(updateScrollPosition)
        const maskedResults = maskedSearch.onDidChangeResults(setResults)
        const maskedResize = masked.onResize(({ cols, rows }) => { terminal.resize(cols, rows); privacyRendererRef.current?.schedule(true) })
        const renderer = new TerminalPrivacyRenderer(terminal, masked, host, () => {
          updateScrollPosition()
          if (searchStateRef.current.open && searchStateRef.current.query) runSearch('next', true)
        }, extraModes)
        privacyRendererRef.current = renderer
        privacy = { terminal: masked, dispose: () => { renderer.dispose(); stopMaskedInput(); maskedScroll.dispose(); maskedResults.dispose(); maskedResize.dispose(); masked.dispose() } }
        if (host.clientWidth && host.clientHeight) maskedFit.fit()
        renderer.schedule(true)
      } else {
        const viewport = privacy!.terminal.buffer.active.viewportY
        privacy!.dispose(); privacy = undefined; privacyRendererRef.current = null
        if (terminal.element) host.append(terminal.element)
        terminalRef.current = terminal; fitRef.current = fit; searchRef.current = search
        terminal.options.theme = themeRef.current; terminal.options.fontSize = fontSizeRef.current; terminal.options.disableStdin = !connectedRef.current
        if (host.clientWidth && host.clientHeight) fit.fit()
        terminal.scrollToLine(viewport); terminal.refresh(0, terminal.rows - 1)
        updateScrollPosition()
        if (searchStateRef.current.open && searchStateRef.current.query) runSearch('next', true)
      }
    }
    switchPrivacyRef.current = switchPrivacy
    const copy = (event: ClipboardEvent) => {
      if (!isStreamModeEnabled()) return
      const selected = terminalRef.current?.getSelection()
      if (!selected || !event.clipboardData) return
      event.preventDefault(); event.stopPropagation()
      event.clipboardData.setData('text/plain', redactIPs(selected))
    }
    container.current.addEventListener('copy', copy, true)
    let fitFrame = 0
    const fitVisibleTerminal = () => {
      if (container.current?.clientWidth && container.current.clientHeight) { fitRef.current?.fit(); privacyRendererRef.current?.schedule() }
    }
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(fitFrame)
      fitFrame = requestAnimationFrame(fitVisibleTerminal)
    })
    observer.observe(container.current)
    fitVisibleTerminal()
    if (isStreamModeEnabled()) switchPrivacy(true)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(fitFrame)
      unsubscribe()
      container.current?.removeEventListener('copy', copy, true)
      privacy?.dispose(); privacyRendererRef.current = null; switchPrivacyRef.current = null
      stopInput()
      setModes.dispose(); resetModes.dispose()
      resize.dispose()
      scroll.dispose()
      parsed.dispose()
      searchResults.dispose()
      terminal.dispose()
      terminalRef.current = null
      rawTerminalRef.current = null
      fitRef.current = null
      searchRef.current = null
    }
  }, [sessionId, transport, runSearch])

  useEffect(() => { switchPrivacyRef.current?.(streamMode.enabled) }, [streamMode.enabled])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = wallpaperActive ? { ...preset.terminal, background: '#00000000' } : preset.terminal
    searchRef.current?.clearDecorations()
    if (searchStateRef.current.open && searchStateRef.current.query) runSearch('next', true)
  }, [preset.terminal, wallpaperActive, runSearch])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !connected
    if (rawTerminalRef.current) rawTerminalRef.current.options.disableStdin = !connected
    const frame = requestAnimationFrame(() => {
      if (!container.current?.clientWidth || !container.current.clientHeight) return
      fitRef.current?.fit()
      const focused = document.activeElement
      const editing = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement || (focused instanceof HTMLElement && focused.isContentEditable)
      const navigatingSessions = focused instanceof HTMLElement && focused.matches('[role="tab"][data-session-keyboard-focus="true"]')
      // Resizing or connecting must not pull focus from search, file paths, or dialogs.
      // Keyboard session navigation keeps its roving tab focus; pointer-selected
      // tabs continue to hand focus to their terminal for immediate typing.
      if (active && !dialogIsOpen() && !editing && !navigatingSessions && !wrapper.current?.contains(focused)) terminalRef.current?.focus()
      if (connected && terminalRef.current) {
        const terminal = terminalRef.current
        void transport.resize(sessionId, terminal.cols, terminal.rows).catch(errorRef.current)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [active, connected, sessionId, transport])

  useEffect(() => {
    const update = () => setFontSize(storedFontSize())
    const updateInWindow = (event: Event) => {
      const size = (event as CustomEvent<number>).detail
      if (Number.isInteger(size) && size >= MIN_FONT_SIZE && size <= MAX_FONT_SIZE) setFontSize(size)
    }
    window.addEventListener('storage', update)
    window.addEventListener(FONT_SIZE_EVENT, updateInWindow)
    return () => {
      window.removeEventListener('storage', update)
      window.removeEventListener(FONT_SIZE_EVENT, updateInWindow)
    }
  }, [])

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.fontSize = fontSize
    const frame = requestAnimationFrame(() => {
      if (container.current?.clientWidth && container.current.clientHeight) fitRef.current?.fit()
    })
    return () => cancelAnimationFrame(frame)
  }, [fontSize])

  useEffect(() => {
    const timer = setTimeout(() => runSearch('next', true), 80)
    return () => clearTimeout(timer)
  }, [searchOpen, query, caseSensitive, runSearch])

  useEffect(() => {
    if (!active) return
    const openFromKeyboard = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyF' && !dialogIsOpen()) {
        event.preventDefault()
        event.stopPropagation()
        setSearchOpen(true)
        requestAnimationFrame(() => { searchInput.current?.focus(); searchInput.current?.select() })
      }
    }
    window.addEventListener('keydown', openFromKeyboard, true)
    return () => window.removeEventListener('keydown', openFromKeyboard, true)
  }, [active])

  useEffect(() => {
    if (!active || !searchOpen || dialogIsOpen()) return
    searchInput.current?.focus()
    searchInput.current?.select()
  }, [active, searchOpen])

  const resultText = !query ? 'Type to search' : results.resultCount === 0 ? 'No matches'
    : results.resultIndex < 0 ? `${results.resultCount}+ matches` : `${results.resultIndex + 1} of ${results.resultCount}`

  return <div ref={wrapper} className="ssh-terminal">
    <div className="ssh-terminal-toolbar" role="toolbar" aria-label="Terminal tools">
      <div className="ssh-terminal-tool-group">
        <button type="button" className="ssh-terminal-button" title="Search terminal (Ctrl+Shift+F)" aria-label="Search terminal" aria-expanded={searchOpen} aria-controls={`terminal-search-${sessionId}`} onClick={() => setSearchOpen((open) => !open)}><Search size={13} /><span>Search</span></button>
        <button type="button" className="ssh-terminal-button" title="Clear terminal scrollback and view" aria-label="Clear terminal view" onClick={clearView}><Eraser size={13} /><span>Clear</span></button>
      </div>
      <div className="ssh-terminal-font-tools" role="group" aria-label="Terminal font size controls">
        <span className="ssh-terminal-font-label">Font</span>
        <button type="button" className="ssh-terminal-button ssh-terminal-square" title="Decrease font size" aria-label="Decrease terminal font size" disabled={fontSize <= MIN_FONT_SIZE} onClick={() => changeFontSize(fontSize - 1)}><Minus size={13} /></button>
        <button type="button" className="ssh-terminal-button ssh-terminal-font-value" title={`Reset font size (${DEFAULT_FONT_SIZE} px)`} aria-label="Reset terminal font size" onClick={() => changeFontSize(DEFAULT_FONT_SIZE)}><output aria-label="Terminal font size">{fontSize}px</output></button>
        <button type="button" className="ssh-terminal-button ssh-terminal-square" title="Increase font size" aria-label="Increase terminal font size" disabled={fontSize >= MAX_FONT_SIZE} onClick={() => changeFontSize(fontSize + 1)}><Plus size={13} /></button>
      </div>
    </div>
    {searchOpen && <div id={`terminal-search-${sessionId}`} className="ssh-terminal-search" role="search" aria-label="Terminal scrollback search">
      <div className="ssh-terminal-search-input">
        <Search size={13} />
        <input ref={searchInput} type={streamMode.enabled ? 'password' : 'text'} aria-label="Find in terminal" placeholder="Find in terminal" value={query} maxLength={500} spellCheck={false} autoComplete="off" onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); runSearch(event.shiftKey ? 'previous' : 'next') }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch() }
        }} />
      </div>
      <output className={`ssh-terminal-search-results${query && results.resultCount === 0 ? ' no-matches' : ''}`} aria-label="Terminal search results" aria-live="polite">{resultText}</output>
      <div className="ssh-terminal-tool-group">
        <button type="button" className="ssh-terminal-button ssh-terminal-square ssh-terminal-match-case" title="Match case" aria-label="Match case" aria-pressed={caseSensitive} onClick={() => setCaseSensitive((value) => !value)}>Aa</button>
        <button type="button" className="ssh-terminal-button ssh-terminal-square" title="Previous match (Shift+Enter)" aria-label="Previous terminal match" disabled={!query || results.resultCount === 0} onClick={() => runSearch('previous')}><ArrowUp size={13} /></button>
        <button type="button" className="ssh-terminal-button ssh-terminal-square" title="Next match (Enter)" aria-label="Next terminal match" disabled={!query || results.resultCount === 0} onClick={() => runSearch('next')}><ArrowDown size={13} /></button>
        <button type="button" className="ssh-terminal-button ssh-terminal-square" title="Close terminal search (Escape)" aria-label="Close terminal search" onClick={closeSearch}><X size={13} /></button>
      </div>
    </div>}
    <div className="terminal-surface ssh-terminal-surface" aria-label="SSH terminal">
      {/* FitAddon measures its immediate parent's box. Keep the visual inset
          outside this padding-free host so every fitted row remains visible. */}
      <div ref={container} className="ssh-terminal-host" />
      {scrolledBack && <button type="button" className="ssh-terminal-latest" aria-label="Jump to latest output" onClick={jumpToLatest}><ArrowDownToLine size={14} />Latest output</button>}
    </div>
  </div>
}
