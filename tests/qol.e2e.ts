import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-qol-'))
const directory = path.join(temporary, 'settings'), log = path.join(temporary, 'session.log')
await mkdir(directory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture()
let app: ElectronApplication | undefined, page: Page | undefined
const errors: string[] = []
const active = () => page!.locator('.session-workspace.is-active-pane')
const screen = () => active().locator('.ssh-terminal-host .xterm-rows')
const tabs = () => page!.getByRole('tablist', { name: 'Connection sessions', exact: true }).getByRole('tab')
async function actions(name: string) {
  await page!.getByRole('button', { name: `Session actions for ${name}`, exact: true }).click()
  return page!.getByRole('dialog', { name: 'Session actions', exact: true })
}
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE; env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${directory}`], env })
  page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message))
  await app.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename }) }, log)
  async function connect(name: string, color: string) {
    await page!.getByRole('button', { name: 'Create a new connection', exact: true }).click()
    await page!.getByLabel(/^Nickname/).fill(name)
    await page!.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
    await page!.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
    await page!.getByLabel('Username', { exact: true }).fill(fixture.username)
    await page!.getByLabel('Password', { exact: true }).fill(fixture.password)
    await page!.getByText('Host appearance and notes', { exact: true }).click()
    await page!.getByLabel('Host color', { exact: true }).selectOption(color)
    await page!.getByLabel('Host icon', { exact: true }).selectOption('database')
    await page!.getByLabel('Host notes', { exact: true }).fill('Deployment: prod.internal.example')
    await page!.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect.poll(async () => {
      const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true })
      if (await trust.isVisible()) await trust.click()
      return active().locator('.terminal-footer').getByText('Connected', { exact: true }).count()
    }).toBe(1)
  }
  await connect('Production', '#f87171')
  await connect('Staging', '#4ade80')
  const profiles = await page.evaluate(() => window.sshHeaven.listProfiles())
  assert.equal(profiles.find((profile) => profile.name === 'Production')?.notes, 'Deployment: prod.internal.example')
  assert.equal(profiles.find((profile) => profile.name === 'Staging')?.icon, 'database')
  await expect(page.locator('.session-tab').first()).toHaveCSS('border-top-color', 'rgb(248, 113, 113)')
  await (await actions('Staging')).getByRole('button', { name: 'Move session earlier', exact: true }).click()
  await expect(tabs().first()).toHaveText('Staging')
  await tabs().first().focus(); await page.keyboard.press('Shift+F10')
  await expect(page.getByRole('dialog', { name: 'Session actions', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.screenshot({ path: path.join(root, 'test-results', 'qol-session-tabs.png') })
  // Browser DOM drag only: never use native hardware input in background QA.
  await page.locator('.session-tab').filter({ has: page.getByRole('tab', { name: 'Production', exact: true }) }).dragTo(page.locator('.session-tab').filter({ has: page.getByRole('tab', { name: 'Staging', exact: true }) }))
  await expect(tabs().first()).toHaveText('Production')
  await (await actions('Staging')).getByRole('button', { name: 'Pin session', exact: true }).click()
  await expect(page.locator('.session-tab').first()).toHaveClass(/is-pinned/)
  await expect(tabs().first()).toHaveText('Staging')
  await (await actions('Staging')).getByRole('button', { name: 'Duplicate connection', exact: true }).click()
  await expect(page.getByRole('status', { name: 'SSH session summary', exact: true })).toHaveText('3 online')
  await expect(tabs()).toHaveCount(3)
  // Close the unpinned duplicate and reopen it using the saved credential.
  await page.locator('.session-tab').last().getByRole('button', { name: 'Close Staging session', exact: true }).click()
  await page.getByRole('dialog', { name: 'Close this session?', exact: true }).getByRole('button', { name: 'Disconnect & close', exact: true }).click()
  await expect(tabs()).toHaveCount(2)
  await page.getByRole('button', { name: 'Reopen closed session', exact: true }).click()
  await expect(page.getByRole('status', { name: 'SSH session summary', exact: true })).toHaveText('3 online')
  await active().locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('echo prod.internal.example 192.0.2.55 SECRET'); await page.keyboard.press('Enter')
  await expect(screen()).toContainText('prod.internal.example 192.0.2.55 SECRET')
  await active().getByRole('button', { name: 'Export terminal log', exact: true }).click()
  await expect.poll(async () => readFile(log, 'utf8')).toContain('prod.internal.example 192.0.2.55 SECRET')
  await page.getByRole('button', { name: 'Stream mode rules', exact: true }).click()
  let rules = page.getByRole('dialog', { name: 'Stream mode rules', exact: true })
  await rules.getByRole('button', { name: 'Add rule', exact: true }).click()
  await rules.getByLabel('Hidden text 1', { exact: true }).fill('prod.internal.example')
  await rules.getByRole('button', { name: 'Save rules', exact: true }).click()
  await page.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await expect(active().locator('.ssh-terminal-host')).toHaveAttribute('data-stream-ready', 'true')
  await expect(screen()).not.toContainText('prod.internal.example')
  await expect(screen()).not.toContainText('192.0.2.55')
  // Updating rules while privacy is already active must remask old scrollback.
  await page.getByRole('button', { name: 'Stream mode rules', exact: true }).click()
  rules = page.getByRole('dialog', { name: 'Stream mode rules', exact: true })
  await rules.getByRole('button', { name: 'Add rule', exact: true }).click()
  await rules.getByLabel('Hidden text 2', { exact: true }).fill('SECRET')
  await rules.getByRole('button', { name: 'Save rules', exact: true }).click()
  await expect(active().locator('.ssh-terminal-host')).toHaveAttribute('data-stream-ready', 'true')
  await expect(screen()).not.toContainText('SECRET')
  await active().getByRole('button', { name: 'Export terminal log', exact: true }).click()
  await expect.poll(async () => readFile(log, 'utf8')).not.toContain('SECRET')
  const safe = await readFile(log, 'utf8')
  assert.equal(safe.includes('prod.internal.example'), false); assert.equal(safe.includes('192.0.2.55'), false)
  await page.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await expect(screen()).toContainText('prod.internal.example 192.0.2.55 SECRET')
  assert.ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })))).every((window) => !window.visible && !window.focused && window.offscreen))
  assert.deepEqual(errors, [])
  console.log('Background QoL E2E passed: host colors/icons/notes, keyboard/menu/drag tab order and pinning, duplicate/reopen with saved credentials, real terminal log export, live custom redaction and redacted exports without changing raw terminal data.')
} finally { await app?.close(); await fixture.close(); await rm(temporary, { recursive: true, force: true }) }
