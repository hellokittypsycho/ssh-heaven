import { useSyncExternalStore } from 'react'
import { findPrivateRanges, redactPrivateText, validateStreamRules, type StreamRule } from '../shared/text-redaction'

export const STREAM_RULES_KEY = 'ssh-heaven:stream-rules'
function stored(): StreamRule[] { try { return validateStreamRules(JSON.parse(globalThis.localStorage?.getItem(STREAM_RULES_KEY) || '[]')) } catch { return [] } }
let rules = stored()
let serialized = JSON.stringify(rules)
let persisted = serialized
const listeners = new Set<() => void>()
export const getStreamRules = () => rules
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useStreamRules = () => useSyncExternalStore(subscribe, getStreamRules, getStreamRules)
export function setStreamRules(value: unknown): void {
  const next = validateStreamRules(value)
  const encoded = JSON.stringify(next)
  if (encoded === serialized && encoded === persisted) return
  let saveFailed = false
  try { globalThis.localStorage?.setItem(STREAM_RULES_KEY, encoded); persisted = encoded } catch { saveFailed = true }
  if (encoded !== serialized) {
    serialized = encoded; rules = next; listeners.forEach((listener) => listener())
  }
  if (saveFailed) throw new Error('Rules apply for this session but could not be saved. Free local storage or try saving again.')
}
export const findSensitiveRanges = (value: string) => findPrivateRanges(value, rules)
export const redactSensitiveText = (value: string) => redactPrivateText(value, rules)
if (typeof window !== 'undefined') {
  const sync = (event: StorageEvent) => {
  if (event.key !== STREAM_RULES_KEY && event.key !== null) return
    const next = stored(), encoded = JSON.stringify(next)
    persisted = encoded
    if (encoded === serialized) return
    serialized = encoded; rules = next; listeners.forEach((listener) => listener())
  }
  window.addEventListener('storage', sync)
  if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener('storage', sync))
}
