import type { ChangeSet, Text } from '@codemirror/state'

export interface TextFormat { bom: boolean; ending: '\n' | '\r\n' | '\r'; mixed: boolean }
/** UTF-8 byte count with TextEncoder-compatible handling of lone surrogates. */
export function fragmentBytes(value: string, format: TextFormat): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 10 && format.ending === '\r\n') bytes += 2
    else if (code < 0x80) bytes++
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { bytes += 4; index++ }
    else bytes += 3
  }
  return bytes
}
export function documentBytes(doc: Text, format: TextFormat): number {
  let bytes = format.bom ? 3 : 0
  const chunks = doc.iter()
  while (!chunks.next().done) bytes += fragmentBytes(chunks.value, format)
  return bytes
}
export function stringBytes(value: string, format: TextFormat): number { return fragmentBytes(value, format) + (format.bom ? 3 : 0) }
function surrogateBoundary(doc: Text, position: number): boolean {
  return /[\ud800-\udfff]/.test(doc.sliceString(Math.max(0, position - 1), Math.min(doc.length, position + 1)))
}
/** Ordinary edits count only removed/inserted text, including native CRLF bytes. */
export function updateDocumentBytes(previous: number, before: Text, after: Text, changes: ChangeSet, format: TextFormat): number {
  let bytes = previous, recount = false
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    // An edit may join or split a surrogate pair across its boundary. Recount
    // that uncommon case so partial Unicode edits cannot bypass the byte limit.
    if (surrogateBoundary(before, fromA) || surrogateBoundary(before, toA) || surrogateBoundary(after, fromB) || surrogateBoundary(after, toB)) { recount = true; return }
    bytes += fragmentBytes(inserted.toString(), format) - fragmentBytes(before.sliceString(fromA, toA), format)
  })
  return recount ? documentBytes(after, format) : bytes
}
