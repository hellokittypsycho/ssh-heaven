import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { HostProfile } from '../shared/types'
import { startFixture, type SshFixture } from './fixture'
import { installUpdateFixture, release, updateProbe } from './update-fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-navigation-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory); await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixtures: SshFixture[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
const rendererErrors: string[] = []
const navigation = () => page!.getByRole('navigation', { name: 'Workspace navigation', exact: true })
const sessions = () => page!.getByRole('tablist', { name: 'Connection sessions', exact: true })
const activePane = () => page!.locator('.session-workspace.is-active-pane')
const scripts = () => page!.getByRole('region', { name: 'Scripts workspace', exact: true })
const scriptEditor = () => scripts().getByRole('textbox', { name: 'Script contents', exact: true })

async function hidden() {
  const state = await app!.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })),
    events: (globalThis as unknown as { navigationVisibility: string[] }).navigationVisibility,
  }))
  assert.ok(state.windows.every((window) => !window.visible && !window.focused && window.offscreen), 'Navigation QA must remain hidden and offscreen')
  assert.deepEqual(state.events, [], 'Navigation QA must never show or focus a native window')
}
async function layout() {
  await hidden()
  assert.equal(await page!.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), true, 'Navigation must not cause horizontal document overflow')
}
async function settlePaint() {
  await page!.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
}
async function terminalFits() {
  await expect.poll(() => activePane().evaluate((pane) => {
    const surface = pane.querySelector('.ssh-terminal-surface')!.getBoundingClientRect()
    const screen = pane.querySelector('.xterm-screen')!.getBoundingClientRect()
    const cursor = pane.querySelector('.xterm-cursor')?.getBoundingClientRect()
    const footer = pane.querySelector('.terminal-footer')!.getBoundingClientRect()
    return !!cursor && screen.height > 0 && screen.bottom <= footer.top + 1 && cursor.bottom <= footer.top + 1 && screen.top >= surface.top - 1 && screen.right <= surface.right + 1
  })).toBe(true)
  await layout()
}
async function selectSession(name: string) {
  await page!.getByRole('button', { name: 'All sessions', exact: true }).click()
  const dialog = page!.getByRole('dialog', { name: 'All sessions', exact: true })
  await dialog.getByLabel('Search sessions', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: `Select ${name} session`, exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(sessions().getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
}
async function activeTabRevealed() {
  await expect.poll(() => page!.locator('.ssh-session-strip').evaluate((strip) => {
    const area = strip.querySelector('.ssh-session-scroll')!.getBoundingClientRect()
    const selected = strip.querySelector('[role="tab"][aria-selected="true"]')?.getBoundingClientRect()
    return !!selected && selected.left >= area.left - 1 && selected.right <= area.right + 1
  })).toBe(true)
}
async function connect(profile: HostProfile, password: string) {
  await page!.locator('.sidebar').getByTitle(`Connect to ${profile.name}`, { exact: true }).click()
  await page!.getByLabel('Password', { exact: true }).fill(password)
  await page!.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(async () => {
    const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true })
    if (await trust.isVisible()) await trust.click()
    return activePane().locator('.terminal-footer').getByText('Connected', { exact: true }).count()
  }, { timeout: 20_000 }).toBe(1)
  await expect(activePane()).toHaveAttribute('aria-label', `${profile.name} session`)
  await hidden()
}

