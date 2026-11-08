import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { afterEach, test } from 'node:test'
import type { Terminal } from '@xterm/xterm'
import { TerminalPrivacyRenderer } from '../src/terminal-privacy'
import { setStreamRules } from '../src/stream-rules'

afterEach(() => setStreamRules([]))
function scheduler() {
  const original = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>(); let id = 0
  globalThis.requestAnimationFrame = (callback) => { frames.set(++id, callback); return id }
  globalThis.cancelAnimationFrame = (value) => { frames.delete(value) }
  return { frames, flush() { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0) }, close() { globalThis.requestAnimationFrame = original; globalThis.cancelAnimationFrame = cancel } }
}
function pane(delayed = false) {
  let reads = 0, selectionClears = 0, ready = 0, text = 'alpha beta 192.0.2.88'
  const writes: string[] = [], callbacks: (() => void)[] = []
  const buffer = { type: 'normal', baseY: 0, viewportY: 0, length: 24, cursorY: 0, cursorX: 5, getNullCell: () => ({}), getLine: () => {
    reads++; const value = text.padEnd(80, ' ')
    return { isWrapped: false, translateToString: () => value, getCell: (column: number) => ({ getWidth: () => 1, getChars: () => value[column], isAttributeDefault: () => true }) }
  } }
  const raw = { cols: 80, rows: 24, buffer: { active: buffer }, modes: { mouseTrackingMode: 'none' }, registerMarker: () => ({ line: 0, isDisposed: false, dispose() {} }) } as unknown as Terminal
  const mirror = { buffer: { active: buffer }, reset() {}, clearSelection() { selectionClears++ }, write(output: string, callback: () => void) { writes.push(output); if (delayed) callbacks.push(callback); else callback() }, scrollToBottom() {}, scrollToLine() {} } as unknown as Terminal
  const host = { dataset: {} as Record<string, string>, setAttribute() {} } as unknown as HTMLElement
  const renderer = new TerminalPrivacyRenderer(raw, mirror, host, () => { ready++ })
  return { renderer, writes, callbacks, host, get reads() { return reads }, get selectionClears() { return selectionClears }, get ready() { return ready }, set text(value: string) { text = value } }
}
test('twenty hidden terminal panes perform no snapshots, frames, writes, or custom-rule scans', (context) => {
  const clock = scheduler(), panes = Array.from({ length: 20 }, () => pane())
  try {
    setStreamRules(Array.from({ length: 50 }, (_, index) => ({ text: `hidden-${index}.internal`, caseSensitive: false })))
    const start = performance.now()
    for (const item of panes) item.renderer.setVisible(false)
    for (let burst = 0; burst < 100; burst++) for (const item of panes) { item.text = `updated ${burst} hidden-24.internal 203.0.113.5`; item.renderer.schedule() }
    clock.flush()
    assert.equal(clock.frames.size, 0)
    assert.equal(panes.reduce((sum, item) => sum + item.reads, 0), 0)
    assert.equal(panes.reduce((sum, item) => sum + item.writes.length, 0), 0)
    context.diagnostic(`20 panes / 2,000 hidden output invalidations: ${(performance.now() - start).toFixed(2)}ms, zero buffer reads or mirror writes`)
    panes[0].renderer.setVisible(true); clock.flush()
    assert.equal(panes[0].host.dataset.streamReady, 'true')
    assert.ok(panes[0].reads > 0)
    assert.equal(panes[0].writes[0].includes('hidden-24.internal'), false)
    assert.equal(panes[0].writes[0].includes('203.0.113.5'), false)
    assert.ok(panes.slice(1).every((item) => item.reads === 0 && item.writes.length === 0))
  } finally { for (const item of panes) item.renderer.dispose(); clock.close() }
})
test('hidden or rule-stale asynchronous writes cannot reveal a pane; catchup uses current rules before readiness', () => {
  const clock = scheduler(), item = pane(true)
  try {
    setStreamRules([{ text: 'alpha', caseSensitive: true }])
    item.renderer.schedule(true); clock.flush()
    assert.equal(item.callbacks.length, 1)
    item.renderer.setVisible(false)
    item.text = 'alpha beta 198.51.100.42'
    setStreamRules([{ text: 'beta', caseSensitive: true }]); item.renderer.refreshRules()
    item.renderer.schedule(); clock.flush()
    assert.equal(item.writes.length, 1)
    item.callbacks.shift()!()
    assert.equal(item.host.dataset.streamReady, 'false'); assert.equal(item.ready, 0); assert.equal(clock.frames.size, 0)
    item.renderer.setVisible(true); clock.flush()
    assert.equal(item.writes.length, 2)
    assert.equal(item.writes[1].includes('beta'), false); assert.equal(item.writes[1].includes('198.51.100.42'), false)
    assert.equal(item.host.dataset.streamReady, 'false')
    // Change rules once more while this write is in flight.
    setStreamRules([{ text: 'alpha', caseSensitive: true }, { text: 'beta', caseSensitive: true }]); item.renderer.refreshRules()
    item.callbacks.shift()!()
    assert.equal(item.host.dataset.streamReady, 'false'); assert.equal(item.ready, 0)
    clock.flush(); item.callbacks.shift()!()
    assert.equal(item.host.dataset.streamReady, 'true'); assert.equal(item.ready, 1)
    assert.ok(item.selectionClears >= 3, 'old selections must not survive hidden/rule-stale mirrors')
  } finally { item.renderer.dispose(); clock.close() }
})
