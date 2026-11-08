import type { IBufferCell, IMarker, Terminal } from '@xterm/xterm'
import { redactSensitiveText as redactIPs } from './stream-rules'

interface Row { text: string; masked: string; wrapped: boolean; ansi: string }
interface Snapshot { rows: Row[]; count: number; changed: Set<number>; historyChanged: boolean; wrappingChanged: boolean; cols: number; height: number; base: number; type: string; cursorX: number; cursorY: number }

function cellStyle(cell: IBufferCell): string {
  if (cell.isAttributeDefault()) return '\x1b[0m'
  const codes = [0]
  if (cell.isBold()) codes.push(1)
  if (cell.isDim()) codes.push(2)
  if (cell.isItalic()) codes.push(3)
  if (cell.isUnderline()) codes.push(4)
  if (cell.isBlink()) codes.push(5)
  if (cell.isInverse()) codes.push(7)
  if (cell.isInvisible()) codes.push(8)
  if (cell.isStrikethrough()) codes.push(9)
  if (cell.isOverline()) codes.push(53)
  const color = (foreground: boolean) => {
    const value = foreground ? cell.getFgColor() : cell.getBgColor()
    if (foreground ? cell.isFgRGB() : cell.isBgRGB()) codes.push(foreground ? 38 : 48, 2, value >>> 16 & 255, value >>> 8 & 255, value & 255)
    else if (foreground ? cell.isFgPalette() : cell.isBgPalette()) codes.push(foreground ? 38 : 48, 5, value)
  }
  color(true); color(false)
  return `\x1b[${codes.join(';')}m`
}

/**
 * The source terminal stays canonical and its DOM is detached. Only sanitized
 * public-buffer cells enter the visible terminal; no parser/renderer internals
 * are patched. One-cell IP bullets preserve cursor positions and CJK widths.
 */
export class TerminalPrivacyRenderer {
  private previous?: Snapshot
  private marker?: IMarker
  private markerLine = 0
  private frame = 0
  private writing = false
  private dirty = true
  private force = true
  private disposed = false
  private first = true
  private rulesRevision = 0
  private shown = true
  constructor(private readonly raw: Terminal, private readonly visible: Terminal, private readonly host: HTMLElement, private readonly rendered: () => void, private readonly extraModes: ReadonlyMap<number, boolean> = new Map()) {}

