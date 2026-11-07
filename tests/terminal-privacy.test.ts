import assert from 'node:assert/strict'
import test from 'node:test'
import type { Terminal } from '@xterm/xterm'
import { TerminalPrivacyRenderer } from '../src/terminal-privacy'

test('private terminal reuses 10,000 immutable history rows for steady-state edits and scrolling', () => {
  const originalFrame = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0, reads = 0, translations = 0, cells = 0, resets = 0
  let base = 10_000, length = base + 24, edited = false
  const writes: string[] = []
  globalThis.requestAnimationFrame = (callback) => { const id = ++frameId; frames.set(id, callback); return id }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0) }
  const buffer = {
    type: 'normal', get baseY() { return base }, get viewportY() { return base }, get length() { return length }, cursorY: 23, cursorX: 22,
    getNullCell: () => ({}),
    getLine: (index: number) => {
      reads++
      const text = (index === length - 1 && edited ? 'edited 198.51.100.42' : `line-${index} 192.0.2.88`).padEnd(80, ' ')
      return {
        isWrapped: false, length: 80,
        translateToString: () => { translations++; return text },
        getCell: (column: number) => { cells++; return { getWidth: () => 1, getChars: () => text[column], isAttributeDefault: () => true } },
      }
    },
  }
  const raw = { cols: 80, rows: 24, buffer: { active: buffer }, modes: { mouseTrackingMode: 'none' }, registerMarker: () => ({ line: base, isDisposed: false, dispose() {} }) } as unknown as Terminal
  const visible = { buffer: { active: buffer }, reset: () => { resets++ }, write: (text: string, callback: () => void) => { writes.push(text); callback() }, scrollToBottom() {}, scrollToLine() {} } as unknown as Terminal
  const host = { dataset: {}, setAttribute() {} } as unknown as HTMLElement
  const renderer = new TerminalPrivacyRenderer(raw, visible, host, () => {})
  try {
    renderer.schedule(true); flush()
    assert.ok(translations >= 10_000, 'The initial transition must sanitize the entire existing history')
    assert.equal(writes[0].includes('192.0.2.88'), false)
    reads = 0; translations = 0; cells = 0; edited = true
    renderer.schedule(); flush()
    assert.ok(reads <= 26, `One-row editing read ${reads} rows; only the live screen should be scanned`)
    assert.ok(translations <= 24)
    assert.ok(cells <= 80 * 24)
    assert.equal(resets, 1, 'An ordinary row edit must patch the existing mirror')
    assert.equal(writes.at(-1)!.includes('198.51.100.42'), false)
    reads = 0; translations = 0; cells = 0; base++; length++
    renderer.schedule(); flush()
    assert.ok(reads <= 27, `One-line scrolling read ${reads} rows; history must remain cached`)
    assert.ok(translations <= 25)
    assert.equal(resets, 1, 'Ordinary scrolling must update incrementally')
  } finally {
    renderer.dispose(); globalThis.requestAnimationFrame = originalFrame; globalThis.cancelAnimationFrame = originalCancel
  }
})
