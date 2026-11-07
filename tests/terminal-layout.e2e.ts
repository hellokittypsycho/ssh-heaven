import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-terminal-layout-'))
const dataDirectory = path.join(temporary, 'settings')
const background = process.env.SSH_HEAVEN_BACKGROUND_TEST === '1'
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixtures = await Promise.all(Array.from({ length: 4 }, () => startFixture()))
let app: ElectronApplication | undefined
let page: Page | undefined
let currentSessionId = ''
const rendererErrors: string[] = []
const activePane = () => page!.locator('.session-workspace.is-active-pane')
const visiblePanes = () => page!.locator('.session-workspace:not(.hidden-workspace)')

async function assertHidden() {
  if (!background || !app) return
  const probe = await app.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })),
    events: (globalThis as unknown as { terminalLayoutVisibilityEvents?: string[] }).terminalLayoutVisibilityEvents ?? [],
  }))
  assert.ok(probe.windows.every((window) => !window.visible && !window.focused && window.offscreen), 'Background terminal-layout tests must keep native windows hidden, unfocused and offscreen')
  assert.deepEqual(probe.events, [], 'Background terminal-layout tests must never show or focus a native window')
}

async function connectHost(name: string) {
  await page!.getByTitle(`Connect to ${name}`, { exact: true }).click()
  await page!.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(async () => {
    const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true })
    if (await trust.isVisible()) await trust.click()
    return activePane().locator('.terminal-footer').getByText('Connected', { exact: true }).count()
  }, { timeout: 20_000 }).toBe(1)
  currentSessionId = await page!.evaluate(() => (window as unknown as { terminalTestSessionId: string }).terminalTestSessionId)
}

async function output(lines: number, marker: string) {
  // The renderer's transport receives real SSH data. Sending remotely, rather
  // than typing in xterm, also lets us check that new output preserves scrollback.
  await page!.evaluate(({ lines, marker, sessionId }) => {
    if (!sessionId) throw new Error('No active SSH session')
    ;(window as unknown as { terminalTestOutput: string }).terminalTestOutput = ''
    window.sshHeaven.write(sessionId, `${Array.from({ length: lines }, (_, index) => `echo ${marker}-${index}\r`).join('')}echo ${marker}-END\r`)
  }, { lines, marker, sessionId: currentSessionId })
  await expect.poll(() => page!.evaluate(() => (window as unknown as { terminalTestOutput: string }).terminalTestOutput)).toContain(`\r\n${marker}-END\r\n`)
}

async function geometry(pane: Locator) {
  return pane.evaluate((element) => {
    const surface = element.querySelector<HTMLElement>('.ssh-terminal-surface')!
    const screen = element.querySelector<HTMLElement>('.xterm-screen')!
    const footer = element.querySelector<HTMLElement>('.terminal-footer')!
    const cursor = element.querySelector<HTMLElement>('.xterm-cursor')
    const rect = surface.getBoundingClientRect()
    const style = getComputedStyle(surface)
    const bounds = {
      top: rect.top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth),
      bottom: Math.min(rect.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth), footer.getBoundingClientRect().top),
      left: rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
      right: rect.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
    }
    const screenRect = screen.getBoundingClientRect()
    return {
      fits: screenRect.height > 0 && !!cursor && [screenRect, cursor.getBoundingClientRect()].every((target) => target.top >= bounds.top - .75 && target.bottom <= bounds.bottom + .75 && target.left >= bounds.left - .75 && target.right <= bounds.right + .75),
      bounds,
      screen: { top: screenRect.top, bottom: screenRect.bottom, left: screenRect.left, right: screenRect.right, height: screenRect.height },
      cursor: cursor ? { top: cursor.getBoundingClientRect().top, bottom: cursor.getBoundingClientRect().bottom } : null,
      text: element.querySelector('.xterm-rows')?.textContent,
    }
  })
}

