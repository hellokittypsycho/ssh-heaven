import { BrowserWindow, ipcMain, nativeTheme, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import type { WindowAppearance, WindowState } from '../shared/types'
import { channels } from './channels'
import { record } from './validation'

export const TITLE_BAR_HEIGHT = 38
let appearance: WindowAppearance = { appearance: 'dark', background: '#101014', foreground: '#eeeef5', border: '#41414b' }

export function windowChromeOptions(): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'darwin' ? { height: TITLE_BAR_HEIGHT } : {
      color: appearance.background, symbolColor: appearance.foreground, height: TITLE_BAR_HEIGHT
    },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 12 } } : {}),
    backgroundColor: appearance.background,
    roundedCorners: true
  }
}
function state(window: BrowserWindow): WindowState {
  return { platform: process.platform, maximized: window.isMaximized(), fullscreen: window.isFullScreen(), focused: window.isFocused() }
}
function apply(window: BrowserWindow): void {
  nativeTheme.themeSource = appearance.appearance
  window.setBackgroundColor(appearance.background)
  if (process.platform !== 'darwin') {
    window.setTitleBarOverlay({ color: appearance.background, symbolColor: appearance.foreground, height: TITLE_BAR_HEIGHT })
  }
  if (process.platform === 'win32') window.setAccentColor(appearance.border)
}
export function bindWindowChrome(window: BrowserWindow): void {
  apply(window)
  const publish = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channels.windowState, state(window))
  }
  window.on('maximize', publish)
  window.on('unmaximize', publish)
  window.on('enter-full-screen', publish)
  window.on('leave-full-screen', publish)
  window.on('focus', publish)
  window.on('blur', publish)
  window.on('minimize', publish)
  window.on('restore', publish)
  window.on('show', publish)
  window.webContents.on('did-finish-load', publish)
}
export function registerWindowChromeIpc(owner: (event: IpcMainInvokeEvent) => BrowserWindow): void {
  ipcMain.handle(channels.getWindowState, (event) => state(owner(event)))
  ipcMain.handle(channels.setWindowAppearance, (event, value: unknown) => {
    const window = owner(event)
    const input = record(value, 'window appearance')
    if (input.appearance !== 'dark' && input.appearance !== 'light') throw new Error('Invalid window appearance.')
    for (const name of ['background', 'foreground', 'border']) {
      if (typeof input[name] !== 'string' || !/^#[a-f0-9]{6}$/i.test(input[name] as string)) throw new Error('Window colors must use six-digit hexadecimal values.')
    }
    appearance = { appearance: input.appearance, background: input.background as string, foreground: input.foreground as string, border: input.border as string }
    apply(window)
  })
}