  schedule(force = false): void {
    this.dirty = true; this.force ||= force
    if (this.shown && !this.writing && !this.frame && !this.disposed) this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint() })
  }
  /** Raw parsing continues outside this renderer. A hidden pane needs no
   * snapshots or mirror writes; its opaque curtain stays closed until catchup. */
  setVisible(shown: boolean): void {
    if (this.disposed || this.shown === shown) return
    this.shown = shown; this.rulesRevision++; this.dirty = true; this.force = true
    this.visible.clearSelection?.()
    this.host.dataset.streamReady = 'false'; this.host.setAttribute('aria-busy', 'true')
    if (!shown) { cancelAnimationFrame(this.frame); this.frame = 0 }
    else this.schedule(true)
  }
  refreshRules(): void { this.rulesRevision++; this.visible.clearSelection?.(); this.previous = undefined; this.host.dataset.streamReady = 'false'; this.schedule(true) }
  dispose(): void {
    this.disposed = true; cancelAnimationFrame(this.frame); this.marker?.dispose()
  }
  private snapshot(trim: number): Snapshot {
    const buffer = this.raw.buffer.active
    const reusable = this.previous && this.previous.cols === this.raw.cols && this.previous.height === this.raw.rows && this.previous.type === buffer.type ? this.previous : undefined
    let start = reusable ? Math.min(buffer.baseY, Math.max(0, reusable.base - trim)) : 0
    // Existing scrollback is immutable. Only inspect the live screen/newly
    // scrolled rows and enough of a wrapped predecessor for a split IP token.
    let prefix = 0
    while (start > 0 && buffer.getLine(start)?.isWrapped && prefix < 256) { start--; prefix += reusable!.rows[start + trim]?.text.length ?? this.raw.cols }
    const lines = Array.from({ length: buffer.length - start }, (_, index) => buffer.getLine(start + index)!)
    const strings = lines.map((line) => line.translateToString(false, 0, this.raw.cols))
    let joined = ''
    const offsets: number[] = []
    for (let index = 0; index < strings.length; index++) {
      if (index && !lines[index].isWrapped) joined += '\n'
      offsets.push(joined.length); joined += strings[index]
    }
    const masked = redactIPs(joined)
    const changed = new Set<number>()
    let historyChanged = false, wrappingChanged = false
    const updates = lines.map((line, localIndex): Row => {
      const index = localIndex + start
      const text = strings[localIndex], safe = masked.slice(offsets[localIndex], offsets[localIndex] + text.length)
      const cached = reusable?.rows[index + trim]
      if (cached && cached.wrapped !== line.isWrapped) wrappingChanged = true
      if (cached && index < buffer.baseY && (cached.masked !== safe || cached.wrapped !== line.isWrapped)) historyChanged = true
      // Scrollback cannot be edited by a cursor. Reuse its styles, but always
      // refresh rows that were on-screen during the previous parse batch.
      if (cached && index + trim < reusable!.base && index < buffer.baseY && cached.text === text && cached.masked === safe && cached.wrapped === line.isWrapped) return cached
      let ansi = '', previousStyle = '', offset = 0
      const cell = buffer.getNullCell()
      for (let column = 0; column < this.raw.cols; column++) {
        const value = line.getCell(column, cell)
        if (!value || value.getWidth() === 0) continue
        const chars = value.getChars() || ' '
        const style = cellStyle(value)
        if (style !== previousStyle) { ansi += style; previousStyle = style }
        const rendered = safe.slice(offset, offset + chars.length)
        ansi += rendered === chars ? chars : '•'.repeat(Math.max(1, value.getWidth()))
        offset += chars.length
      }
      const result = { text, masked: safe, wrapped: line.isWrapped, ansi: `${ansi}\x1b[0m` }
      if (!cached || result.ansi !== cached.ansi) changed.add(index)
      return result
    })
    // Keep the immutable history prefix in one backing array. Copying and
    // comparing 10,000 row references for every key in every pane causes GC
    // pressure even when only the live screen is translated.
    const rows = reusable?.rows ?? []
    if (trim) rows.splice(0, trim)
    for (let index = 0; index < updates.length; index++) rows[start + index] = updates[index]
    rows.length = buffer.length
    return { rows, count: buffer.length, changed, historyChanged, wrappingChanged, cols: this.raw.cols, height: this.raw.rows, base: buffer.baseY, type: buffer.type, cursorX: buffer.cursorX, cursorY: buffer.cursorY }
  }
  private inputModes(): string {
    const modes = this.raw.modes
    const set = (id: number, enabled: boolean) => `\x1b[?${id}${enabled ? 'h' : 'l'}`
    return set(1, modes.applicationCursorKeysMode) + set(66, modes.applicationKeypadMode) + set(2004, modes.bracketedPasteMode) + set(1004, modes.sendFocusMode) + [1005, 1006, 1007, 1015, 1016].map((id) => set(id, this.extraModes.get(id) === true)).join('') + [9, 1000, 1002, 1003].map((id) => set(id, false)).join('') + ({ none: '', x10: set(9, true), vt200: set(1000, true), drag: set(1002, true), any: set(1003, true) }[modes.mouseTrackingMode])
  }
  private paint(): void {
    if (this.disposed || !this.shown || !this.dirty) return
    const revision = this.rulesRevision
    this.dirty = false
    const old = this.previous
    const trim = this.marker ? this.marker.isDisposed ? old?.count ?? 0 : Math.max(0, this.markerLine - this.marker.line) : old?.type === 'normal' ? old.count : 0
    const next = this.snapshot(trim)
    const growth = old ? next.base - old.base + trim : 0
    const sameSize = old && old.cols === next.cols && old.height === next.height && old.type === next.type
    const canScroll = sameSize && growth > 0 && growth <= next.height && next.count === old.count + growth - trim && !next.rows.slice(Math.max(0, next.base - growth)).some((row) => row.wrapped)
    const sameRows = sameSize && !trim && growth === 0 && next.count === old.count && next.base === old.base
    const rebuild = this.force || !sameRows && !canScroll || sameRows && (next.historyChanged || next.wrappingChanged)
    this.force = false
    const viewport = this.first ? this.raw.buffer.active.viewportY : this.visible.buffer.active.viewportY
    const following = this.first ? viewport >= this.raw.buffer.active.baseY : viewport >= this.visible.buffer.active.baseY
    let output = '\x1b[?25l\x1b[?6l\x1b[4l\x1b[?7l'
    if (rebuild) {
      this.host.dataset.streamReady = 'false'; this.host.setAttribute('aria-busy', 'true')
      this.visible.reset()
      output += `${next.type === 'alternate' ? '\x1b[?1049h' : ''}\x1b[?7h`
      for (let index = 0; index < next.rows.length; index++) {
        if (index && !next.rows[index].wrapped) output += '\r\n'
        output += next.rows[index].ansi
      }
    } else {
      if (canScroll) {
        for (let index = 0; index < growth; index++) {
          const outgoing = next.rows[Math.max(0, old!.base - trim + index)]
          output += `\x1b[1;1H${outgoing.ansi}\x1b[${next.height};1H\r\n`
        }
      }
      for (let row = 0; row < next.height; row++) {
        const index = next.base + row, line = next.rows[index]
        if (line && (canScroll || next.changed.has(index))) output += `\x1b[${row + 1};1H${line.ansi}`
      }
    }
    output += `\x1b[0m\x1b[${next.cursorY + 1};${Math.min(next.cols, next.cursorX + 1)}H\x1b[?25${this.extraModes.get(25) === false ? 'l' : 'h'}${this.inputModes()}`
    this.marker?.dispose()
    if (this.raw.buffer.active.type === 'normal') { this.marker = this.raw.registerMarker(-this.raw.buffer.active.cursorY); this.markerLine = this.marker.line }
    else this.marker = undefined
    this.previous = next; this.first = false; this.writing = true
    this.visible.write(output, () => {
      if (this.disposed) return
      this.writing = false
      if (!this.shown) return
      if (revision !== this.rulesRevision) { this.schedule(true); return }
      if (following) this.visible.scrollToBottom()
      else this.visible.scrollToLine(Math.max(0, viewport - trim))
      this.host.dataset.streamReady = 'true'; this.host.setAttribute('aria-busy', 'false')
      this.rendered()
      if (this.dirty) this.schedule()
    })
  }
}
