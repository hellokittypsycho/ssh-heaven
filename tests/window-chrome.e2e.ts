import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { THEME_PRESETS } from '../src/theme'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-chrome-e2e-'))
const dataDirectory = path.join(temporary, 'settings')
const screenshots = path.join(root, 'test-results')
const background = process.env.SSH_HEAVEN_BACKGROUND_TEST === '1'
await mkdir(dataDirectory)
await mkdir(screenshots, { recursive: true })
let app: ElectronApplication | undefined
const rendererErrors: string[] = []
let accentSkipReported = false
interface WindowState { platform: string; maximized: boolean; fullscreen: boolean; focused: boolean }
interface ChromeProbe { events: WindowState[] }
type ThemePreset = typeof THEME_PRESETS[number]

async function assertHidden() {
  if (!background || !app) return
  const probe = await app.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })),
    events: (globalThis as unknown as { chromeVisibilityEvents?: string[] }).chromeVisibilityEvents ?? [],
  }))
  assert.ok(probe.windows.every((window) => !window.visible && !window.focused && window.offscreen), 'Background chrome tests must keep every window hidden, unfocused and offscreen')
  assert.deepEqual(probe.events, [], 'Background chrome tests must never show or focus a native window')
}

async function launch(): Promise<Page> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({
    executablePath: executable || require('electron') as string,
    args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000
  })
  const page = await app.firstWindow()
  if (background) await app.evaluate(({ BrowserWindow }) => {
    const events: string[] = []
    ;(globalThis as unknown as { chromeVisibilityEvents: string[] }).chromeVisibilityEvents = events
    for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => events.push('show')); window.on('focus', () => events.push('focus')) }
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  await expect(page.locator('.app-titlebar')).toBeVisible()
  await page.evaluate(() => {
    const probe: ChromeProbe = { events: [] }
    ;(window as unknown as { chromeProbe: ChromeProbe }).chromeProbe = probe
    window.sshHeaven.onWindowState((state) => probe.events.push(state))
  })
  await assertHidden()
  return page
}

async function actualWindow() {
  return app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return {
      state: { platform: process.platform, maximized: window.isMaximized(), fullscreen: window.isFullScreen(), focused: window.isFocused() },
      minimized: window.isMinimized(), bounds: window.getBounds(), contentBounds: window.getContentBounds(), background: window.getBackgroundColor(),
      accent: process.platform === 'win32' ? window.getAccentColor() : undefined
    }
  })
}

async function assertWindowState(page: Page, expected: Partial<WindowState> = {}) {
  await assertHidden()
  await expect.poll(async () => (await actualWindow()).state).toMatchObject(expected)
  const actual = (await actualWindow()).state
  await expect.poll(() => page.evaluate(() => window.sshHeaven.getWindowState())).toEqual(actual)
  const frame = page.locator('.window-frame')
  await expect(frame).toHaveAttribute('data-platform', actual.platform)
  await expect(frame).toHaveAttribute('data-maximized', String(actual.maximized))
  await expect(frame).toHaveAttribute('data-fullscreen', String(actual.fullscreen))
  await expect(frame).toHaveAttribute('data-focused', String(actual.focused))
  return actual
}

async function nativeAction(action: 'maximize' | 'unmaximize' | 'minimize' | 'restore' | 'blur' | 'focus' | 'fullscreen' | 'windowed') {
  if (background) throw new Error(`Native ${action} is forbidden in background-only tests`)
  await app!.evaluate(({ BrowserWindow }, operation) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (operation === 'fullscreen' || operation === 'windowed') window.setFullScreen(operation === 'fullscreen')
    else window[operation]()
  }, action)
}

