export interface IPRange { start: number; end: number }

function ipv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}
function ipv6(value: string): boolean {
  const zone = value.indexOf('%')
  if (zone !== -1) {
    if (!/^[\w.-]+$/.test(value.slice(zone + 1))) return false
    value = value.slice(0, zone)
  }
  if (!value.includes(':') || value.includes(':::')) return false
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':')
    if (!ipv4(value.slice(lastColon + 1))) return false
    value = `${value.slice(0, lastColon + 1)}0:0`
  }
  const compressed = value.includes('::')
  if (compressed && value.indexOf('::') !== value.lastIndexOf('::')) return false
  const groups = value.split(':').filter(Boolean)
  if (!groups.every((group) => /^[a-f\d]{1,4}$/i.test(group))) return false
  if (compressed) return groups.length < 8
  return groups.length === 8 && !value.startsWith(':') && !value.endsWith(':')
}

/** IP ranges in displayed text. IPv6 brackets/ports remain outside the mask. */
export function findIPRanges(text: string): IPRange[] {
  const ranges: IPRange[] = []
  const v6 = /[a-f\d:.]+(?:%[\w.-]+)?/gi
  for (const match of text.matchAll(v6)) {
    let value = match[0], start = match.index
    if (!value.includes(':')) continue
    // A sentence's final period or a label's colon is not part of the address.
    if (!ipv6(value) && value.endsWith('.')) value = value.slice(0, -1)
    if (!ipv6(value) && value.startsWith(':') && !value.startsWith('::')) { value = value.slice(1); start++ }
    if (!ipv6(value) && value.endsWith(':') && !value.endsWith('::')) value = value.slice(0, -1)
    if (ipv6(value) && !/[\w]/.test(text[start - 1] ?? '') && !/[\w]/.test(text[start + value.length] ?? '')) ranges.push({ start, end: start + value.length })
  }
  const v4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)/g
  for (const match of text.matchAll(v4)) if (ipv4(match[0])) ranges.push({ start: match.index, end: match.index + match[0].length })
  ranges.sort((left, right) => left.start - right.start || right.end - left.end)
  const merged: IPRange[] = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/** Display-only, equal-length masking. Never use this to build SSH commands. */
export function redactIPs(text: string): string {
  const ranges = findIPRanges(text)
  if (!ranges.length) return text
  let result = '', offset = 0
  for (const range of ranges) { result += text.slice(offset, range.start) + '•'.repeat(range.end - range.start); offset = range.end }
  return result + text.slice(offset)
}
