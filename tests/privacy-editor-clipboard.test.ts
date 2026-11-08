import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { EditorSelection, EditorState, Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { streamPrivacyExtension } from '../src/privacy-editor'
import { setStreamRules } from '../src/stream-rules'

afterEach(() => setStreamRules([]))
function copied(state: EditorState, value: string): string {
  return state.facet(EditorView.clipboardOutputFilter).reduce((text, filter) => filter(text, state), value)
}
function stateFor(doc: string, from: number, to: number) {
  return EditorState.create({ doc, selection: { anchor: from, head: to }, extensions: [streamPrivacyExtension(true)] })
}
test('partial IP selection masks selected sensitive positions and retains ordinary text', () => {
  const doc = 'prefix 192.0.2.10 suffix'
  const state = stateFor(doc, 0, 10)
  assert.equal(copied(state, state.sliceDoc(0, 10)), 'prefix •••')
  const partial = stateFor(doc, 8, 13)
  assert.equal(copied(partial, partial.sliceDoc(8, 13)), '•••••')
  assert.equal(partial.doc.toString(), doc)
})
test('partial custom literal selection cannot reveal all but one secret character', () => {
  setStreamRules([{ text: 'custom-secret-token', caseSensitive: false }])
  const doc = 'before CUSTOM-SECRET-TOKEN after'
  const start = doc.indexOf('CUSTOM'), end = start + 'CUSTOM-SECRET-TOKE'.length
  const state = stateFor(doc, start, end)
  assert.equal(copied(state, state.sliceDoc(start, end)), '•'.repeat(end - start))
  const ordinary = stateFor(doc, doc.indexOf('after'), doc.length)
  assert.equal(copied(ordinary, 'after'), 'after')
  assert.equal(state.doc.toString(), doc, 'Saving/running must retain the exact original document')
})
test('multiple selected fragments preserve their separator and surrounding nonsensitive text', () => {
  setStreamRules([{ text: 'secret-token', caseSensitive: true }])
  const doc = 'left 192.0.2.10 middle secret-token right'
  const start = doc.indexOf('secret-token') + 2
  const state = EditorState.create({ doc, selection: EditorSelection.create([EditorSelection.range(0, 8), EditorSelection.range(start, doc.length)], 1), extensions: [EditorState.allowMultipleSelections.of(true), streamPrivacyExtension(true)] })
  const raw = `${state.sliceDoc(0, 8)}\n${state.sliceDoc(start, doc.length)}`
  assert.equal(copied(state, raw), `left •••\n${'•'.repeat('secret-token'.length - 2)} right`)
  // CodeMirror drag exports only the main selection, not all selections.
  assert.equal(copied(state, state.sliceDoc(start, doc.length)), `${'•'.repeat('secret-token'.length - 2)} right`)
})
test('linewise copy deduplicates cursors on the same line and preserves CRLF output', () => {
  setStreamRules([{ text: 'secret-token', caseSensitive: true }])
  const lines = ['one 192.0.2.10', 'two secret-token', 'three']
  const doc = Text.of(lines)
  const state = EditorState.create({ doc, selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(2), EditorSelection.cursor(doc.line(2).from)]), extensions: [EditorState.allowMultipleSelections.of(true), EditorState.lineSeparator.of('\r\n'), streamPrivacyExtension(true)] })
  assert.equal(copied(state, `${lines[0]}\r\n${lines[1]}`), `one ${'•'.repeat(10)}\r\ntwo ${'•'.repeat(12)}`)
  assert.deepEqual(state.doc.toJSON(), lines)
})
test('disabled Stream mode does not transform clipboard output', () => {
  const state = EditorState.create({ doc: '192.0.2.10', selection: { anchor: 0, head: 3 }, extensions: [streamPrivacyExtension(false)] })
  assert.equal(copied(state, '192'), '192')
})
test('an unmappable output transform fails closed when sensitive source text exists', () => {
  setStreamRules([{ text: 'secret-token', caseSensitive: true }])
  const state = stateFor('safe secret-token suffix', 0, 5)
  const transformed = 'prefix cret-tok\r\nnext'
  assert.equal(copied(state, transformed), `${'•'.repeat(15)}\r\n${'•'.repeat(4)}`)
  const ordinary = stateFor('ordinary text', 0, 8)
  assert.equal(copied(ordinary, 'PREFIX ordinary'), 'PREFIX ordinary')
})
