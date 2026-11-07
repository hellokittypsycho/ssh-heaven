export interface NavigationHistory {
  readonly entries: readonly string[]
  readonly index: number
}

export const MAX_NAVIGATION_ENTRIES = 50

function destination(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A navigation destination cannot be empty.')
  return value
}

export function createNavigationHistory(initial: string): NavigationHistory {
  return { entries: [destination(initial)], index: 0 }
}

export function navigateHistory(state: NavigationHistory, target: string): NavigationHistory {
  destination(target)
  if (state.entries[state.index] === target) return state
  const entries = [...state.entries.slice(0, state.index + 1), target].slice(-MAX_NAVIGATION_ENTRIES)
  return { entries, index: entries.length - 1 }
}

export function moveHistory(state: NavigationHistory, direction: -1 | 1): NavigationHistory {
  if (direction !== -1 && direction !== 1) throw new Error('Choose backward or forward navigation.')
  if (!state.entries.length) return createNavigationHistory('home')
  const index = Math.max(0, Math.min(state.entries.length - 1, state.index + direction))
  return index === state.index ? state : { entries: state.entries, index }
}

/** Keep the selected occurrence when possible. A removed current destination
 * falls back to its nearest earlier valid entry, then the next valid entry. */
export function pruneNavigationHistory(state: NavigationHistory, isValid: (id: string) => boolean, fallback = 'home'): NavigationHistory {
  const originalIndex = Number.isInteger(state.index) ? Math.max(0, Math.min(state.entries.length - 1, state.index)) : 0
  let entries: string[] = []
  let selected: number | undefined, previous: number | undefined, next: number | undefined
  for (let index = 0; index < state.entries.length; index++) {
    const id = state.entries[index]
    if (!id.trim() || !isValid(id)) continue
    if (entries.at(-1) !== id) entries.push(id)
    const kept = entries.length - 1
    if (index === originalIndex) selected = kept
    if (index < originalIndex) previous = kept
    if (index > originalIndex && next === undefined) next = kept
  }
  if (!entries.length) {
    const target = destination(fallback)
    return state.entries.length === 1 && state.entries[0] === target && state.index === 0 ? state : createNavigationHistory(target)
  }
  let index = selected ?? previous ?? next ?? 0
  if (entries.length > MAX_NAVIGATION_ENTRIES) {
    const start = Math.min(index, entries.length - MAX_NAVIGATION_ENTRIES)
    entries = entries.slice(start, start + MAX_NAVIGATION_ENTRIES)
    index -= start
  }
  if (state.index === index && state.entries.length === entries.length && entries.every((id, position) => state.entries[position] === id)) return state
  return { entries, index }
}
