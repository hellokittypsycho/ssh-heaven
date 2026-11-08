import { findIPRanges, redactIPs, type IPRange } from './ip-redaction'

export interface StreamRule { text: string; caseSensitive: boolean }
export function validateStreamRules(value: unknown): StreamRule[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Use up to 50 Stream mode rules.')
  return Object.freeze(value.map((rule) => {
    if (!rule || typeof rule !== 'object' || typeof rule.text !== 'string' || !rule.text.trim() || rule.text.length > 256 || /[\x00-\x1f\x7f]/.test(rule.text) || typeof rule.caseSensitive !== 'boolean') throw new Error('Each rule needs 1–256 characters of text.')
    return Object.freeze({ text: rule.text, caseSensitive: rule.caseSensitive })
  })) as unknown as StreamRule[]
}
const compiled = new WeakMap<readonly StreamRule[], RegExp[]>()
function matchers(rules: readonly StreamRule[]): RegExp[] {
  // Direct callers may pass mutable arrays. Only immutable snapshots are safe
  // cache keys; otherwise editing an existing rule could leave stale matchers.
  const cacheable = Object.isFrozen(rules) && rules.every(Object.isFrozen)
  const existing = cacheable ? compiled.get(rules) : undefined
  if (existing) return existing
  const seen = new Set<string>(), result: RegExp[] = []
  for (const rule of rules) {
    const key = `${rule.caseSensitive}:${!rule.caseSensitive && /^[\x20-\x7e]*$/.test(rule.text) ? rule.text.toLowerCase() : rule.text}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(new RegExp(rule.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), rule.caseSensitive ? 'g' : 'gi'))
  }
  if (cacheable) compiled.set(rules, result)
  return result
}
function privateMask(value: string, rules: readonly StreamRule[]): Uint8Array | undefined {
  // One byte per UTF-16 position bounds working memory independently of rule
  // count and match density. Never retain an object for each literal match.
  let mask: Uint8Array | undefined
  const fill = (start: number, end: number) => { (mask ??= new Uint8Array(value.length)).fill(1, start, end) }
  // Neither IP grammar can match without its separator. Avoid scanning every
  // word of large ordinary documents with the IPv6 token regex.
  if (value.includes(':') || value.includes('.') && /\d/.test(value)) for (const range of findIPRanges(value)) fill(range.start, range.end)
  for (const expression of matchers(rules)) {
    expression.lastIndex = 0
    let start = -1, end = 0, match: RegExpExecArray | null
    while ((match = expression.exec(value))) {
      expression.lastIndex = match.index + 1
      if (start >= 0 && match.index > end) { fill(start, end); start = -1 }
      if (start < 0) start = match.index
      end = match.index + match[0].length
    }
    if (start >= 0) fill(start, end)
    if (mask && !mask.includes(0)) break
  }
  return mask
}
export function findPrivateRanges(value: string, rules: readonly StreamRule[]): IPRange[] {
  if (!rules.length) return findIPRanges(value)
  const mask = privateMask(value, rules), ranges: IPRange[] = []
  if (!mask) return ranges
  for (let index = 0; index < mask.length;) {
    if (!mask[index]) { index++; continue }
    const start = index++
    while (index < mask.length && mask[index]) index++
    ranges.push({ start, end: index })
  }
  return ranges
}
export function redactPrivateText(value: string, rules: readonly StreamRule[]): string {
  if (!rules.length) return redactIPs(value)
  const mask = privateMask(value, rules), parts: string[] = []
  if (!mask) return value
  // Fixed-size output blocks avoid millions of tiny string objects when the
  // mask alternates on every character in a large log or document.
  const block = new Uint16Array(Math.min(8192, value.length))
  for (let offset = 0; offset < value.length; offset += block.length) {
    const length = Math.min(block.length, value.length - offset)
    for (let index = 0; index < length; index++) block[index] = mask[offset + index] ? 0x2022 : value.charCodeAt(offset + index)
    parts.push(String.fromCharCode(...block.subarray(0, length)))
  }
  return parts.join('')
}