try {
  fixtures.push(await startFixture())
  fixtures.push(await startFixture({ host: '127.0.0.2', port: fixtures[0].port, username: 'ops' }))
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  // Packaged builds alone enable release checks. Reuse the native HTTPS test
  // fixture to cover the persistent Updates badge without external requests.
  if (executable) await installUpdateFixture(app, { body: release('99.0.0') })
  page = await app.firstWindow(); page.on('pageerror', (error) => rendererErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => {
    const events: string[] = []
    ;(globalThis as unknown as { navigationVisibility: string[] }).navigationVisibility = events
    for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => events.push('show')); window.on('focus', () => events.push('focus')); window.setSize(1440, 920) }
  })
  await expect(navigation()).toBeVisible()
  for (const name of ['Open home', 'New connection', 'Open scripts', 'Open vault']) await expect(navigation().getByRole('button', { name, exact: true })).toBeVisible()
  await expect(navigation().getByRole('button', { name: 'Open home', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Go back', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Go forward', exact: true })).toBeDisabled()
  await expect(sessions()).toHaveCount(0)
  await layout()
  await settlePaint()
  await page.screenshot({ path: path.join(root, 'test-results', 'navigation-home.png') })

  // Seed metadata only, then use the real connection UI for every live session.
  const profiles = await page.evaluate(async (hosts) => {
    const result: HostProfile[] = []
    for (let index = 0; index < 10; index++) {
      const host = hosts[index < 5 ? 0 : 1]
      result.push(await window.sshHeaven.saveProfile({ id: crypto.randomUUID(), name: `Navigation ${String(index + 1).padStart(2, '0')}`, host: host.host, port: host.port, username: host.username, authType: 'password', group: index < 5 ? 'Fleet East' : 'Fleet West' }))
    }
    return result
  }, fixtures.map(({ host, port, username }) => ({ host, port, username })))
  await page.reload()
  const sidebar = page.locator('.sidebar')
  const eastHost = sidebar.getByTitle('Connect to Navigation 01', { exact: true })
  const westHost = sidebar.getByTitle('Connect to Navigation 06', { exact: true })
  await sidebar.getByRole('button', { name: 'Collapse Fleet East hosts', exact: true }).click()
  await expect(eastHost).toBeHidden()
  await expect(westHost).toBeVisible()
  await sidebar.getByRole('textbox', { name: 'Search hosts', exact: true }).fill('Navigation 01')
  await expect(eastHost).toBeVisible()
  await expect(westHost).toBeHidden()
  await expect(sidebar.getByRole('button', { name: 'Collapse Fleet East hosts', exact: true })).toBeDisabled()
  await sidebar.getByRole('button', { name: 'Clear host search', exact: true }).click()
  await expect(eastHost).toBeHidden()
  await expect(westHost).toBeVisible()
  await settlePaint()
  await page.screenshot({ path: path.join(root, 'test-results', 'navigation-host-groups.png') })
  await sidebar.getByRole('button', { name: 'Expand Fleet East hosts', exact: true }).click()
  await expect(eastHost).toBeVisible()

  // Navigation history changes views without replacing form or editor models.
  await page.keyboard.press('Control+2')
  await expect(navigation().getByRole('button', { name: 'New connection', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByLabel(/^Nickname/).fill('History connection draft')
  await page.getByLabel('Hostname or IP address', { exact: true }).fill('history.example')
  await page.getByLabel('Username', { exact: true }).fill('history-user')
  await page.keyboard.press('Control+3')
  await expect(navigation().getByRole('button', { name: 'Open scripts', exact: true })).toHaveAttribute('aria-current', 'page')
  await scripts().getByLabel('Script name', { exact: true }).fill('Navigation script draft')
  await scriptEditor().focus(); await page.keyboard.insertText('echo navigation-script-draft\n')
  const originalEditor = await scriptEditor().elementHandle()
  await page.keyboard.press('Control+4')
  await expect(page.getByRole('region', { name: 'Vault workspace', exact: true })).toBeVisible()
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(scriptEditor()).toContainText('navigation-script-draft')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(page.getByLabel('Hostname or IP address', { exact: true })).toHaveValue('history.example')
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('history-user')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(navigation().getByRole('button', { name: 'Open home', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Go back', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Go forward', exact: true }).click()
  await expect(page.getByLabel(/^Nickname/)).toHaveValue('History connection draft')
  await page.keyboard.press('Alt+ArrowRight')
  await expect(scriptEditor()).toContainText('navigation-script-draft')
  await page.keyboard.press('Alt+ArrowRight')
  await expect(navigation().getByRole('button', { name: 'Open vault', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: 'Go forward', exact: true })).toBeDisabled()
  await page.keyboard.press('Control+1')
  await expect(navigation().getByRole('button', { name: 'Open home', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(navigation().getByRole('button', { name: 'Open vault', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.keyboard.press('Control+2')
  await expect(page.getByLabel('Hostname or IP address', { exact: true })).toHaveValue('history.example')
  await expect(page.getByRole('button', { name: 'Go forward', exact: true })).toBeDisabled()
  assert.equal(await originalEditor!.evaluate((node) => node.isConnected), true)
  let firstTerminal: Awaited<ReturnType<Locator['elementHandle']>> | undefined
  for (let index = 0; index < profiles.length; index++) {
    await connect(profiles[index], fixtures[index < 5 ? 0 : 1].password)
    if (index === 0) {
      firstTerminal = await activePane().locator('.xterm').elementHandle()
      await activePane().locator('.xterm-helper-textarea').focus()
      await page.keyboard.type('echo navigation-terminal-one'); await page.keyboard.press('Enter')
      await expect(activePane().locator('.xterm-rows')).toContainText('navigation-terminal-one')
    }
  }
  const lastTerminal = await activePane().locator('.xterm').elementHandle()
  await expect(sessions().getByRole('tab')).toHaveCount(10)
  for (const name of ['Home', 'New connection', 'Scripts', 'Vault']) await expect(sessions().getByRole('tab', { name, exact: true })).toHaveCount(0)
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toHaveCount(10)
  await activeTabRevealed()
  await terminalFits()

  await navigation().getByRole('button', { name: 'New connection', exact: true }).click()
  await page.getByLabel(/^Nickname/).fill('Unfinished navigation connection')
  await page.getByLabel('Hostname or IP address', { exact: true }).fill('draft.example')
  await page.getByLabel('Username', { exact: true }).fill('draft-user')
  await navigation().getByRole('button', { name: 'Open home', exact: true }).click()
  await expect(sessions().getByRole('tab', { selected: true })).toHaveCount(0)
  await navigation().getByRole('button', { name: 'Open scripts', exact: true }).click()
  await expect(scripts().getByLabel('Script name', { exact: true })).toHaveValue('Navigation script draft')
  await expect(scriptEditor()).toContainText('navigation-script-draft')
  assert.equal(await originalEditor!.evaluate((node) => node.isConnected && node === document.querySelector('[aria-label="Script contents"]')), true)
  await navigation().getByRole('button', { name: 'Open vault', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Vault workspace', exact: true })).toBeVisible()
  await navigation().getByRole('button', { name: 'New connection', exact: true }).click()
  await expect(page.getByLabel(/^Nickname/)).toHaveValue('Unfinished navigation connection')
  await expect(page.getByLabel('Hostname or IP address', { exact: true })).toHaveValue('draft.example')
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('draft-user')
  assert.equal(await firstTerminal!.evaluate((node) => node.isConnected), true)
  assert.equal(await lastTerminal!.evaluate((node) => node.isConnected), true)

  // The unified switcher lists live sessions before saved hosts and actions.
  await page.keyboard.press('Control+k')
  let palette = page.getByRole('dialog', { name: 'Quick switcher', exact: true })
  let paletteSearch = palette.getByRole('combobox', { name: 'Search hosts and actions', exact: true })
  const filters = palette.getByRole('tablist', { name: 'Switcher filters', exact: true })
  await expect(filters.getByRole('tab', { name: 'All', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(palette.getByRole('option').first()).toHaveAttribute('aria-label', /^Switch to Navigation /)
  await filters.getByRole('tab', { name: 'Sessions', exact: true }).click()
  await expect(palette.getByRole('option')).toHaveCount(10)
  await settlePaint()
  await page.screenshot({ path: path.join(root, 'test-results', 'navigation-session-palette.png') })
  await paletteSearch.fill('Fleet West')
  await expect(palette.getByRole('option')).toHaveCount(5)
  await paletteSearch.fill(fixtures[1].host)
  await expect(palette.getByRole('option')).toHaveCount(5)
  await paletteSearch.fill('Navigation 03')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await paletteSearch.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(sessions().getByRole('tab', { name: 'Navigation 03', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+1')
  await page.keyboard.press('Alt+ArrowLeft')
  await expect(sessions().getByRole('tab', { name: 'Navigation 03', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Go forward', exact: true }).click()
  await expect(navigation().getByRole('button', { name: 'Open home', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Go back', exact: true }).click()
  await page.keyboard.press('Control+2')
  await expect(page.getByLabel('Hostname or IP address', { exact: true })).toHaveValue('draft.example')
  await expect(page.getByRole('button', { name: 'Go forward', exact: true })).toBeDisabled()
  assert.equal(await firstTerminal!.evaluate((node) => node.isConnected), true)
  assert.equal(await lastTerminal!.evaluate((node) => node.isConnected), true)

  await page.keyboard.press('Control+k')
  palette = page.getByRole('dialog', { name: 'Quick switcher', exact: true })
  paletteSearch = palette.getByRole('combobox', { name: 'Search hosts and actions', exact: true })
  await palette.getByRole('tab', { name: 'Hosts', exact: true }).click()
  await paletteSearch.fill('Navigation 03')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.getByRole('option', { name: /^Switch to / })).toHaveCount(0)
  await paletteSearch.fill('')
  const allFilter = palette.getByRole('tab', { name: 'All', exact: true })
  await allFilter.click()
  await allFilter.press('End')
  await expect(palette.getByRole('tab', { name: 'Actions', exact: true })).toBeFocused()
  await expect(allFilter).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(palette.getByRole('tab', { name: 'Actions', exact: true })).toHaveAttribute('aria-selected', 'true')
  await paletteSearch.fill('Check for updates')
  await expect(palette.getByRole('option')).toHaveCount(1)
  if (executable) {
    await expect.poll(async () => (await updateProbe(app!)).requests.length).toBe(1)
    await expect(sidebar.getByRole('button', { name: 'Updates', exact: true }).getByLabel('Update available', { exact: true })).toBeVisible()
  }
  await palette.getByRole('option', { name: /^Check for updates/ }).click()
  const library = page.getByRole('dialog', { name: 'Workspace library', exact: true })
  await expect(library.locator('.management-update-message')).toBeVisible()
  if (executable) {
    await expect.poll(async () => (await updateProbe(app!)).requests.length).toBe(2)
    await expect(library.locator('.management-update-message')).toContainText('99.0.0')
  }
  await library.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const updatesEntry = sidebar.getByRole('button', { name: 'Updates', exact: true })
  if (executable) {
    await expect(updatesEntry.getByLabel('Update available', { exact: true })).toBeVisible()
    await expect(page.locator('.update-notice')).toBeVisible()
    await page.getByRole('button', { name: 'Dismiss update notification', exact: true }).click()
    await expect(page.locator('.update-notice')).toHaveCount(0)
    await expect(updatesEntry.getByLabel('Update available', { exact: true })).toBeVisible()
    assert.deepEqual((await updateProbe(app)).opened, [], 'Navigation and update badges must never open a browser automatically')
  }
  await updatesEntry.click()
  await expect(library.locator('.management-update-message')).toBeVisible()
  if (executable) {
    await settlePaint()
    assert.equal((await updateProbe(app)).requests.length, 2, 'The footer Updates entry opens status without an additional network check')
  }
  await library.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.keyboard.press('Control+k')
  await expect(palette).toBeVisible()
  await page.keyboard.press('Control+k')
  await expect(palette).toHaveCount(0)
  await expect(page.getByLabel(/^Nickname/)).toHaveValue('Unfinished navigation connection')
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toHaveCount(10)
  await hidden()

  await page.getByRole('button', { name: 'All sessions', exact: true }).click()
  const switcher = page.getByRole('dialog', { name: 'All sessions', exact: true })
  const matches = switcher.getByRole('button', { name: /^Select Navigation \d+ session$/ })
  await expect(matches).toHaveCount(10)
  await switcher.getByLabel('Search sessions', { exact: true }).fill('Navigation 07')
  await expect(matches).toHaveCount(1)
  await switcher.getByLabel('Search sessions', { exact: true }).fill(fixtures[1].host)
  await expect(matches).toHaveCount(5)
  await switcher.getByLabel('Search sessions', { exact: true }).fill('Fleet East')
  await expect(matches).toHaveCount(5)
  await switcher.getByLabel('Search sessions', { exact: true }).fill('no-session-matches-this')
  await expect(matches).toHaveCount(0)
  await switcher.getByLabel('Search sessions', { exact: true }).fill('Navigation 01')
  await switcher.getByRole('button', { name: 'Select Navigation 01 session', exact: true }).click()
  await expect(switcher).toHaveCount(0)
  await activeTabRevealed()
  assert.equal(await firstTerminal!.evaluate((node) => node === document.querySelector('.session-workspace.is-active-pane .xterm')), true)
  await expect(activePane().locator('.xterm-rows')).toContainText('navigation-terminal-one')
  await sessions().getByRole('tab', { name: 'Navigation 01', exact: true }).focus()
  for (const [key, name] of [['ArrowRight', 'Navigation 02'], ['End', 'Navigation 10'], ['Home', 'Navigation 01']]) {
    await page.keyboard.press(key)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
    await expect(sessions().getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(sessions().getByRole('tab', { name, exact: true })).toBeFocused()
    await activeTabRevealed()
  }
  for (const name of ['Navigation 02', 'Navigation 01', 'Navigation 01']) {
    await sessions().getByRole('tab', { name, exact: true }).click()
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))))
    await expect(activePane().locator('.xterm-helper-textarea')).toBeFocused()
  }
  await page.keyboard.press('Control+Tab')
  await expect(sessions().getByRole('tab', { name: 'Navigation 02', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(sessions().getByRole('tab', { name: 'Navigation 01', exact: true })).toHaveAttribute('aria-selected', 'true')

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 720))
  await selectSession('Navigation 10')
  await activeTabRevealed(); await terminalFits()
  const scroll = page.locator('.ssh-session-scroll')
  const beforeScroll = await scroll.evaluate((node) => node.scrollLeft)
  await page.getByRole('button', { name: 'Scroll sessions left', exact: true }).click()
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeLessThan(beforeScroll)
  const afterLeft = await scroll.evaluate((node) => node.scrollLeft)
  await page.getByRole('button', { name: 'Scroll sessions right', exact: true }).click()
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeGreaterThan(afterLeft)
  await page.getByRole('button', { name: 'Scroll sessions left', exact: true }).click()
  await expect.poll(() => scroll.evaluate((node) => node.scrollLeft)).toBeLessThan(beforeScroll)
  // Re-selecting the same active session must reveal it as well; activeId does
  // not change, so this cannot rely only on an active-session effect.
  await selectSession('Navigation 10')
  await activeTabRevealed()
  await settlePaint()
  await page.screenshot({ path: path.join(root, 'test-results', 'navigation-many-sessions.png') })
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
  await expect.poll(async () => (await page!.locator('.sidebar').boundingBox())?.width).toBe(72)
  assert.equal(await page.evaluate(() => localStorage.getItem('ssh-heaven:sidebar-collapsed')), 'true')
  await terminalFits()
  await settlePaint()
  await page.screenshot({ path: path.join(root, 'test-results', 'navigation-collapsed.png') })
  await navigation().getByRole('button', { name: 'Open scripts', exact: true }).click()
  await expect(scriptEditor()).toContainText('navigation-script-draft')
  await navigation().getByRole('button', { name: 'Open home', exact: true }).click()
  await page.keyboard.press('Control+Tab')
  await expect(sessions().getByRole('tab', { name: 'Navigation 01', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+W')
  const close = page.getByRole('dialog', { name: 'Close this session?', exact: true })
  await expect(close).toBeVisible()
  await close.getByRole('button', { name: 'Disconnect & close', exact: true }).click()
  await expect(sessions().getByRole('tab')).toHaveCount(9)
  await expect(sessions().getByRole('tab', { name: 'Navigation 02', exact: true })).toHaveAttribute('aria-selected', 'true')
  assert.equal(await firstTerminal!.evaluate((node) => node.isConnected), false)
  assert.equal(await lastTerminal!.evaluate((node) => node.isConnected), true)
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await terminalFits()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920))
  await activeTabRevealed(); await terminalFits()
  // Closing the final SSH session while the switcher is open must consume its
  // modal state, so a later connection does not reopen an old session picker.
  await page.getByRole('button', { name: 'All sessions', exact: true }).click()
  const closingList = page.getByRole('dialog', { name: 'All sessions', exact: true })
  for (let remaining = 9; remaining > 0; remaining--) {
    await closingList.getByRole('button', { name: /^Close Navigation \d+ from session list$/ }).first().click()
    const confirmation = page.getByRole('dialog', { name: 'Close this session?', exact: true })
    await confirmation.getByRole('button', { name: 'Disconnect & close', exact: true }).click()
    if (remaining > 1) await expect(sessions().getByRole('tab')).toHaveCount(remaining - 1)
    await hidden()
  }
  await expect(sessions()).toHaveCount(0)
  await expect(closingList).toHaveCount(0)
  await connect(profiles[0], fixtures[0].password)
  await expect(sessions().getByRole('tab')).toHaveCount(1)
  await expect(closingList).toHaveCount(0)
  await sidebar.getByRole('button', { name: 'Collapse Fleet East hosts', exact: true }).click()
  await expect(eastHost).toBeHidden()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await hidden()
  await app.close(); app = undefined
  // Reload persistence is verified in a new process, rather than reading only
  // the storage value that the current renderer just wrote.
  const relaunchEnv = { ...env }
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env: relaunchEnv, timeout: 30_000 })
  if (executable) await installUpdateFixture(app)
  page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await app.evaluate(({ BrowserWindow }) => {
    const events: string[] = []
    ;(globalThis as unknown as { navigationVisibility: string[] }).navigationVisibility = events
    for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => events.push('show')); window.on('focus', () => events.push('focus')) }
  })
  await expect(page.getByRole('button', { name: 'Expand sidebar', exact: true })).toBeVisible()
  await expect(sessions()).toHaveCount(0)
  await layout()
  await page.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Expand Fleet East hosts', exact: true })).toBeVisible()
  await expect(page.locator('.sidebar').getByTitle('Connect to Navigation 01', { exact: true })).toBeHidden()
  await expect(page.locator('.sidebar').getByTitle('Connect to Navigation 06', { exact: true })).toBeVisible()
  await layout()
  assert.deepEqual(rendererErrors, [])
  console.log('Navigation E2E passed in hidden offscreen mode: Home/Connect/Scripts/Vault shortcuts and Back/Forward history/branching, persisted collapsible host groups with temporary search expansion, ten real SSH-only sessions, unified CtrlK session/host/action filters and Updates entry, searchable session switcher/overflow/active reveal, preserved script/form/terminal state, keyboard switching/guarded active close, narrow/large geometry, sidebar reflow and persisted collapse; no native window show/focus or hardware input.')
} catch (error) {
  if (page && app) {
    await page.screenshot({ path: path.join(root, 'test-results', 'navigation-failure.png') }).catch(() => {})
    console.error((await page.locator('body').innerText().catch(() => '')).replaceAll(fixtures[0]?.password ?? 'unused-fixture-password', '[REDACTED]').slice(0, 7500))
  }
  throw error
} finally {
  try { if (app) await hidden() }
  finally {
    try { await app?.close() }
    finally { try { await Promise.all(fixtures.map((fixture) => fixture.close())) } finally { await rm(temporary, { recursive: true, force: true }) } }
  }
}
