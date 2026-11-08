import { useSyncExternalStore } from 'react'
import { findPrivateRanges, redactPrivateText, validateStreamRules, type StreamRule } from '../shared/text-redaction'

export const STREAM_RULES_KEY = 'ssh-heaven:stream-rules'
function stored(): StreamRule[] { try { return validateStreamRules(JSON.parse(globalThis.localStorage?.getItem(STREAM_RULES_KEY) || '[]')) } catch { return [] } }
let rules = stored()
const listeners = new Set<() => void>()
export const getStreamRules = () => rules
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useStreamRules = () => useSyncExternalStore(subscribe, getStreamRules, getStreamRules)
export function setStreamRules(value: unknown): void {
  const next = validateStreamRules(value)
  globalThis.localStorage?.setItem(STREAM_RULES_KEY, JSON.stringify(next))
  rules = next; listeners.forEach((listener) => listener())
}
export const findSensitiveRanges = (value: string) => findPrivateRanges(value, rules)
export const redactSensitiveText = (value: string) => redactPrivateText(value, rules)
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== STREAM_RULES_KEY && event.key !== null) return
  rules = stored(); listeners.forEach((listener) => listener())
})
