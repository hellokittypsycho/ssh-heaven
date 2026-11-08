import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { findSensitiveRanges as findIPRanges, redactSensitiveText as redactIPs } from './stream-rules'

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

function masks(view: EditorView): DecorationSet {
  const ranges = new RangeSetBuilder<Decoration>()
  for (const visible of view.visibleRanges) {
    const value = view.state.doc.sliceString(visible.from, visible.to)
    for (const range of findIPRanges(value)) ranges.add(visible.from + range.start, visible.from + range.end, Decoration.replace({ widget: new MaskedAddress(range.end - range.start) }))
  }
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
  const document = state.doc.toString()
  const sensitive = findIPRanges(document)
  const lineBreak = (text: string) => state.lineBreak === '\n' ? text : text.replace(/\n/g, state.lineBreak)
  const fragment = (from: number, to: number) => {
    let safe = '', offset = from
    for (const range of sensitive) {
      if (range.end <= from) continue
      if (range.start >= to) break
      const start = Math.max(from, range.start), end = Math.min(to, range.end)
      safe += document.slice(offset, start) + '•'.repeat(end - start)
      offset = end
    }
    return { raw: lineBreak(document.slice(from, to)), safe: lineBreak(safe + document.slice(offset, to)) }
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
  return sensitive.length ? value.replace(/[^\r\n]/g, '•') : redactIPs(value)
}

/** Only rendered text changes. Saving/running still uses the original document. */
export function streamPrivacyExtension(enabled: boolean): Extension {
  if (!enabled) return []
  const privacy = ViewPlugin.fromClass(class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = masks(view); maskAnnouncements(view) }
      update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = masks(update.view) }
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
