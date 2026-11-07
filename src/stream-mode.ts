import { useSyncExternalStore } from 'react'

export const STREAM_MODE_KEY = 'ssh-heaven:stream-mode'
function stored(): boolean {
  try { return globalThis.localStorage?.getItem(STREAM_MODE_KEY) === 'true' } catch { return false }
}
let enabled = stored()
const listeners = new Set<() => void>()
function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.streamMode = String(enabled)
}
export function isStreamModeEnabled(): boolean { return enabled }
export function setStreamMode(value: boolean): void {
  if (enabled === value) return
  enabled = value; apply()
  try { globalThis.localStorage?.setItem(STREAM_MODE_KEY, String(value)) } catch { /* The live mode remains available when storage is blocked. */ }
  for (const listener of listeners) listener()
}
function toggle(): void { setStreamMode(!enabled) }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function useStreamMode(): { enabled: boolean; toggle: () => void } {
  return { enabled: useSyncExternalStore(subscribe, isStreamModeEnabled, () => false), toggle }
}
apply()
if (typeof window !== 'undefined') {
  const sync = (event: StorageEvent) => {
    if (event.key !== STREAM_MODE_KEY && event.key !== null) return
    enabled = stored(); apply()
    for (const listener of listeners) listener()
  }
  window.addEventListener('storage', sync)
  if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener('storage', sync))
}
