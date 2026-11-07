import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { DEFAULT_THEME_ID, THEME_PRESETS } from '../src/theme'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-themes-e2e-'))
const dataDirectory = path.join(temporary, 'settings')
const screenshots = path.join(root, 'test-results')
await mkdir(dataDirectory)
await mkdir(screenshots, { recursive: true })
const fixture = await startFixture()
const rendererErrors: string[] = []
let app: ElectronApplication | undefined
type ThemePreset = typeof THEME_PRESETS[number]

interface ThemeProbe {
  output: string
  sessionIds: string[]
  statuses: { sessionId: string; status: string }[]
  terminal: Element | null
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
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  return page
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'Appearance', exact: true }).first().click()
  const modal = page.getByRole('dialog', { name: 'Appearance', exact: true })
  await expect(modal).toBeVisible()
  return modal
}

async function assertTheme(page: Page, theme: ThemePreset) {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
  await expect(page.locator('html')).toHaveAttribute('data-appearance', theme.appearance)
  const actualColors = await page.evaluate((names) => Object.fromEntries(names.map((name) => [name, getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim()])), Object.keys(theme.colors))
  assert.deepEqual(actualColors, theme.colors, `${theme.name} must update the CSS variables used by the actual renderer`)
  assert.equal(await page.evaluate(() => localStorage.getItem('ssh-heaven:theme')), theme.id)
  await expect.poll(() => app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe(theme.appearance)
}

async function chooseTheme(page: Page, theme: ThemePreset) {
  const modal = await openAppearance(page)
  await modal.getByRole('radio', { name: theme.name, exact: true }).check()
  await assertTheme(page, theme)
  await modal.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(modal).toHaveCount(0)
}

async function assertTerminalTheme(page: Page, theme: ThemePreset) {
  const expectedBackground = await page.evaluate((color) => {
    const element = document.createElement('span')
    element.style.backgroundColor = color
    document.body.append(element)
    const result = getComputedStyle(element).backgroundColor
    element.remove()
    return result
  }, theme.terminal.background!)
  await expect.poll(() => page.locator('.xterm-viewport').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(expectedBackground)
  assert.ok(await page.evaluate(() => (window as unknown as { themeProbe: ThemeProbe }).themeProbe.terminal === document.querySelector('.xterm')), 'Switching colors must update the existing terminal rather than recreating it')
}

async function command(page: Page, marker: string) {
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type(`echo ${marker}`)
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { themeProbe: ThemeProbe }).themeProbe.output)).toContain(`\r\n${marker}\r\n`)
}

try {
  let page = await launch()
  await expect(page.locator('html')).toHaveAttribute('data-theme', DEFAULT_THEME_ID)
  const modal = await openAppearance(page)
  await expect(modal.getByRole('radio')).toHaveCount(THEME_PRESETS.length)
  // Native radio arrows change the selected palette without needing a mouse.
  const initialIndex = THEME_PRESETS.findIndex((theme) => theme.id === DEFAULT_THEME_ID)
  const next = THEME_PRESETS[(initialIndex + 1) % THEME_PRESETS.length]
  await modal.getByRole('radio', { name: THEME_PRESETS[initialIndex].name, exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  await expect(modal.getByRole('radio', { name: next.name, exact: true })).toBeChecked()
  await assertTheme(page, next)
  for (const theme of THEME_PRESETS) {
    await modal.getByRole('radio', { name: theme.name, exact: true }).check()
    await assertTheme(page, theme)
  }
  await page.screenshot({ path: path.join(screenshots, 'theme-appearance.png') })
  await modal.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const dark = THEME_PRESETS.find((theme) => theme.appearance === 'dark')!
  const light = THEME_PRESETS.find((theme) => theme.appearance === 'light')!
  await chooseTheme(page, dark)
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page.evaluate(() => {
    const probe: ThemeProbe = { output: '', sessionIds: [], statuses: [], terminal: null }
    ;(window as unknown as { themeProbe: ThemeProbe }).themeProbe = probe
    const decoder = new TextDecoder()
    window.sshHeaven.onData(({ sessionId, data }) => {
      probe.output += decoder.decode(new Uint8Array(data), { stream: true })
      if (!probe.sessionIds.includes(sessionId)) probe.sessionIds.push(sessionId)
    })
    window.sshHeaven.onStatus((event) => probe.statuses.push(event))
  })
  await page.getByLabel(/^Nickname/).fill('Theme integration')
  await page.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
  await page.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Verify server identity', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  await page.evaluate(() => { (window as unknown as { themeProbe: ThemeProbe }).themeProbe.terminal = document.querySelector('.xterm') })
  await command(page, 'history-before-theme-change')
  await assertTerminalTheme(page, dark)
  await page.screenshot({ path: path.join(screenshots, 'theme-dark-workspace.png') })
  await chooseTheme(page, light)
  await assertTerminalTheme(page, light)
  // Search proves the terminal scrollback survived the live color change.
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('Control+Shift+F')
  await page.getByLabel('Find in terminal', { exact: true }).fill('history-before-theme-change')
  await expect(page.getByLabel('Terminal search results', { exact: true })).toContainText(/of [1-9]/)
  await page.getByLabel('Find in terminal', { exact: true }).press('Escape')
  await command(page, 'light-theme-session-still-connected')
  await page.screenshot({ path: path.join(screenshots, 'theme-light-workspace.png') })
  await chooseTheme(page, dark)
  await assertTerminalTheme(page, dark)
  await command(page, 'dark-theme-session-still-connected')
  const probe = await page.evaluate(() => {
    const value = (window as unknown as { themeProbe: ThemeProbe }).themeProbe
    return { sessionIds: value.sessionIds, statuses: value.statuses }
  })
  assert.equal(probe.sessionIds.length, 1, 'All terminal bytes must belong to the original SSH session')
  assert.equal(probe.statuses.filter((event) => event.status === 'connecting').length, 1)
  assert.equal(probe.statuses.filter((event) => event.status === 'connected').length, 1)
  assert.equal(probe.statuses.filter((event) => event.status === 'error' || event.status === 'disconnected').length, 0)
  await expect(page.getByRole('complementary', { name: 'Remote files', exact: true }).getByText('welcome.txt', { exact: true })).toBeVisible()
  await chooseTheme(page, light)
  await app!.close()
  app = undefined
  page = await launch()
  await assertTheme(page, light)
  const restored = await openAppearance(page)
  await expect(restored.getByRole('radio', { name: light.name, exact: true })).toBeChecked()
  await restored.getByRole('button', { name: 'Close dialog', exact: true }).click()
  assert.deepEqual(rendererErrors, [], `Renderer exceptions: ${rendererErrors.join(', ')}`)
  console.log('Theme E2E passed: all preset CSS values, keyboard radio selection, native theme updates, persisted restart, live dark/light terminal palette updates, preserved scrollback and SSH connection, usable SFTP, and dark/light/appearance screenshots.')
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => undefined)
    await page?.screenshot({ path: path.join(screenshots, 'theme-failure.png') }).catch(() => {})
    if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 7000))
  }
  throw error
} finally {
  await app?.close()
  await fixture.close()
  // This directory is generated by mkdtemp and never accepts user/remote input.
  await rm(temporary, { recursive: true, force: true })
}
