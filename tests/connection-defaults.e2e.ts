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
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-defaults-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory)
const fixture = await startFixture({ username: 'root' })
let app: ElectronApplication | undefined
let page: Page | undefined
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const native = await page.evaluate(() => window.sshHeaven.getCredentialStatus())
  assert.equal(native.available, true, 'Default credential persistence requires real OS encryption')
  async function connect(name: string, remember: boolean) {
    await page!.getByRole('button', { name: 'Create a new connection', exact: true }).click()
    await expect(page!.getByLabel('Username', { exact: true })).toHaveValue('root')
    await expect(page!.getByLabel('Remember password on this device', { exact: true })).toBeChecked()
    await page!.getByLabel(/^Nickname/).fill(name)
    await page!.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
    await page!.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
    // Clearing the visible default must still submit root, including HTML validation.
    await page!.getByLabel('Username', { exact: true }).fill('')
    await page!.getByLabel('Password', { exact: true }).fill(fixture.password)
    if (!remember) await page!.getByLabel('Remember password on this device', { exact: true }).uncheck()
    await page!.getByRole('button', { name: 'Connect', exact: true }).click()
    await expect.poll(async () => {
      const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true })
      if (await trust.isVisible()) await trust.click()
      return page!.locator('.session-workspace.is-active-pane .terminal-footer').getByText('Connected', { exact: true }).count()
    }, { timeout: 20_000 }).toBe(1)
    const saved = (await page!.evaluate(() => window.sshHeaven.listProfiles())).find((profile) => profile.name === name)!
    assert.equal(saved.username, 'root')
    assert.equal((await page!.evaluate(() => window.sshHeaven.getCredentialStatus())).profileIds.includes(saved.id), remember)
    return saved
  }
  const first = await connect('Root default remembered', true)
  const source = await readFile(path.join(dataDirectory, 'credentials.json'), 'utf8')
  assert.equal(source.includes(fixture.password), false)
  await page.getByRole('button', { name: `Quick connect ${first.name}`, exact: true }).click()
  await expect(page.getByRole('status', { name: 'SSH session summary', exact: true })).toHaveText('2 online')
  await connect('Root opt out', false)
  assert.equal((await page.evaluate(() => window.sshHeaven.getCredentialStatus())).profileIds.length, 1)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })))
  assert.ok(windows.every((window) => !window.visible && !window.focused && window.offscreen))
  assert.deepEqual(errors, [])
  console.log('Background connection defaults passed: root prefilled and blank fallback authenticates, OS-encrypted remember default, quick connect reuse, explicit opt-out respected, and no visible/focused window.')
} finally {
  await app?.close(); await fixture.close(); await rm(temporary, { recursive: true, force: true })
}
