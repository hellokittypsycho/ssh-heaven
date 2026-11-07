import { useSyncExternalStore } from 'react'
import type { ITheme } from '@xterm/xterm'

export const THEME_STORAGE_KEY = 'ssh-heaven:theme'
export const DEFAULT_THEME_ID = 'graphite'
export type ThemeToken = 'bg' | 'sidebar' | 'surface' | 'surface-raised' | 'surface-hover' | 'surface-active' | 'input' | 'border' | 'border-strong' | 'text' | 'text-secondary' | 'text-muted' | 'accent' | 'accent-hover' | 'accent-soft' | 'accent-border' | 'on-accent' | 'success' | 'success-soft' | 'warning' | 'warning-soft' | 'danger' | 'danger-soft' | 'shadow' | 'terminal-bg' | 'terminal-fg'
export interface ThemePreset {
  id: string
  name: string
  description: string
  appearance: 'dark' | 'light'
  colors: Record<ThemeToken, string>
  terminal: ITheme
}
interface Palette {
  id: string; name: string; description: string; appearance?: 'dark' | 'light'
  bg: string; sidebar: string; surface: string; raised: string; input: string
  text: string; secondary: string; muted: string; accent: string; hover: string; ink: string; terminal: string
}
function mix(first: string, second: string, weight: number): string {
  const components = [1, 3, 5].map((index) => Math.round(parseInt(first.slice(index, index + 2), 16) * (1 - weight) + parseInt(second.slice(index, index + 2), 16) * weight))
  return `#${components.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}
function makeTheme(palette: Palette): ThemePreset {
  const light = palette.appearance === 'light'
  const success = light ? '#247348' : '#91d7b1'
  const warning = light ? '#8c5c12' : '#e9c784'
  const danger = light ? '#b22f4b' : '#f59baa'
  const colors: Record<ThemeToken, string> = {
    bg: palette.bg, sidebar: palette.sidebar, surface: palette.surface, 'surface-raised': palette.raised,
    'surface-hover': mix(palette.surface, palette.text, .045), 'surface-active': mix(palette.surface, palette.accent, .14), input: palette.input,
    border: mix(palette.bg, palette.text, light ? .13 : .11), 'border-strong': mix(palette.bg, palette.text, .22),
    text: palette.text, 'text-secondary': palette.secondary, 'text-muted': palette.muted,
    accent: palette.accent, 'accent-hover': palette.hover, 'accent-soft': mix(palette.surface, palette.accent, .10),
    'accent-border': mix(palette.surface, palette.accent, .4), 'on-accent': palette.ink,
    success, 'success-soft': mix(palette.surface, success, .10), warning, 'warning-soft': mix(palette.surface, warning, .10),
    danger, 'danger-soft': mix(palette.surface, danger, .10),
    shadow: light ? '0 20px 70px #26223916, 0 2px 10px #26223909' : '0 24px 80px #00000040, 0 2px 12px #00000020',
    'terminal-bg': palette.terminal, 'terminal-fg': palette.text
  }
  const terminal: ITheme = {
    background: palette.terminal, foreground: palette.text, cursor: palette.accent, cursorAccent: palette.terminal,
    selectionBackground: `${palette.accent}38`, selectionInactiveBackground: `${palette.accent}24`,
    black: light ? '#242736' : '#242631', red: light ? '#b62440' : '#f28b96', green: light ? '#267843' : '#91d3a7',
    yellow: light ? '#936410' : '#edca82', blue: light ? '#275fbb' : '#8cb9f8', magenta: light ? '#8547b6' : '#c7a1f5',
    cyan: light ? '#08778c' : '#7ed5da', white: light ? '#4c5265' : '#dde1ee', brightBlack: light ? '#646a7e' : '#9295a8',
    brightRed: light ? '#a61535' : '#ffadb5', brightGreen: light ? '#176b36' : '#b3edc6', brightYellow: light ? '#805509' : '#ffe0a3',
    brightBlue: light ? '#164f9f' : '#abcfff', brightMagenta: light ? '#7533a7' : '#dfc0ff', brightCyan: light ? '#02677b' : '#a1edf0',
    brightWhite: light ? '#202433' : '#f7f8ff'
  }
  return { id: palette.id, name: palette.name, description: palette.description, appearance: light ? 'light' : 'dark', colors, terminal }
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  makeTheme({ id: 'graphite', name: 'Graphite', description: 'Quiet charcoal. A little violet.', bg: '#101014', sidebar: '#151519', surface: '#1b1b22', raised: '#24242d', input: '#141419', text: '#eeeeF5', secondary: '#c3c3d2', muted: '#a0a0b3', accent: '#b6a4ff', hover: '#c6b8ff', ink: '#201a40', terminal: '#111116' }),
  makeTheme({ id: 'midnight', name: 'Midnight', description: 'Deep navy with cool blue accents.', bg: '#0d1220', sidebar: '#111827', surface: '#182032', raised: '#212c41', input: '#101726', text: '#edf2fc', secondary: '#c2cde2', muted: '#9caecb', accent: '#94b8ff', hover: '#afcaff', ink: '#142343', terminal: '#0d1320' }),
  makeTheme({ id: 'ocean', name: 'Ocean', description: 'Clear cyan on deep ocean tones.', bg: '#0c171e', sidebar: '#101f28', surface: '#172731', raised: '#21343f', input: '#0e1d26', text: '#e7f5fa', secondary: '#b6d3df', muted: '#91b2c1', accent: '#73d9e6', hover: '#98e6ef', ink: '#073039', terminal: '#0b171e' }),
  makeTheme({ id: 'forest', name: 'Forest', description: 'Soft sage and earthy dark greens.', bg: '#121a16', sidebar: '#17211c', surface: '#1e2b23', raised: '#29382e', input: '#152019', text: '#ecf5ed', secondary: '#c3d6c8', muted: '#a0b9a7', accent: '#a0d9b4', hover: '#bce8c9', ink: '#152b1e', terminal: '#101a14' }),
  makeTheme({ id: 'amethyst', name: 'Amethyst', description: 'Rich plum with a lavender glow.', bg: '#19131f', sidebar: '#211929', surface: '#2a2133', raised: '#372b42', input: '#1d1625', text: '#f5edf9', secondary: '#d5c6df', muted: '#b5a1c3', accent: '#d0aff7', hover: '#dfc6fc', ink: '#321c42', terminal: '#17111e' }),
  makeTheme({ id: 'ember', name: 'Ember', description: 'Warm charcoal and soft copper.', bg: '#1c1613', sidebar: '#251c18', surface: '#2e241f', raised: '#3b2e27', input: '#211914', text: '#fcf0e9', secondary: '#dfc8ba', muted: '#c0a494', accent: '#f4b48d', hover: '#ffcca9', ink: '#3a2115', terminal: '#1a1411' }),
  makeTheme({ id: 'pink', name: 'Pink', description: 'Dark rose with luminous pink accents.', bg: '#20131c', sidebar: '#281923', surface: '#30202b', raised: '#3d2a36', input: '#261720', text: '#fff0f7', secondary: '#e3c4d5', muted: '#c5a2b7', accent: '#f5a6cf', hover: '#ffc2df', ink: '#40152e', terminal: '#1c1018' }),
  makeTheme({ id: 'daylight', name: 'Daylight', description: 'Clean ivory with crisp violet.', appearance: 'light', bg: '#f6f7fb', sidebar: '#eeeff5', surface: '#ffffff', raised: '#ffffff', input: '#f7f8fc', text: '#292c3b', secondary: '#4e5469', muted: '#61677a', accent: '#6750d8', hover: '#5940c8', ink: '#ffffff', terminal: '#fcfcff' })
]

export function getThemePreset(id: unknown): ThemePreset {
  return THEME_PRESETS.find((preset) => preset.id === id) ?? THEME_PRESETS[0]
}
function storedTheme(): string {
  try { return getThemePreset(globalThis.localStorage?.getItem(THEME_STORAGE_KEY)).id } catch { return DEFAULT_THEME_ID }
}
let currentId = storedTheme()
const subscribers = new Set<() => void>()

export function applyTheme(preset: ThemePreset): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.theme = preset.id
  root.dataset.appearance = preset.appearance
  root.style.colorScheme = preset.appearance
  for (const [key, value] of Object.entries(preset.colors)) root.style.setProperty(`--${key}`, value)
  if (typeof window !== 'undefined' && window.sshHeaven?.setWindowAppearance) {
    void window.sshHeaven.setWindowAppearance({ appearance: preset.appearance, background: preset.colors.bg, foreground: preset.colors.text, border: preset.colors['border-strong'] }).catch(() => {})
  } else if (typeof window !== 'undefined' && window.sshHeaven?.setNativeTheme) void window.sshHeaven.setNativeTheme(preset.appearance).catch(() => {})
}
export function setTheme(id: string): void {
  const preset = getThemePreset(id)
  currentId = preset.id
  applyTheme(preset)
  try { globalThis.localStorage?.setItem(THEME_STORAGE_KEY, preset.id) } catch { /* Keep the live selection when storage is unavailable. */ }
  for (const subscriber of subscribers) subscriber()
}
function subscribe(callback: () => void) { subscribers.add(callback); return () => { subscribers.delete(callback) } }
export function useTheme() {
  const id = useSyncExternalStore(subscribe, () => currentId, () => DEFAULT_THEME_ID)
  return { preset: getThemePreset(id), setTheme }
}

applyTheme(getThemePreset(currentId))
if (typeof window !== 'undefined') {
  const sync = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return
    currentId = getThemePreset(event.newValue).id
    applyTheme(getThemePreset(currentId))
    for (const subscriber of subscribers) subscriber()
  }
  window.addEventListener('storage', sync)
  if (import.meta.hot) import.meta.hot.dispose(() => window.removeEventListener('storage', sync))
}
