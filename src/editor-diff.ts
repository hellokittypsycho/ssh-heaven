export interface DiffRow { kind: 'context' | 'added' | 'removed' | 'omitted'; text: string; oldLine?: number; newLine?: number; count?: number }
export interface DiffPreview { rows: DiffRow[]; added: number; removed: number; truncated: boolean; coarse: boolean }
/** A bounded line diff: exact LCS for small edits, replacement blocks for large ones. */
export function buildDiffPreview(before: string, after: string, maxRows = 500): DiffPreview {
  if (before === after) return { rows: [], added: 0, removed: 0, truncated: false, coarse: false }
  const old = before.split('\n'), next = after.split('\n')
  let prefix = 0, suffix = 0
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - suffix - 1] === next[next.length - suffix - 1]) suffix++
  const a = old.slice(prefix, old.length - suffix), b = next.slice(prefix, next.length - suffix)
  const coarse = (a.length + 1) * (b.length + 1) > 180_000
  const changes: DiffRow[] = []
  let added = 0, removed = 0, omittedChanges = false
  const append = (row: DiffRow) => {
    if (row.kind === 'added') added++
    if (row.kind === 'removed') removed++
    if (changes.length < maxRows + 7) changes.push(row)
    else omittedChanges = true
  }
  if (!coarse) {
    const columns = b.length + 1
    const lcs = new Uint32Array((a.length + 1) * columns)
    for (let x = a.length - 1; x >= 0; x--) for (let y = b.length - 1; y >= 0; y--) lcs[x * columns + y] = a[x] === b[y] ? lcs[(x + 1) * columns + y + 1] + 1 : Math.max(lcs[(x + 1) * columns + y], lcs[x * columns + y + 1])
    let x = 0, y = 0
    while (x < a.length || y < b.length) {
      if (x < a.length && y < b.length && a[x] === b[y]) { append({ kind: 'context', text: a[x], oldLine: prefix + x + 1, newLine: prefix + y + 1 }); x++; y++ }
      else if (x < a.length && (y === b.length || lcs[(x + 1) * columns + y] >= lcs[x * columns + y + 1])) { append({ kind: 'removed', text: a[x], oldLine: prefix + x + 1 }); x++ }
      else { append({ kind: 'added', text: b[y], newLine: prefix + y + 1 }); y++ }
    }
  } else {
    removed = a.length; added = b.length
    for (let x = 0; x < Math.min(a.length, maxRows + 7); x++) changes.push({ kind: 'removed', text: a[x], oldLine: prefix + x + 1 })
    const remaining = Math.max(0, maxRows + 7 - changes.length)
    for (let y = 0; y < Math.min(b.length, remaining); y++) changes.push({ kind: 'added', text: b[y], newLine: prefix + y + 1 })
    omittedChanges = a.length + b.length > changes.length
  }
  const rows: DiffRow[] = []
  if (prefix > 3) rows.push({ kind: 'omitted', text: '', count: prefix - 3 })
  for (let index = Math.max(0, prefix - 3); index < prefix; index++) rows.push({ kind: 'context', text: old[index], oldLine: index + 1, newLine: index + 1 })
  for (let index = 0; index < changes.length;) {
    if (changes[index].kind !== 'context') { rows.push(changes[index++]); continue }
    let end = index + 1
    while (end < changes.length && changes[end].kind === 'context') end++
    if (end - index <= 6) rows.push(...changes.slice(index, end))
    else { rows.push(...changes.slice(index, index + 3)); rows.push({ kind: 'omitted', text: '', count: end - index - 6 }); rows.push(...changes.slice(end - 3, end)) }
    index = end
  }
  for (let index = 0; index < Math.min(3, suffix); index++) rows.push({ kind: 'context', text: old[old.length - suffix + index], oldLine: old.length - suffix + index + 1, newLine: next.length - suffix + index + 1 })
  if (suffix > 3) rows.push({ kind: 'omitted', text: '', count: suffix - 3 })
  return { rows: rows.slice(0, maxRows), added, removed, truncated: omittedChanges || rows.length > maxRows, coarse }
}
