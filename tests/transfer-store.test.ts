import assert from 'node:assert/strict'
import test from 'node:test'
import type { TransferJob } from '../shared/types'
import { TransferStore } from '../src/transfer-store'

function fixture() {
  let scheduled: (() => void) | undefined
  const store = new TransferStore((notify) => { scheduled = notify; return () => { scheduled = undefined } })
  return { store, flush() { scheduled?.() }, pending: () => !!scheduled }
}
function job(id: string, sessionId: string, extra: Partial<TransferJob> = {}): TransferJob {
  return { id, sessionId, name: `${id}.bin`, source: '/fixture/source', destination: '/fixture/destination', direction: 'upload', total: 100_000, transferred: 0, status: 'running', startedAt: 1, ...extra }
}

test('progress snapshots batch bursts, remain immutable/stable, and notify only the session that changed', () => {
  const h = fixture(), calls = { first: 0, second: 0 }
  h.store.subscribe('first', () => calls.first++)
  h.store.subscribe('second', () => calls.second++)
  h.store.receive(job('one', 'first')); h.store.receive(job('two', 'second')); h.flush()
  const first = h.store.getSnapshot('first'), second = h.store.getSnapshot('second')
  calls.first = 0; calls.second = 0
  for (let transferred = 1; transferred <= 500; transferred++) h.store.receive(job('one', 'first', { transferred }))
  assert.equal(h.store.getSnapshot('first'), first, 'Snapshots change at the batch boundary, not for every native packet')
  assert.equal(calls.first, 0); h.flush()
  assert.equal(calls.first, 1); assert.equal(calls.second, 0)
  assert.equal(h.store.getSnapshot('second'), second)
  assert.equal(first[0].transferred, 0, 'Published snapshots must not be mutated by later events')
  assert.equal(h.store.getSnapshot('first')[0].transferred, 500)
  const current = h.store.getSnapshot('first')
  h.store.receive(job('one', 'first', { transferred: 500 })); h.flush()
  assert.equal(h.store.getSnapshot('first'), current); assert.equal(calls.first, 1, 'Identical updates do not wake subscribers')
  h.store.dispose()
})

test('queue reordering, paused state and finished state rebuild only the affected ordered snapshot', () => {
  const h = fixture()
  h.store.receive(job('active', 'session'))
  h.store.receive(job('second', 'session', { status: 'paused', queuePosition: 2 }))
  h.store.receive(job('first', 'session', { status: 'queued', queuePosition: 1 }))
  h.store.receive(job('done', 'session', { status: 'completed', finishedAt: 5 }))
  h.flush()
  assert.deepEqual(h.store.getSnapshot('session').map((item) => item.id), ['active', 'first', 'second', 'done'])
  h.store.receive(job('second', 'session', { status: 'paused', queuePosition: 1 }))
  h.store.receive(job('first', 'session', { status: 'queued', queuePosition: 2 }))
  h.flush()
  assert.deepEqual(h.store.getSnapshot('session').map((item) => item.id), ['active', 'second', 'first', 'done'])
  h.store.clearFinished('session')
  assert.deepEqual(h.store.getSnapshot('session').map((item) => item.id), ['active', 'second', 'first'])
  h.store.dispose()
})

test('retention never discards active or paused jobs and bounds finished history across sessions', () => {
  const h = fixture()
  for (let index = 0; index < 200; index++) h.store.receive(job(`job-${index}`, 'session', { status: index % 2 ? 'paused' : 'queued', queuePosition: index + 1 }))
  h.flush()
  const original = h.store.getSnapshot('session')
  assert.equal(original.length, 200)
  for (let index = 0; index < 100; index++) h.store.receive(job(`job-${index}`, 'session', { status: 'completed', transferred: 100_000, finishedAt: index + 2 }))
  h.flush()
  assert.equal(h.store.getSnapshot('session').length, 150)
  for (let index = 100; index < 200; index++) assert.ok(h.store.getSnapshot('session').some((item) => item.id === `job-${index}`))
  h.store.clearFinished('session')
  assert.equal(h.store.getSnapshot('session').length, 100)
  assert.ok(h.store.getSnapshot('session').every((item) => ['paused', 'queued'].includes(item.status)))
  assert.equal(original.length, 200)
  h.store.dispose()
})

test('disposed or unsubscribed empty sessions retain no scheduled publication or old snapshot', () => {
  const h = fixture()
  let calls = 0
  const unsubscribe = h.store.subscribe('empty', () => calls++)
  const empty = h.store.getSnapshot('empty'); unsubscribe()
  h.store.receive(job('one', 'active')); assert.equal(h.pending(), true)
  h.store.dispose(); assert.equal(h.pending(), false); h.flush()
  assert.equal(calls, 0); assert.equal(h.store.getSnapshot('active'), empty)
})

test('a 20-session progress workload avoids unrelated wakeups and publishes one snapshot per changed batch', () => {
  const h = fixture(), calls = Array.from({ length: 20 }, () => 0)
  for (let session = 0; session < 20; session++) {
    h.store.subscribe(`s${session}`, () => { calls[session]++; h.store.getSnapshot(`s${session}`) })
    for (let index = 0; index < 5; index++) h.store.receive(job(`s${session}-j${index}`, `s${session}`))
  }
  h.flush(); calls.fill(0)
  const start = performance.now()
  for (let batch = 0; batch < 100; batch++) {
    for (let update = 0; update < 50; update++) h.store.receive(job('s0-j0', 's0', { transferred: batch * 50 + update + 1 }))
    h.flush()
  }
  const elapsed = performance.now() - start
  assert.equal(calls[0], 100); assert.equal(calls.slice(1).reduce((a, b) => a + b, 0), 0)
  assert.equal(h.store.getSnapshot('s0')[0].transferred, 5000)
  console.log(JSON.stringify({ transferStoreProbe: { sessions: 20, jobs: 100, progressEvents: 5000, eventBatches: 100, subscriberWakeups: calls[0], unrelatedSessionWakeups: 0, elapsedMs: Number(elapsed.toFixed(2)) } }))
  h.store.dispose()
})