async function assertGeometry(label: string) {
  await assertHidden()
  await expect.poll(async () => {
    const panes = await visiblePanes().all()
    return (await Promise.all(panes.map(geometry))).every((value) => value.fits)
  }, { timeout: 4000, message: `${label}: the last terminal row and cursor must fit above the footer` }).toBe(true)
}

async function font(size: number) {
  const toolbar = activePane()
  const current = Number((await toolbar.getByLabel('Terminal font size', { exact: true }).innerText()).replace('px', ''))
  const button = toolbar.getByRole('button', { name: size > current ? 'Increase terminal font size' : 'Decrease terminal font size', exact: true })
  for (let value = current; value !== size; value += size > current ? 1 : -1) await button.click()
  await expect(toolbar.getByLabel('Terminal font size', { exact: true })).toHaveText(`${size}px`)
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow()
  if (background) await app.evaluate(({ BrowserWindow }) => {
    const events: string[] = []
    ;(globalThis as unknown as { terminalLayoutVisibilityEvents: string[] }).terminalLayoutVisibilityEvents = events
    for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => events.push('show')); window.on('focus', () => events.push('focus')) }
  })
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  await assertHidden()
  await page.evaluate(async (hosts) => {
    for (const [index, host] of hosts.entries()) {
      await window.sshHeaven.importHosts({ text: `${host.host}:${host.username}:${host.password}`, port: host.port, authType: 'password' })
      const profile = (await window.sshHeaven.listProfiles()).find((profile) => profile.port === host.port)!
      await window.sshHeaven.saveProfile({ ...profile, name: `Terminal ${index + 1}` })
    }
  }, fixtures.map(({ host, port, username, password }) => ({ host, port, username, password })))
  await page.reload()
  // Observe real native status events, without exposing xterm internals.
  await page.evaluate(() => {
    const target = window as unknown as { terminalTestSessionId: string; terminalTestOutput: string }
    target.terminalTestSessionId = ''
    target.terminalTestOutput = ''
    window.sshHeaven.onStatus(({ sessionId, status }) => { if (status === 'connected') target.terminalTestSessionId = sessionId })
    window.sshHeaven.onData(({ data }) => { target.terminalTestOutput += new TextDecoder().decode(data) })
  })
  await connectHost('Terminal 1')
  const firstId = currentSessionId
  await output(160, 'BOTTOM')
  await expect(activePane().locator('.xterm-rows')).toContainText('BOTTOM-END')
  await assertGeometry('Default window before toolbar changes')

  // Background QA uses a large offscreen viewport instead of OS maximization.
  if (background) console.log('Background terminal-layout scope: hidden offscreen normal/minimum/large viewports; native maximize and physical window movement are not exercised.')
  for (const mode of ['normal', 'minimum', background ? 'large' : 'maximized'] as const) {
    await app.evaluate(({ BrowserWindow }, { mode, background }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!background && window.isMaximized()) window.unmaximize()
      if (!background && mode === 'maximized') window.maximize()
      else window.setSize(mode === 'minimum' ? 900 : mode === 'large' ? 1920 : 1440, mode === 'minimum' ? 680 : mode === 'large' ? 1080 : 920)
    }, { mode, background })
    await assertHidden()
    for (const size of Array.from({ length: 15 }, (_, index) => index + 10)) {
      await font(size)
      await assertGeometry(`${mode}, ${size}px`)
      await activePane().getByRole('button', { name: 'Search terminal', exact: true }).click()
      await assertGeometry(`${mode}, ${size}px, search open`)
      await activePane().getByRole('button', { name: 'Close terminal search', exact: true }).click()
    }
  }

  await app.evaluate(({ BrowserWindow }, background) => { const window = BrowserWindow.getAllWindows()[0]; if (!background) window.unmaximize(); window.setSize(900, 680) }, background)
  await assertHidden()
  await font(13)
  if (await page.getByRole('button', { name: 'Toggle remote files', exact: true }).getAttribute('aria-pressed') === 'true') await page.getByRole('button', { name: 'Toggle remote files', exact: true }).click()
  for (let index = 2; index <= 4; index++) await connectHost(`Terminal ${index}`)
  for (const layout of ['Split layout', 'Grid layout']) {
    await page.getByRole('button', { name: layout, exact: true }).click()
    for (const size of [10, 13, 18, 24]) {
      await font(size)
      await activePane().locator('.xterm-helper-textarea').focus()
      await page.keyboard.press('Enter')
      await assertGeometry(`${layout}, minimum window, ${size}px`)
      await activePane().getByRole('button', { name: 'Search terminal', exact: true }).click()
      await assertGeometry(`${layout}, minimum window, ${size}px, search open`)
      await activePane().getByRole('button', { name: 'Close terminal search', exact: true }).click()
    }
  }
  // A file panel cannot leave two columns too narrow to show even one row.
  await page.getByRole('button', { name: 'Toggle remote files', exact: true }).click()
  await expect(page.locator('.session-panes')).toHaveAttribute('data-layout', 'tabs')
  await expect(page.getByRole('complementary', { name: 'Remote files', exact: true })).toBeVisible()
  await assertGeometry('Minimum window, opening Files from Grid')
  await page.getByRole('button', { name: 'Toggle remote files', exact: true }).click()
  await page.getByRole('button', { name: 'Tabs layout', exact: true }).click()
  await font(13)
  await page.getByRole('tab', { name: 'Terminal 1', exact: true }).click()
  currentSessionId = firstId
  const rows = activePane().locator('.xterm-rows')
  await activePane().locator('.xterm-screen').hover()
  await page.mouse.wheel(0, -1200)
  await expect(activePane().getByRole('button', { name: 'Jump to latest output', exact: true })).toBeVisible()
  const historyView = await rows.textContent()
  await output(12, 'AFTER-SCROLL')
  await expect.poll(() => rows.textContent()).toBe(historyView)
  await expect(rows).not.toContainText('AFTER-SCROLL-END')
  await activePane().getByRole('button', { name: 'Jump to latest output', exact: true }).click()
  await expect(rows).toContainText('AFTER-SCROLL-END')
  await expect(activePane().getByRole('button', { name: 'Jump to latest output', exact: true })).toHaveCount(0)
  await output(12, 'AUTO-FOLLOW')
  await expect(rows).toContainText('AUTO-FOLLOW-END')
  await assertGeometry('Bottom-follow after returning from scrollback')
  await expect(activePane().getByRole('button', { name: 'Increase terminal font size', exact: true })).toBeInViewport()
  await page.screenshot({ path: path.join(root, 'test-results', 'terminal-last-row.png') })
  assert.deepEqual(rendererErrors, [])
  await assertHidden()
  console.log(background ? 'Background terminal layout E2E passed: last row/cursor fits at fonts10–24 in hidden offscreen normal/minimum/large viewports, split/grid/search, bottom-follow and preserved scrollback. Native maximization/physical movement were not exercised.' : 'Terminal layout E2E passed: actual last row/cursor visible at fonts10–24, normal/minimum/maximized windows, split/grid/search, automatic bottom-follow and preserved scrollback with an accessible latest-output action.')
} catch (error) {
  if (page && app) {
    console.error(JSON.stringify(await Promise.all((await visiblePanes().all()).map(geometry)), null, 2))
    await page.screenshot({ path: path.join(root, 'test-results', 'terminal-layout-failure.png') }).catch(() => {})
  }
  throw error
} finally {
  try { await assertHidden() }
  finally {
    try { await app?.close() }
    finally {
      try { await Promise.all(fixtures.map((fixture) => fixture.close())) }
      finally {
        // This is the absolute path returned by mkdtemp above.
        await rm(temporary, { recursive: true, force: true })
      }
    }
  }
}
