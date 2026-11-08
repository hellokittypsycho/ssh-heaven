import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, Text } from '@codemirror/state'
import { documentBytes, stringBytes, updateDocumentBytes, type TextFormat } from '../src/editor-text'
const formats: TextFormat[] = [{ bom: false, ending: '\n', mixed: false }, { bom: true, ending: '\r\n', mixed: false }, { bom: false, ending: '\r', mixed: false }]
const encoded = (value: string, format: TextFormat) => new TextEncoder().encode(`${format.bom ? '\uFEFF' : ''}${value.replace(/\n/g, format.ending)}`).length
test('UTF-8 budgets match native serialization across BOM/endings and Unicode', () => {
  for (const format of formats) for (const value of ['', 'plain\nnext\n', 'é中😀\n', '\ud800x\udc00\n']) {
    assert.equal(stringBytes(value, format), encoded(value, format))
    assert.equal(documentBytes(Text.of(value.split('\n')), format), encoded(value, format))
  }
})
test('incremental budgets stay exact for simultaneous edits, undo-shaped replacements and surrogate boundaries', () => {
  for (const format of formats) {
    let state = EditorState.create({ doc: 'first\né中😀\nlast\ud800' })
    let bytes = documentBytes(state.doc, format)
    const changes = [
      [{ from: 0, to: 1, insert: 'F' }, { from: 13, to: 14, insert: '\nnew' }],
      [{ from: state.doc.length, insert: '\udc00' }],
      [{ from: 9, to: 10, insert: '' }],
      [{ from: 2, insert: '😀\n' }],
    ]
    for (const change of changes) {
      const transaction = state.update({ changes: change })
      bytes = updateDocumentBytes(bytes, state.doc, transaction.newDoc, transaction.changes, format)
      state = transaction.state
      assert.equal(bytes, encoded(state.doc.toString(), format))
    }
  }
})
test('a same-length edit near EOF reads only a small changed region', () => {
  const format = formats[1]
  const state = EditorState.create({ doc: 'x'.repeat(1_000_000) })
  const transaction = state.update({ changes: { from: state.doc.length - 1, to: state.doc.length, insert: 'Y' } })
  const original = state.doc.sliceString.bind(state.doc)
  let read = 0
  state.doc.sliceString = (from, to) => { read += (to ?? state.doc.length) - from; return original(from, to) }
  assert.equal(updateDocumentBytes(1_000_003, state.doc, transaction.newDoc, transaction.changes, format), 1_000_003)
  assert.ok(read <= 6, `Only boundary/changed text should be read, got ${read} code units`)
})
