import { findIPRanges, redactIPs } from '../../shared/ip-redaction'
import { isStreamModeEnabled } from '../stream-mode'

function text(value: unknown): unknown {
  if (typeof value === 'string') return redactIPs(value)
  if (!Array.isArray(value)) return value
  const result: unknown[] = []
  let run: { index: number; original: string | number }[] = []
  const flush = () => {
    const original = run.map((item) => String(item.original)).join('')
    const masked = redactIPs(original)
    let offset = 0
    if (masked !== original) for (const item of run) {
      const length = String(item.original).length
      result[item.index] = masked.slice(offset, offset + length)
      offset += length
    }
    run = []
  }
  for (const child of value) {
    if (typeof child === 'string' || typeof child === 'number') { run.push({ index: result.length, original: child }); result.push(child) }
    else if (child == null || typeof child === 'boolean') result.push(child)
    else { flush(); result.push(text(child)) }
  }
  flush()
  return result
}
function optionText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(optionText).join('')
  return ''
}

/** Mask presentation at the DOM boundary; component props and form models stay raw. */
export function privateProps(type: unknown, props: unknown): unknown {
  if (!isStreamModeEnabled() || typeof type !== 'string' || !props || typeof props !== 'object') return props
  const input = props as Record<string, unknown>
  const result = { ...input }
  if ('children' in input) result.children = text(input.children)
  // An option's text is its submitted value unless value is explicit. Keep
  // that model value intact while masking only the dropdown's visible label.
  if (type === 'option' && input.value === undefined) result.value = optionText(input.children).replace(/[\t\n\f\r ]+/g, ' ').trim()
  if (type === 'textarea' && input.value === undefined && input.defaultValue === undefined && typeof input.children === 'string') {
    result.defaultValue = input.children
    delete result.children
  }
  for (const name of ['title', 'aria-label', 'aria-description', 'aria-valuetext', 'alt', 'label', 'placeholder']) {
    if (typeof input[name] === 'string') result[name] = redactIPs(input[name])
  }
  // Text controls retain the actual value for editing/submission. CSS masks
  // their glyphs while sharing the screen, including values typed mid-session.
  const value = input.value ?? input.defaultValue ?? (type === 'textarea' ? input.children : undefined)
  if ((type === 'input' || type === 'textarea') && typeof value === 'string' && findIPRanges(value).length) result['data-stream-private-input'] = 'true'
  return result
}
