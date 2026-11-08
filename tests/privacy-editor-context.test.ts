import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { afterEach, test } from 'node:test'
import { EditorState } from '@codemirror/state'
import { EditorPrivacyCache, editorPrivateRanges, redactEditorClipboard } from '../src/privacy-editor'
import { findSensitiveRanges, setStreamRules } from '../src/stream-rules'

afterEach(() => setStreamRules([]))
test('display masks retain full custom/IP context across folded and partially visible ranges', () => {
  setStreamRules([{ text: 'private-production-token', caseSensitive: false }])
  const doc = 'before PRIVATE-PRODUCTION-TOKEN and 192.0.2.10 after'
  const state = EditorState.create({ doc })
  const token = doc.indexOf('PRIVATE'), ip = doc.indexOf('192')
  const spans = [{ from: token + 3, to: token + 8 }, { from: token + 17, to: token + 23 }, { from: ip + 2, to: ip + 7 }]
  assert.deepEqual(editorPrivateRanges(state, spans), spans.map((span) => ({ start: span.from, end: span.to })))
  assert.equal(state.doc.toString(), doc)
})
test('unbounded IPv6 zone context remains hidden even when only its distant tail is displayed or copied', () => {
  const doc = `before [fe80::1%${'z'.repeat(3000)}] after`
  const from = 1500, to = from + 20, state = EditorState.create({ doc, selection: { anchor: from, head: to } })
  assert.deepEqual(editorPrivateRanges(state, [{ from, to }]), [{ start: from, end: to }])
  assert.equal(redactEditorClipboard(state.sliceDoc(from, to), state), '•'.repeat(to - from))
  const ordinary = EditorState.create({ doc: `not-an-ip%${'z'.repeat(3000)}` })
  assert.deepEqual(editorPrivateRanges(ordinary, [{ from, to }]), [])
})
test('long IPv6 zones remain masked at every literal-context boundary without inventing addresses from invalid bases', () => {
  const prefix = 'ordinary;'.repeat(100), doc = `${prefix}[fe80::1%${'z'.repeat(1000)}] after`
  const state = EditorState.create({ doc })
  for (let offset = 230; offset < 350; offset++) {
    const from = prefix.length + offset, to = from + 10
    assert.deepEqual(editorPrivateRanges(state, [{ from, to }]), [{ start: from, end: to }], `zone masking failed at padding offset ${offset}`)
  }
  const invalid = EditorState.create({ doc: `${'a'.repeat(2000)}:db8::1%${'z'.repeat(1000)}` })
  assert.deepEqual(editorPrivateRanges(invalid, [{ from: 2300, to: 2310 }]), [])
})
test('maximum-length Unicode literals preserve raw contents and mask only displayed intersections', () => {
  const secret = '秘密😀'.repeat(64), doc = `${'prefix '.repeat(100)}${secret}${' suffix'.repeat(100)}`
  assert.equal(secret.length, 256)
  setStreamRules([{ text: secret, caseSensitive: true }])
  const from = doc.indexOf(secret) + 180, to = from + 50, state = EditorState.create({ doc })
  assert.deepEqual(editorPrivateRanges(state, [{ from, to }]), [{ start: from, end: to }])
  assert.equal(state.doc.toString(), doc)
})
test('a large minified document scans bounded presentation windows instead of its entire line', (context) => {
  setStreamRules(Array.from({ length: 50 }, (_, index) => ({ text: `secret-${index}.internal`, caseSensitive: true })))
  const doc = `${'safe;'.repeat(300_000)}secret-20.internal${';safe'.repeat(100_000)}`
  const at = doc.indexOf('secret-20'), state = EditorState.create({ doc })
  let scanned = 0
  const cache = new EditorPrivacyCache((value) => { scanned += value.length; return findSensitiveRanges(value) })
  const start = performance.now()
  const result = editorPrivateRanges(state, [{ from: at + 2, to: at + 8 }], cache)
  assert.deepEqual(result, [{ start: at + 2, end: at + 8 }])
  assert.ok(scanned <= 600, `A six-character span scanned ${scanned} positions`)
  context.diagnostic(`${(doc.length / 1024 / 1024).toFixed(2)} MiB-line presentation context: ${scanned} scanned UTF-16 positions, ${(performance.now() - start).toFixed(2)}ms`)
})
test('unchanged visible lines reuse bounded caches across keystrokes, but rule changes invalidate every cached result', () => {
  setStreamRules([{ text: 'private-token', caseSensitive: true }])
  const doc = Array.from({ length: 60 }, (_, index) => `row ${index}: private-token and ordinary text`).join('\n')
  let state = EditorState.create({ doc }), calls = 0
  const cache = new EditorPrivacyCache((value) => { calls++; return findSensitiveRanges(value) })
  editorPrivateRanges(state, [{ from: 0, to: state.doc.length }], cache)
  const initial = calls
  state = state.update({ changes: { from: 3, insert: 'x' } }).state
  editorPrivateRanges(state, [{ from: 0, to: state.doc.length }], cache)
  assert.equal(calls - initial, 1, 'one changed line must not rescan all sixty visible lines')
  const unchanged = calls
  setStreamRules([{ text: 'ordinary', caseSensitive: true }])
  const ranges = editorPrivateRanges(state, [{ from: 0, to: state.doc.length }], cache)
  assert.equal(calls - unchanged, 60)
  assert.equal(ranges.length, 60)
  for (const range of ranges) assert.equal(state.sliceDoc(range.start, range.end), 'ordinary')
})
test('partial clipboard extraction does not flatten or scan unrelated document contents', () => {
  setStreamRules([{ text: 'private-token', caseSensitive: false }])
  const doc = `${'safe content\n'.repeat(100_000)}private-token tail`
  const from = doc.indexOf('private-token') + 2, to = from + 6
  const state = EditorState.create({ doc, selection: { anchor: from, head: to } })
  Object.defineProperty(state.doc, 'toString', { configurable: true, value() { throw new Error('Clipboard flattened the entire unrelated document') } })
  assert.equal(redactEditorClipboard(state.sliceDoc(from, to), state), '•'.repeat(to - from))
})
