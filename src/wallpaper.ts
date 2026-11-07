import { useEffect, useSyncExternalStore } from 'react'
import type { WallpaperPreferences, WallpaperState } from '../shared/types'

const defaults: WallpaperState = { enabled: false, opacity: .2, blur: 0, fit: 'cover', animate: true }
let current: WallpaperState = defaults
let revision = 0
let pending = 0
let loaded = false
let loading: Promise<WallpaperState> | undefined
let queue: Promise<unknown> = Promise.resolve()
let stopNative: (() => void) | undefined
const subscribers = new Set<() => void>()

function publish(state: WallpaperState): void {
  current = state
  if (typeof document !== 'undefined') document.documentElement.dataset.wallpaper = String(state.enabled && !!state.assetUrl)
  for (const subscriber of subscribers) subscriber()
}
function bindNative(): void {
  if (stopNative || typeof window === 'undefined' || !window.sshHeaven?.onWallpaper) return
  stopNative = window.sshHeaven.onWallpaper((state) => {
    // Pending changes have already been applied optimistically. Their own
    // responses reconcile the final state without jumping a slider backwards.
    if (!pending) { revision++; loaded = true; publish(state) }
  })
}
export function applyWallpaper(state: WallpaperState): void {
  revision++; loaded = true; publish(state)
}
export function loadWallpaper(): Promise<WallpaperState> {
  bindNative()
  if (loaded) return Promise.resolve(current)
  if (loading) return loading
  const generation = revision
  loading = window.sshHeaven.getWallpaperState().then((state) => {
    loaded = true
    if (generation === revision && !pending) publish(state)
    return current
  }).finally(() => { loading = undefined })
  return loading
}
function mutate(operation: () => Promise<WallpaperState | null>, optimistic?: WallpaperState): Promise<WallpaperState> {
  bindNative()
  const generation = ++revision
  pending++
  if (optimistic) publish(optimistic)
  const operationResult = queue.then(operation)
  queue = operationResult.then(() => {}, () => {})
  return operationResult.then(async (value) => {
    try {
      // A canceled picker can follow a queued edit whose response was superseded.
      // Reconcile with native state rather than keeping an old optimistic asset.
      const state = value ?? await window.sshHeaven.getWallpaperState()
      loaded = true
      if (generation === revision) publish(state)
      return state
    } finally { pending-- }
  }, async (error: unknown) => {
    try {
      if (generation === revision) {
        try {
        const state = await window.sshHeaven.getWallpaperState()
        if (generation === revision) publish(state)
        } catch { /* Keep the current preview if the application is shutting down. */ }
      }
    } finally { pending-- }
    throw error
  })
}
export function setWallpaperPreferences(patch: Partial<WallpaperPreferences>): Promise<WallpaperState> {
  return mutate(() => window.sshHeaven.setWallpaperPreferences(patch), { ...current, ...patch, error: undefined })
}
export function chooseWallpaper(): Promise<WallpaperState> {
  return mutate(() => window.sshHeaven.chooseWallpaper())
}
export function clearWallpaper(): Promise<WallpaperState> {
  return mutate(() => window.sshHeaven.clearWallpaper(), { ...current, enabled: false, name: undefined, assetUrl: undefined, posterUrl: undefined, kind: undefined, error: undefined })
}
const LOAD_ERROR = 'This wallpaper could not be displayed. It has been disabled. Choose another image or GIF.'
const loadReports = new Set<string>()
export function reportWallpaperLoadError(sourceUrl: string): void {
  const matches = (state: WallpaperState) => state.assetUrl === sourceUrl || state.posterUrl === sourceUrl
  if (!matches(current) || loadReports.has(sourceUrl) || !current.enabled && current.error === LOAD_ERROR) return
  loadReports.add(sourceUrl)
  // A picker can replace the asset while this report waits in the queue. Do not
  // hide its eventual result or disable a replacement that decoded successfully.
  const optimistic = pending ? undefined : { ...current, enabled: false, error: LOAD_ERROR }
  void mutate(async () => {
    const native = await window.sshHeaven.getWallpaperState()
    if (!matches(native)) return native
    const disabled = await window.sshHeaven.setWallpaperPreferences({ enabled: false })
    return matches(disabled) ? { ...disabled, error: LOAD_ERROR } : disabled
  }, optimistic).catch(() => {
    // The background still stays hidden if saving the preference failed.
    if (matches(current)) publish({ ...current, enabled: false, error: LOAD_ERROR })
  }).finally(() => { loadReports.delete(sourceUrl) })
}
function subscribe(callback: () => void) {
  subscribers.add(callback)
  return () => { subscribers.delete(callback) }
}
export function useWallpaper(): WallpaperState {
  useEffect(() => { void loadWallpaper().catch(() => {}) }, [])
  return useSyncExternalStore(subscribe, () => current, () => defaults)
}

const motionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : undefined
function subscribeMotion(callback: () => void) {
  motionQuery?.addEventListener('change', callback)
  return () => motionQuery?.removeEventListener('change', callback)
}
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, () => motionQuery?.matches ?? false, () => false)
}
export function wallpaperSource(state: WallpaperState, reducedMotion: boolean): string | undefined {
  return state.kind === 'gif' && (!state.animate || reducedMotion) ? state.posterUrl : state.assetUrl
}

if (import.meta.hot) import.meta.hot.dispose(() => { stopNative?.(); stopNative = undefined })
