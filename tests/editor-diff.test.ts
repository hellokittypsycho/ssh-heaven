import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDiffPreview } from '../src/editor-diff'
test('line review distinguishes replacements, insertions and unchanged context', () => {
  const diff = buildDiffPreview('one\ntwo\nthree\nfour\n', 'one\nTWO\nthree\nextra\nfour\n')
  assert.equal(diff.added, 2); assert.equal(diff.removed, 1)
  assert.equal(diff.coarse, false)
  assert.deepEqual(diff.rows.filter((line) => line.kind === 'removed').map((line) => [line.text, line.oldLine]), [['two', 2]])
  assert.deepEqual(diff.rows.filter((line) => line.kind === 'added').map((line) => [line.text, line.newLine]), [['TWO', 2], ['extra', 4]])
  assert.deepEqual(buildDiffPreview('same', 'same').rows, [])
})
test('large changes are bounded without losing total change counts', () => {
  const diff = buildDiffPreview(Array.from({ length: 1500 }, (_, index) => `before${index}`).join('\n'), Array.from({ length: 1500 }, (_, index) => `after${index}`).join('\n'), 50)
  assert.equal(diff.rows.length, 50); assert.equal(diff.truncated, true); assert.equal(diff.coarse, true)
  assert.equal(diff.added, 1500); assert.equal(diff.removed, 1500)
})
test('unchanged stretches are collapsed while change line numbers remain exact', () => {
  const before = Array.from({ length: 100 }, (_, index) => `${index}`).join('\n')
  const after = before.replace('\n20\n', '\nnew20\n').replace('\n80\n', '\nnew80\n')
  const diff = buildDiffPreview(before, after)
  assert.equal(diff.rows.some((line) => line.kind === 'omitted'), true)
  assert.deepEqual(diff.rows.filter((line) => line.kind === 'added').map((line) => line.newLine), [21, 81])
})
