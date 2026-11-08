import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { findSensitiveRanges as findIPRanges, getStreamRules, redactSensitiveText as redactIPs } from './stream-rules'
import { findIPRanges as ipRanges, type IPRange } from '../shared/ip-redaction'

interface Span { from: number; to: number }
const CONTEXT = 256 // Longest permitted custom literal, in UTF-16 positions.

/** Cache only short presentation windows, not entire documents or prior undo
 * states. A single edited line must not rescan all unchanged visible lines. */
export class EditorPrivacyCache {
  private rules = getStreamRules()
  private readonly entries = new Map<string, IPRange[]>()
  private characters = 0
  constructor(private readonly scan: (text: string) => IPRange[] = findIPRanges) {}
  ranges(text: string): readonly IPRange[] {
    const rules = getStreamRules()
    if (rules !== this.rules) { this.rules = rules; this.entries.clear(); this.characters = 0 }
    const existing = this.entries.get(text)
    if (existing) { this.entries.delete(text); this.entries.set(text, existing); return existing }
    const result = this.scan(text)
    if (text.length <= 8192 && result.length <= 1024) {
      this.entries.set(text, result); this.characters += text.length
      while (this.entries.size > 128 || this.characters > 128 * 1024) {
        const first = this.entries.keys().next().value!
        this.characters -= first.length; this.entries.delete(first)
      }
    }
    return result
  }
}

/** Match bounded windows with full literal context, even across folded or
 * horizontally clipped ranges. Long IPv6 zone suffixes get their actual base
 * context separately, without applying every custom rule to a giant line. */
export function editorPrivateRanges(state: Pick<EditorState, 'doc'>, spans: readonly Span[], cache = new EditorPrivacyCache()): IPRange[] {
  const result: IPRange[] = []
  for (const span of spans) {
    for (let from = span.from; from < span.to;) {
      const line = state.doc.lineAt(from), to = Math.min(span.to, line.to)
      if (to > from) {
        let start = Math.max(line.from, from - CONTEXT)
        const end = Math.min(line.to, to + CONTEXT)
        // A short base may start just before the literal padding and have an
        // arbitrarily long zone. Include that complete base before masking.
        let prefix = 0
        while (start > line.from && prefix < 80 && /[a-f\d:.]/i.test(line.text[start - line.from - 1])) { start--; prefix++ }
        // A word sentinel prevents a truncated IPv6 base at the context's
        // edge from becoming a false valid address. No 256-character literal
        // starting at that sentinel can reach the actual presentation span.
        const before = start > line.from ? line.text[start - line.from - 1] : ''
        const sentinel = /[a-f\d:.]/i.test(before) ? 'g' : before
        const text = sentinel + state.doc.sliceString(start, end)
        for (const range of cache.ranges(text)) {
          const left = Math.max(from, start + range.start - sentinel.length), right = Math.min(to, start + range.end - sentinel.length)
          if (right > left) result.push({ start: left, end: right })
        }
        if (start > line.from) {
          const localStart = start - line.from, percent = line.text.lastIndexOf('%', localStart - 1)
          if (percent >= 0 && /^[\w.-]*$/.test(line.text.slice(percent + 1, localStart))) {
            const baseStart = Math.max(0, percent - 80), base = `${line.text.slice(baseStart, percent)}%x`
            const address = ipRanges(base).find((range) => range.end === base.length)
            if (address) {
              const zone = /^[\w.-]*/.exec(line.text.slice(localStart, to - line.from))![0]
              const right = Math.min(to, start + zone.length)
              if (right > from) result.push({ start: from, end: right })
            }
          }
        }
      }
      from = line.to + 1
    }
  }
  result.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: IPRange[] = []
  for (const range of result) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push(range)
  }
  return merged
}

