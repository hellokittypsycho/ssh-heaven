import assert from 'node:assert/strict'
import test from 'node:test'
import { findPrivateRanges, redactPrivateText, validateStreamRules } from '../shared/text-redaction'

test('custom Stream rules merge overlapping literals with automatic IP masks', () => {
  const rules = validateStreamRules([{ text: 'prod.example', caseSensitive: false }, { text: 'prod', caseSensitive: false }])
  const value = 'PROD.EXAMPLE at 192.0.2.10, not staging'
  assert.equal(redactPrivateText(value, rules), '•••••••••••• at ••••••••••, not staging')
  assert.equal(redactPrivateText(value, rules).length, value.length)
  assert.deepEqual(findPrivateRanges('PROD.EXAMPLE', rules), [{ start: 0, end: 12 }])
})
test('rule punctuation is literal and case-sensitive matches do not hide unrelated text', () => {
  const rules = validateStreamRules([{ text: '(a+)+$', caseSensitive: true }, { text: 'Root', caseSensitive: true }])
  assert.equal(redactPrivateText('(a+)+$ Root root aaaaaa', rules), '•••••• •••• root aaaaaa')
  assert.equal(redactPrivateText('😀秘密 root', [{ text: '😀秘密', caseSensitive: false }]), '•••• root')
})
test('rule bounds reject blank/control-character/unbounded rules', () => {
  for (const value of [null, Array.from({ length: 51 }, () => ({ text: 'x', caseSensitive: false })), [{ text: ' ', caseSensitive: false }], [{ text: 'x\n', caseSensitive: false }], [{ text: 'x'.repeat(257), caseSensitive: false }], [{ text: 'x', caseSensitive: 'yes' }]]) assert.throws(() => validateStreamRules(value))
})

test('immutable validated snapshots stay cached while direct mutable callers cannot reuse stale rules', () => {
  const snapshot = validateStreamRules([{ text: 'first', caseSensitive: true }])
  assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot[0]), true)
  const mutable = [{ text: 'first', caseSensitive: true }]
  assert.equal(redactPrivateText('first second', mutable), '••••• second')
  mutable[0].text = 'second'
  assert.equal(redactPrivateText('first second', mutable), 'first ••••••')
  mutable.push({ text: 'first', caseSensitive: true })
  assert.equal(redactPrivateText('first second', mutable), '••••• ••••••')
})
test('dense duplicate and overlapping rules keep a two-MiB document bounded', () => {
  const rules = validateStreamRules(Array.from({ length: 50 }, () => ({ text: 'a', caseSensitive: false })))
  const value = 'a'.repeat(2 * 1024 * 1024)
  assert.deepEqual(findPrivateRanges(value, rules), [{ start: 0, end: value.length }])
  assert.equal(redactPrivateText(value, rules), '•'.repeat(value.length))
  assert.equal(redactPrivateText('abcab', [{ text: 'ab', caseSensitive: false }, { text: 'bc', caseSensitive: false }]), '•••••')
  assert.equal(redactPrivateText('ababa', [{ text: 'aba', caseSensitive: true }]), '•••••')
  assert.equal(redactPrivateText('a '.repeat(100_000), rules), '• '.repeat(100_000))
})
