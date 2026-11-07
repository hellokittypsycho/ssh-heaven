import assert from 'node:assert/strict'
import test from 'node:test'
import type { WallpaperPreferences, WallpaperState } from '../shared/types'

type Store = typeof import('../src/wallpaper')
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function asset(id: string, name: string): WallpaperState {
  return { enabled: true, opacity: .2, blur: 0, fit: 'cover', animate: true, kind: 'image', name, assetUrl: `ssh-heaven-wallpaper://asset/${id}/image`, posterUrl: `ssh-heaven-wallpaper://asset/${id}/image` }
}
let generation = 0
async function harness() {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  // Each import has its own module-level queue, state, subscriptions and motion
  // query. The test file also restores globals before another case can run.
  Reflect.deleteProperty(globalThis, 'document')
  let native = asset('old', 'Original')
  const listeners = new Set<(state: WallpaperState) => void>()
  const picker = deferred<WallpaperState | null>()
  const pickerStarted = deferred<void>()
  let pickerPending = false
  const updates: Partial<WallpaperPreferences>[] = []
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    sshHeaven: {
      onWallpaper: (listener: (state: WallpaperState) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      getWallpaperState: async () => structuredClone(native),
      chooseWallpaper: async () => {
        pickerPending = true
        pickerStarted.resolve()
        const state = await picker.promise
        pickerPending = false
        if (state) { native = structuredClone(state); for (const listener of listeners) listener(structuredClone(native)) }
        return state
      },
      setWallpaperPreferences: async (patch: Partial<WallpaperPreferences>) => {
        assert.equal(pickerPending, false, 'Native mutations must stay behind a pending asset picker')
        updates.push(structuredClone(patch))
        native = { ...native, ...patch }
        for (const listener of listeners) listener(structuredClone(native))
        return structuredClone(native)
      },
      clearWallpaper: async () => { native = { enabled: false, opacity: .2, blur: 0, fit: 'cover', animate: true }; return structuredClone(native) },
    },
  } })
  const store = await import(`${new URL('../src/wallpaper.ts', import.meta.url).href}?isolated=${generation++}`) as Store
  store.applyWallpaper(native)
  return {
    store, picker, pickerStarted, updates,
    getNative: () => structuredClone(native),
    async settle() {
      // reportWallpaperLoadError is intentionally fire-and-forget. A no-op
      // preference change is a queue barrier; all earlier error work must finish.
      await store.setWallpaperPreferences({})
      return store.loadWallpaper()
    },
    dispose() {
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    },
  }
}

test('wallpaper store preserves a newly selected asset when the old image fails during its picker', async () => {
  const fixture = await harness()
  try {
    const old = fixture.getNative()
    const choosing = fixture.store.chooseWallpaper()
    await fixture.pickerStarted.promise
    fixture.store.reportWallpaperLoadError(old.assetUrl!)
    fixture.picker.resolve(asset('new', 'Replacement'))
    await choosing
    const final = await fixture.settle()
    assert.equal(final.name, 'Replacement')
    assert.equal(final.enabled, true)
    assert.equal(final.error, undefined)
    assert.equal(fixture.getNative().enabled, true, 'A stale load error must not disable the replacement in native preferences')
    assert.equal(fixture.updates.some((patch) => patch.enabled === false), false)
  } finally { fixture.dispose() }
})

test('a canceled picker still disables the original image if that same asset failed', async () => {
  const fixture = await harness()
  try {
    const old = fixture.getNative()
    const choosing = fixture.store.chooseWallpaper()
    await fixture.pickerStarted.promise
    fixture.store.reportWallpaperLoadError(old.assetUrl!)
    fixture.picker.resolve(null)
    await choosing
    const final = await fixture.settle()
    assert.equal(final.name, 'Original')
    assert.equal(final.enabled, false)
    assert.equal(fixture.getNative().enabled, false)
    assert.ok(fixture.updates.some((patch) => patch.enabled === false), 'A genuine failure of the retained image must be saved')
  } finally { fixture.dispose() }
})

test('rapid wallpaper preferences reconcile the latest edit after a canceled native picker', async () => {
  const fixture = await harness()
  try {
    const choosing = fixture.store.chooseWallpaper()
    await fixture.pickerStarted.promise
    const first = fixture.store.setWallpaperPreferences({ opacity: .45 })
    const second = fixture.store.setWallpaperPreferences({ opacity: .83 })
    const third = fixture.store.setWallpaperPreferences({ blur: 14, fit: 'contain', animate: false })
    const preview = await fixture.store.loadWallpaper()
    assert.equal(preview.opacity, .83, 'The current preview should immediately show the latest slider position')
    assert.equal(preview.blur, 14)
    fixture.picker.resolve(null)
    await Promise.all([choosing, first, second, third])
    const final = await fixture.store.loadWallpaper()
    assert.equal(final.name, 'Original')
    assert.equal(final.enabled, true)
    assert.equal(final.opacity, .83)
    assert.equal(final.blur, 14)
    assert.equal(final.fit, 'contain')
    assert.equal(final.animate, false)
    assert.deepEqual(final, fixture.getNative())
  } finally { fixture.dispose() }
})
