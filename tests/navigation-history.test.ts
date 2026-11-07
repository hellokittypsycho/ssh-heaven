import assert from 'node:assert/strict'
import test from 'node:test'
import { createNavigationHistory, moveHistory, navigateHistory, pruneNavigationHistory, type NavigationHistory } from '../src/navigation-history'

const current = (state: NavigationHistory) => state.entries[state.index]
const frozen = (entries: string[], index: number): NavigationHistory => Object.freeze({ entries: Object.freeze(entries), index })

test('navigation remembers mixed workspace pages and SSH sessions, branches after Back, and preserves forward history on a current-page click', () => {
  let history = createNavigationHistory('home')
  for (const target of ['ssh-alpha', 'scripts', 'ssh-beta']) history = navigateHistory(history, target)
  assert.deepEqual(history.entries, ['home', 'ssh-alpha', 'scripts', 'ssh-beta'])
  history = moveHistory(moveHistory(history, -1), -1)
  assert.equal(current(history), 'ssh-alpha')
  assert.strictEqual(navigateHistory(history, 'ssh-alpha'), history)
  assert.equal(current(moveHistory(history, 1)), 'scripts')
  const branched = navigateHistory(history, 'vault')
  assert.deepEqual(branched, { entries: ['home', 'ssh-alpha', 'vault'], index: 2 })
  assert.strictEqual(moveHistory(branched, 1), branched)
  assert.equal(current(moveHistory(branched, -1)), 'ssh-alpha')
})

test('back/forward endpoints are stable objects and moving never changes the immutable entries', () => {
  const first = frozen(['home', 'new', 'ssh-alpha'], 0)
  assert.strictEqual(moveHistory(first, -1), first)
  const second = moveHistory(first, 1)
  assert.strictEqual(second.entries, first.entries)
  assert.equal(current(second), 'new')
  const last = moveHistory(second, 1)
  assert.strictEqual(moveHistory(last, 1), last)
  assert.deepEqual(first, { entries: ['home', 'new', 'ssh-alpha'], index: 0 })
})

test('closing sessions prunes stale destinations, deduplicates newly adjacent pages, and preserves the selected occurrence', () => {
  const valid = new Set(['home', 'scripts', 'vault', 'ssh-live'])
  const history = frozen(['home', 'ssh-closed-a', 'home', 'scripts', 'ssh-closed-b', 'scripts', 'ssh-live', 'home'], 5)
  const cleaned = pruneNavigationHistory(history, (id) => valid.has(id))
  assert.deepEqual(cleaned, { entries: ['home', 'scripts', 'ssh-live', 'home'], index: 1 })
  assert.equal(current(moveHistory(cleaned, -1)), 'home')
  assert.equal(current(moveHistory(cleaned, 1)), 'ssh-live')
  const repeated = frozen(['home', 'scripts', 'home', 'vault'], 2)
  assert.strictEqual(pruneNavigationHistory(repeated, () => true), repeated)
  assert.equal(current(moveHistory(repeated, -1)), 'scripts', 'a repeated current page must retain its logical position')
})

test('pruning the current SSH session chooses the previous valid destination, then the next or explicit fallback', () => {
  const valid = (id: string) => !id.startsWith('closed-')
  assert.deepEqual(pruneNavigationHistory(frozen(['home', 'closed-a', 'closed-b', 'scripts'], 2), valid), { entries: ['home', 'scripts'], index: 0 })
  assert.deepEqual(pruneNavigationHistory(frozen(['closed-a', 'closed-b', 'vault'], 0), valid), { entries: ['vault'], index: 0 })
  assert.deepEqual(pruneNavigationHistory(frozen(['closed-a'], 0), valid), { entries: ['home'], index: 0 })
  assert.deepEqual(pruneNavigationHistory(frozen(['closed-a'], 0), valid, 'new'), { entries: ['new'], index: 0 })
  assert.deepEqual(pruneNavigationHistory(frozen([], -1), () => false), { entries: ['home'], index: 0 })
  const fallback = createNavigationHistory('home')
  assert.strictEqual(pruneNavigationHistory(fallback, () => false), fallback)
})

test('a bounded history retains the latest visits, with correct Back/Forward behavior and no mutation of earlier snapshots', () => {
  let history = createNavigationHistory('home')
  const original = history
  for (let number = 1; number <= 80; number++) history = navigateHistory(history, `ssh-${number}`)
  assert.equal(history.entries.length, 50)
  assert.equal(history.entries[0], 'ssh-31')
  assert.equal(current(history), 'ssh-80')
  assert.equal(history.index, 49)
  for (let number = 0; number < 49; number++) history = moveHistory(history, -1)
  assert.equal(current(history), 'ssh-31')
  assert.strictEqual(moveHistory(history, -1), history)
  const branch = navigateHistory(history, 'scripts')
  assert.deepEqual(branch, { entries: ['ssh-31', 'scripts'], index: 1 })
  assert.deepEqual(original, { entries: ['home'], index: 0 })
})

test('pruning oversized or stale external state remains bounded while keeping its valid current destination', () => {
  const entries = Array.from({ length: 70 }, (_, index) => `ssh-${index}`)
  for (const index of [0, 20, 69]) {
    const cleaned = pruneNavigationHistory(frozen(entries, index), () => true)
    assert.equal(cleaned.entries.length, 50)
    assert.equal(current(cleaned), entries[index])
    assert.ok(cleaned.index >= 0 && cleaned.index < cleaned.entries.length)
  }
  assert.deepEqual(pruneNavigationHistory(frozen(['', 'home', '', 'home'], 3), () => true), { entries: ['home'], index: 0 })
})

test('unchanged pruning and repeated navigation return the same object, while blank destinations cannot create empty history', () => {
  const history = frozen(['home', 'scripts', 'ssh-alpha'], 1)
  assert.strictEqual(pruneNavigationHistory(history, () => true), history)
  assert.strictEqual(navigateHistory(history, 'scripts'), history)
  assert.throws(() => createNavigationHistory(''), /cannot be empty/)
  assert.throws(() => navigateHistory(history, '  '), /cannot be empty/)
  assert.throws(() => pruneNavigationHistory(history, () => false, ''), /cannot be empty/)
})
