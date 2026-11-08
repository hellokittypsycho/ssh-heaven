import { findIPRanges, redactIPs, type IPRange } from './ip-redaction'

export interface StreamRule { text: string; caseSensitive: boolean }
export function validateStreamRules(value: unknown): StreamRule[] {
  if (!Array.isArray(value) || value.length > 50) throw new Error('Use up to 50 Stream mode rules.')
  return value.map((rule) => {
    if (!rule || typeof rule !== 'object' || typeof rule.text !== 'string' || !rule.text.trim() || rule.text.length > 256 || /[\x00-\x1f\x7f]/.test(rule.text) || typeof rule.caseSensitive !== 'boolean') throw new Error('Each rule needs 1–256 characters of text.')
    return { text: rule.text, caseSensitive: rule.caseSensitive }
  })
}
const compiled = new WeakMap<readonly StreamRule[], RegExp[]>()
function matchers(rules: readonly StreamRule[]): RegExp[] {
  const existing = compiled.get(rules)
  if (existing) return existing
  const seen = new Set<string>(), result: RegExp[] = []
  for (const rule of rules) {
    const key = `${rule.caseSensitive}:${!rule.caseSensitive && /^[\x20-\x7e]*$/.test(rule.text) ? rule.text.toLowerCase() : rule.text}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(new RegExp(rule.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), rule.caseSensitive ? 'g' : 'gi'))
  }
  compiled.set(rules, result)
  return result
}
function privateMask(value: string, rules: readonly StreamRule[]): Uint8Array {
  // One byte per UTF-16 position bounds working memory independently of rule
  // count and match density. Never retain an object for each literal match.
  const mask = new Uint8Array(value.length)
  for (const range of findIPRanges(value)) mask.fill(1, range.start, range.end)
  for (const expression of matchers(rules)) {
    expression.lastIndex = 0
    let start = -1, end = 0, match: RegExpExecArray | null
    while ((match = expression.exec(value))) {
      expression.lastIndex = match.index + 1
      if (start >= 0 && match.index > end) { mask.fill(1, start, end); start = -1 }
      if (start < 0) start = match.index
      end = match.index + match[0].length
    }
    if (start >= 0) mask.fill(1, start, end)
    if (!mask.includes(0)) break
  }
  return mask
}
export function findPrivateRanges(value: string, rules: readonly StreamRule[]): IPRange[] {
  if (!rules.length) return findIPRanges(value)
  const mask = privateMask(value, rules), ranges: IPRange[] = []
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