class MaskedAddress extends WidgetType {
  constructor(readonly length: number) { super() }
  eq(other: MaskedAddress): boolean { return this.length === other.length }
  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'stream-private-widget'
    element.textContent = '•'.repeat(this.length)
    element.setAttribute('aria-label', 'Hidden sensitive text')
    return element
  }
}

function masks(view: EditorView, cache: EditorPrivacyCache): DecorationSet {
  const ranges = new RangeSetBuilder<Decoration>()
  for (const range of editorPrivateRanges(view.state, view.visibleRanges, cache)) ranges.add(range.start, range.end, Decoration.replace({ widget: new MaskedAddress(range.end - range.start) }))
  return ranges.finish()
}
function maskAnnouncements(view: EditorView): void {
  // CodeMirror builds screen-reader announcements from the raw document.
  // Its public update listener runs synchronously after that announcement DOM
  // is created, before the browser publishes an accessibility/paint update.
  for (const node of view.dom.querySelectorAll('.cm-announced > div')) {
    const value = node.textContent ?? ''
    const safe = redactIPs(value)
    if (safe !== value) node.textContent = safe
  }
}

/** Match against the full document, then mask intersections with copied ranges. */
export function redactEditorClipboard(value: string, state: EditorState): string {
  const lineBreak = (text: string) => state.lineBreak === '\n' ? text : text.replace(/\n/g, state.lineBreak)
  const fragment = (from: number, to: number) => {
    const raw = state.doc.sliceString(from, to)
    const sensitive = editorPrivateRanges(state, [{ from, to }], clipboardCache)
    let safe = '', offset = from
    for (const range of sensitive) {
      if (range.end <= from) continue
      if (range.start >= to) break
      const start = Math.max(from, range.start), end = Math.min(to, range.end)
      safe += raw.slice(offset - from, start - from) + '•'.repeat(end - start)
      offset = end
    }
    return { raw: lineBreak(raw), safe: lineBreak(safe + raw.slice(offset - from)) }
  }
  // This mirrors CodeMirror's copiedRange: nonempty selections are joined by
  // the configured line separator. With only cursors, each unique line is
  // copied once, without its final newline.
  const selected = state.selection.ranges.filter((range) => !range.empty)
  const pieces = selected.length ? selected.map((range) => fragment(range.from, range.to)) : (() => {
    const result: { raw: string; safe: string }[] = []
    let previousLine = -1
    for (const range of state.selection.ranges) {
      const line = state.doc.lineAt(range.from)
      if (line.number > previousLine) result.push(fragment(line.from, line.to))
      previousLine = line.number
    }
    return result
  })()
  if (value === pieces.map((piece) => piece.raw).join(state.lineBreak)) return pieces.map((piece) => piece.safe).join(state.lineBreak)
  // Dragging a selection uses only its main range, even with several cursors.
  const main = fragment(state.selection.main.from, state.selection.main.to)
  if (value === main.raw) return main.safe
  // Another output transform can make source positions ambiguous. If this
  // document contains sensitive text, fail closed rather than rematching a
  // possibly partial secret. Preserve line separators and string width.
  return findIPRanges(state.doc.toString()).length ? value.replace(/[^\r\n]/g, '•') : redactIPs(value)
}
const clipboardCache = new EditorPrivacyCache()

/** Only rendered text changes. Saving/running still uses the original document. */
export function streamPrivacyExtension(enabled: boolean): Extension {
  if (!enabled) return []
  const privacy = ViewPlugin.fromClass(class {
      decorations: DecorationSet
      private readonly cache = new EditorPrivacyCache()
      constructor(view: EditorView) { this.decorations = masks(view, this.cache); maskAnnouncements(view) }
      update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = masks(update.view, this.cache) }
    }, {
      decorations: (plugin) => plugin.decorations,
      provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
    })
  return [
    privacy,
    EditorView.updateListener.of((update) => maskAnnouncements(update.view)),
    EditorView.clipboardOutputFilter.of(redactEditorClipboard)
  ]
}
