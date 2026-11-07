import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_THEME_ID, getThemePreset, THEME_PRESETS } from '../src/theme'

const tokens = ['bg', 'sidebar', 'surface', 'surface-raised', 'surface-hover', 'surface-active', 'input', 'border', 'border-strong', 'text', 'text-secondary', 'text-muted', 'accent', 'accent-hover', 'accent-soft', 'accent-border', 'on-accent', 'success', 'success-soft', 'warning', 'warning-soft', 'danger', 'danger-soft', 'shadow', 'terminal-bg', 'terminal-fg'].sort()
const ansiColors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

function rgb(value: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  assert.ok(hex, `Contrast colors must be opaque hex values: ${value}`)
  const full = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1]
  return [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16) / 255) as [number, number, number]
}

function luminance(value: string): number {
  const [red, green, blue] = rgb(value).map((component) => component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
  return (values[1] + 0.05) / (values[0] + 0.05)
}

test('theme identities and CSS token sets are complete and unknown saved themes fall back safely', () => {
  assert.ok(THEME_PRESETS.length >= 2)
  assert.ok(THEME_PRESETS.some((theme) => theme.appearance === 'dark'))
  assert.ok(THEME_PRESETS.some((theme) => theme.appearance === 'light'))
  assert.equal(new Set(THEME_PRESETS.map((theme) => theme.id)).size, THEME_PRESETS.length)
  assert.equal(new Set(THEME_PRESETS.map((theme) => theme.name)).size, THEME_PRESETS.length)
  for (const theme of THEME_PRESETS) {
    assert.match(theme.id, /^[a-z][a-z0-9-]*$/)
    assert.ok(theme.name.trim() && theme.description.trim())
    assert.deepEqual(Object.keys(theme.colors).sort(), tokens, `${theme.id} must define every shared CSS token`)
    assert.equal(getThemePreset(theme.id).id, theme.id)
  }
  for (const unknown of [undefined, null, '', 'not-a-theme', {}, 123]) assert.equal(getThemePreset(unknown).id, DEFAULT_THEME_ID)
})

for (const theme of THEME_PRESETS) {
  test(`${theme.name} keeps interface text, primary buttons, and terminal text readable`, () => {
    for (const background of ['bg', 'sidebar', 'surface', 'surface-raised', 'input'] as const) {
      for (const foreground of ['text', 'text-secondary', 'text-muted'] as const) {
        const ratio = contrast(theme.colors[foreground], theme.colors[background])
        assert.ok(ratio >= 4.5, `${theme.id}: ${foreground} on ${background} contrast is ${ratio.toFixed(2)}:1; normal text needs 4.5:1`)
      }
    }
    for (const background of ['accent', 'accent-hover'] as const) {
      const ratio = contrast(theme.colors['on-accent'], theme.colors[background])
      assert.ok(ratio >= 4.5, `${theme.id}: primary button text on ${background} contrast is ${ratio.toFixed(2)}:1`)
    }
    assert.equal(theme.terminal.background?.toLowerCase(), theme.colors['terminal-bg'].toLowerCase())
    assert.equal(theme.terminal.foreground?.toLowerCase(), theme.colors['terminal-fg'].toLowerCase())
    assert.ok(contrast(theme.terminal.foreground!, theme.terminal.background!) >= 4.5, `${theme.id}: terminal text needs 4.5:1 contrast`)
    assert.ok(contrast(theme.terminal.cursor!, theme.terminal.background!) >= 3, `${theme.id}: terminal cursor must remain visible`)
  })

  test(`${theme.name} supplies the complete terminal ANSI palette and selection colors`, () => {
    for (const color of [...ansiColors, 'background', 'foreground', 'cursor', 'selectionBackground'] as const) {
      const value = theme.terminal[color]
      assert.equal(typeof value, 'string', `${theme.id}: terminal ${color} is missing`)
      assert.match(value!, /^#[0-9a-f]{3}(?:[0-9a-f]{3}|[0-9a-f]{5})?$|^rgba?\([\d\s.,%]+\)$/i, `${theme.id}: terminal ${color} is not a valid color`)
    }
    assert.notEqual(theme.terminal.selectionBackground, theme.terminal.background, `${theme.id}: selected terminal text needs a visible highlight`)
  })
}
