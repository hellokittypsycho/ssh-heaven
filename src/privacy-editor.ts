import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { findIPRanges, redactIPs } from '../shared/ip-redaction'

class MaskedAddress extends WidgetType {
  constructor(readonly length: number) { super() }
  eq(other: MaskedAddress): boolean { return this.length === other.length }
  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'stream-private-widget'
    element.textContent = '•'.repeat(this.length)
    element.setAttribute('aria-label', 'Hidden IP address')
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

/** Only rendered text changes. Saving/running still uses the original document. */
export function streamPrivacyExtension(enabled: boolean): Extension {
  if (!enabled) return []
  return [
    ViewPlugin.fromClass(class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = masks(view); maskAnnouncements(view) }
      update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = masks(update.view) }
    }, { decorations: (plugin) => plugin.decorations }),
    EditorView.updateListener.of((update) => maskAnnouncements(update.view)),
    EditorView.clipboardOutputFilter.of((value) => redactIPs(value))
  ]
}
