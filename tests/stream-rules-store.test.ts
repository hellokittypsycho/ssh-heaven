import assert from 'node:assert/strict'
import test from 'node:test'

let generation = 0
async function fixture() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map<string, string>(), handlers = new Set<(event: { key: string | null }) => void>()
  let writes = 0, fail = false
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem(key: string, value: string) { writes++; if (fail) throw new Error('Fixture storage denied'); values.set(key, value) },
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener: (_name: string, handler: (event: { key: string | null }) => void) => handlers.add(handler), removeEventListener: (_name: string, handler: (event: { key: string | null }) => void) => handlers.delete(handler) } })
  const store = await import(`${new URL('../src/stream-rules.ts', import.meta.url).href}?isolated=${generation++}`) as typeof import('../src/stream-rules')
  return { store, values, get writes() { return writes }, set fail(value: boolean) { fail = value }, sync(key: string | null) { for (const handler of handlers) handler({ key }) }, close() {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window')
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else Reflect.deleteProperty(globalThis, 'localStorage')
  } }
}
test('unchanged rules retain snapshot identity and avoid needless writes or all-pane privacy rebuilds', async () => {
  const h = await fixture()
  try {
    const input = [{ text: 'private-host', caseSensitive: false }]
    h.store.setStreamRules(input)
    const snapshot = h.store.getStreamRules()
    assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot[0]), true)
    input[0].text = 'mutated outside store'
    assert.equal(h.store.redactSensitiveText('PRIVATE-HOST'), '•'.repeat(12))
    h.store.setStreamRules([{ text: 'private-host', caseSensitive: false }])
    assert.equal(h.store.getStreamRules(), snapshot); assert.equal(h.writes, 1)
    h.sync(h.store.STREAM_RULES_KEY)
    assert.equal(h.store.getStreamRules(), snapshot)
    h.values.set(h.store.STREAM_RULES_KEY, JSON.stringify([{ text: 'replacement', caseSensitive: true }]))
    h.sync(h.store.STREAM_RULES_KEY)
    assert.notEqual(h.store.getStreamRules(), snapshot)
    assert.equal(h.store.redactSensitiveText('private-host replacement'), `private-host ${'•'.repeat(11)}`)
  } finally { h.close() }
})
test('storage failure applies masks immediately, reports session-only persistence, and retries without changing live snapshot', async () => {
  const h = await fixture()
  try {
    h.fail = true
    assert.throws(() => h.store.setStreamRules([{ text: 'new-sensitive', caseSensitive: true }]), /apply for this session.*could not be saved/)
    assert.equal(h.store.redactSensitiveText('new-sensitive'), '•'.repeat(13))
    const snapshot = h.store.getStreamRules()
    h.fail = false
    h.store.setStreamRules([{ text: 'new-sensitive', caseSensitive: true }])
    assert.equal(h.store.getStreamRules(), snapshot); assert.equal(h.writes, 2)
    assert.equal(JSON.parse(h.values.get(h.store.STREAM_RULES_KEY)!)[0].text, 'new-sensitive')
  } finally { h.close() }
})