async function assertTitlebar(page: Page) {
  await expect(page.getByRole('tablist', { name: 'Connection sessions', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab')).toHaveCount(0)
  for (const name of ['Open home', 'Open scripts', 'Open vault']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  const dimensions = await page.locator('.app-titlebar').evaluate((element) => {
    const rectangle = element.getBoundingClientRect()
    const draggable = [element, ...element.querySelectorAll('*')].some((child) => getComputedStyle(child).getPropertyValue('-webkit-app-region') === 'drag')
    return { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height, viewport: innerWidth, draggable }
  })
  assert.equal(dimensions.x, 0)
  assert.equal(dimensions.y, 0)
  assert.ok(Math.abs(dimensions.height - 38) <= 1, `Expected a 38px custom titlebar, received ${dimensions.height}px`)
  assert.ok(Math.abs(dimensions.width - dimensions.viewport) <= 1, 'The custom titlebar must span the window content')
  assert.equal(dimensions.draggable, true, 'The custom titlebar must declare native drag-region CSS; physical movement is verified separately')
  const regions = await page.evaluate(() => ({
    header: getComputedStyle(document.querySelector('.topbar')!).getPropertyValue('-webkit-app-region'),
    tabs: document.querySelector('.ssh-session-strip') ? getComputedStyle(document.querySelector('.ssh-session-strip')!).getPropertyValue('-webkit-app-region') : null,
    controls: [...document.querySelectorAll('.topbar button,[role="tablist"][aria-label="Connection sessions"] button')].map((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
  }))
  assert.equal(regions.header, 'drag'); assert.equal(regions.tabs, null)
  assert.ok(regions.controls.every((value) => value === 'no-drag'), 'Workspace header controls must remain outside drag regions')
  if (process.platform === 'win32' && !background) {
    await expect.poll(() => page.evaluate(() => (navigator as Navigator & { windowControlsOverlay?: { visible: boolean } }).windowControlsOverlay?.visible ?? false)).toBe(true)
    const overlay = await page.evaluate(() => {
      const control = (navigator as Navigator & { windowControlsOverlay: { visible: boolean; getTitlebarAreaRect(): DOMRect } }).windowControlsOverlay
      const rectangle = control.getTitlebarAreaRect()
      return { visible: control.visible, x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height, viewport: innerWidth }
    })
    assert.ok(overlay.visible && overlay.width > 0 && overlay.height > 0, 'Native caption buttons must have an active Windows overlay')
    assert.ok(overlay.width < overlay.viewport, 'Titlebar content must leave room for native minimize/maximize/close buttons')
    assert.ok(Math.abs(overlay.height - 38) <= 1, 'The native overlay and custom titlebar heights must agree')
    const content = await page.locator('.window-titlebar-content').boundingBox()
    assert.ok(content && content.x >= overlay.x - 1 && content.x + content.width <= overlay.x + overlay.width + 1, 'The titlebar content must not overlap the reserved native window buttons')
  }
  await assertHidden()
}

function opaqueHex(value: string): string {
  let hex = value.toLowerCase()
  if (/^#ff[0-9a-f]{6}$/.test(hex)) hex = `#${hex.slice(3)}`
  else if (/^#[0-9a-f]{6}ff$/.test(hex)) hex = hex.slice(0, 7)
  return hex
}

async function chooseTheme(page: Page, theme: ThemePreset) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true })
  await dialog.getByRole('radio', { name: theme.name, exact: true }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
  await expect.poll(() => app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(theme.appearance)
  await expect.poll(async () => opaqueHex((await actualWindow()).background)).toBe(theme.colors.bg.toLowerCase())
  const accent = (await actualWindow()).accent
  if (process.platform === 'win32' && (!background || typeof accent === 'string')) {
    await expect.poll(async () => String((await actualWindow()).accent).replace(/^#/, '').toLowerCase()).toBe(theme.colors['border-strong'].replace(/^#/, '').toLowerCase())
  } else if (process.platform === 'win32' && background && !accentSkipReported) {
    accentSkipReported = true
    console.log('Background chrome: native accent-border color is unavailable on the offscreen window; that OS-only assertion is skipped.')
  }
  const actualBackground = await page.locator('.app-titlebar').evaluate((element) => getComputedStyle(element).backgroundColor)
  const expectedBackground = await page.evaluate((color) => {
    const element = document.createElement('span')
    element.style.backgroundColor = color
    document.body.append(element)
    const result = getComputedStyle(element).backgroundColor
    element.remove()
    return result
  }, theme.colors.bg)
  assert.equal(actualBackground, expectedBackground, 'Custom and native window backgrounds must track the selected theme')
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await assertHidden()
}

try {
  let page = await launch()
  await assertWindowState(page, { maximized: false, fullscreen: false })
  await assertTitlebar(page)
  const dark = THEME_PRESETS.find((theme) => theme.appearance === 'dark')!
  const light = THEME_PRESETS.find((theme) => theme.appearance === 'light')!
  await chooseTheme(page, dark)
  if (!background) { await nativeAction('focus'); await assertWindowState(page, { focused: true }) }
  await page.screenshot({ path: path.join(screenshots, 'chrome-dark.png') })

  if (background) {
    console.log('Background chrome scope: hidden offscreen CSS/theme/geometry/control checks; native caption overlay, physical drag, OS focus, maximize, minimize and fullscreen are not exercised.')
    await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1920, 1080))
    await assertWindowState(page, { maximized: false, fullscreen: false, focused: false })
    await assertTitlebar(page)
  } else {
  await nativeAction('maximize')
  await assertWindowState(page, { maximized: true })
  await assertTitlebar(page)
  await nativeAction('unmaximize')
  await assertWindowState(page, { maximized: false })
  await nativeAction('blur')
  await assertWindowState(page, { focused: false })
  await nativeAction('focus')
  await assertWindowState(page, { focused: true })
  await nativeAction('minimize')
  await expect.poll(async () => (await actualWindow()).minimized).toBe(true)
  await assertWindowState(page)
  await nativeAction('restore')
  await nativeAction('focus')
  await expect.poll(async () => (await actualWindow()).minimized).toBe(false)
  await assertWindowState(page, { focused: true })
  await nativeAction('fullscreen')
  await assertWindowState(page, { fullscreen: true })
  await expect(page.locator('.app-titlebar')).toBeHidden()
  await nativeAction('windowed')
  await assertWindowState(page, { fullscreen: false })
  await nativeAction('unmaximize')
  await assertWindowState(page, { maximized: false })
  await assertTitlebar(page)
  }

  const browserWindow = await app!.browserWindow(page)
  await browserWindow.evaluate((window) => window.setSize(900, 680))
  await expect.poll(async () => (await actualWindow()).bounds.width).toBe(900)
  await assertHidden()
  await assertTitlebar(page)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'The minimum desktop size must not gain horizontal overflow')
  const statusbar = await page.locator('.app-statusbar').boundingBox()
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  assert.ok(statusbar && statusbar.y + statusbar.height <= viewport.height + 1, 'The custom titlebar must leave the bottom statusbar inside the window')
  await page.screenshot({ path: path.join(screenshots, 'chrome-compact.png') })
  await browserWindow.evaluate((window) => window.setSize(1440, 920))
  await assertHidden()
  await chooseTheme(page, light)
  await assertTitlebar(page)
  await page.screenshot({ path: path.join(screenshots, 'chrome-light.png') })

  const backgroundBeforeInvalid = (await actualWindow()).background
  await page.evaluate(async () => {
    const invalid = { appearance: 'light', background: 'url(https://invalid.example)', foreground: '#000000', border: '#cccccc' }
    let rejected = false
    try { await window.sshHeaven.setWindowAppearance(invalid as Parameters<typeof window.sshHeaven.setWindowAppearance>[0]) } catch { rejected = true }
    if (!rejected) throw new Error('Invalid native window colors must be rejected')
  })
  assert.equal((await actualWindow()).background, backgroundBeforeInvalid)
  const events = await page.evaluate(() => (window as unknown as { chromeProbe: ChromeProbe }).chromeProbe.events)
  if (background) {
    assert.ok(events.every((event) => !event.focused && !event.maximized && !event.fullscreen))
    await assertHidden()
  } else {
    assert.ok(events.some((event) => event.maximized), 'A real maximize event must reach the renderer')
    assert.ok(events.some((event) => event.fullscreen), 'A real full-screen event must reach the renderer')
    assert.ok(events.some((event) => !event.focused), 'Focus-loss events must reach the renderer')
  }
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await expect(page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Open home', exact: true }).click()
  await assertHidden()
  await app!.close()
  app = undefined
  page = await launch()
  await expect(page.locator('html')).toHaveAttribute('data-theme', light.id)
  await expect.poll(async () => opaqueHex((await actualWindow()).background)).toBe(light.colors.bg.toLowerCase())
  await assertWindowState(page)
  await assertTitlebar(page)
  assert.deepEqual(rendererErrors, [], `Renderer exceptions: ${rendererErrors.join(', ')}`)
  console.log(background ? 'Background window chrome E2E passed: hidden offscreen renderer, titlebar/header drag CSS and sidebar navigation without an empty session strip, large/compact geometry, available native color APIs, persistent themes, and screenshots. Native physical movement/overlay/window-state actions remain unverified in this run.' : 'Window chrome E2E passed: themed custom titlebar, native Windows overlay geometry, real maximize/restore/minimize/fullscreen/focus state synchronization, sidebar navigation, compact layout, validated native colors, persistent appearance, and dark/light screenshots.')
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => undefined)
    await page?.screenshot({ path: path.join(screenshots, 'chrome-failure.png') }).catch(() => {})
    if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 6000))
  }
  throw error
} finally {
  try { await assertHidden() }
  finally {
    try { await app?.close() }
    finally {
      assert.equal(path.dirname(temporary), path.resolve(tmpdir()))
      assert.ok(path.basename(temporary).startsWith('ssh-heaven-chrome-e2e-'))
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
