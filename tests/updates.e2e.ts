import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { GITHUB_DOWNLOAD_PAGE, GITHUB_LATEST_API, installerFixture, installUpdateFixture, release, setInstallerMode, setUpdateReply, updateProbe } from './update-fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = process.env.SSH_HEAVEN_EXECUTABLE || path.join(root, 'release', 'win-unpacked', 'SSH Heaven.exe')
if (!(await stat(executable).catch(() => null))?.isFile()) throw new Error('Build the packaged app before running update UI tests.')
const expectedVersion = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-updates-ui-'))
const directory = path.join(temporary, 'settings'), cache = path.join(directory, 'updates')
await mkdir(directory); await mkdir(path.join(root, 'test-results'), { recursive: true })
let app: ElectronApplication | undefined
let page: Page | undefined
const errors: string[] = []
async function state() { return page!.evaluate(() => window.sshHeaven.getUpdateState()) }
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
}
async function panel(): Promise<Locator> {
  const before = (await updateProbe(app!)).requests.length
  await page!.locator('.sidebar').getByRole('button', { name: 'Updates', exact: true }).click()
  const dialog = page!.getByRole('dialog', { name: 'Workspace library', exact: true })
  await expect(dialog.getByRole('button', { name: 'Updates', exact: true })).toHaveAttribute('aria-pressed', 'true')
  assert.equal((await updateProbe(app!)).requests.length, before)
  return dialog
}
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE; env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const started = Date.now()
  app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${directory}`], env, timeout: 30_000 })
  const installed = await installUpdateFixture(app, { body: release('99.0.0') })
  assert.equal(installed.packaged, true); assert.equal(installed.version, expectedVersion, 'Rebuild the current packaged app before testing')
  page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message))
  await expect.poll(async () => (await state()).status, { timeout: 15_000 }).toBe('available')
  assert.equal((await state()).downloadAvailable, true)
  let probe = await updateProbe(app)
  assert.equal(probe.requests.length, 1)
  assert.ok(probe.requests[0].at - started >= 4500)
  assert.equal(probe.requests[0].url, GITHUB_LATEST_API)
  assert.deepEqual(probe.requests[0].headers, { accept: 'application/vnd.github+json', 'accept-encoding': 'identity', 'user-agent': 'SSH-Heaven-Update-Check', 'x-github-api-version': '2026-03-10' })
  assert.deepEqual(probe.opened, []); assert.deepEqual(probe.installs, []); assert.deepEqual(await files(cache), [])
  await expect(page.locator('.update-notice').getByRole('button', { name: 'Download update', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Install now', exact: true })).toHaveCount(0)
  const shortcut = page.locator('.sidebar').getByRole('button', { name: 'Updates', exact: true })
  await page.getByRole('button', { name: 'Dismiss update notification', exact: true }).click()
  await expect(page.locator('.update-notice')).toHaveCount(0)
  await expect(shortcut.locator('.update-available-dot')).toBeVisible()
  const dialog = await panel()
  const check = dialog.getByRole('button', { name: 'Check for updates', exact: true })
  await check.click()
  await expect(page.locator('.update-notice')).toHaveCount(0)
  for (const excluded of [{ draft: true }, { prerelease: true }]) {
    await setUpdateReply(app, { body: { ...release('99.0.1'), ...excluded } }); await check.click()
    await expect.poll(async () => (await state()).status).toBe('error')
    await expect(dialog.getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0)
  }
  await setUpdateReply(app, { error: 'Offline update fixture' }); await check.click()
  await expect(dialog.locator('.management-update-message')).toContainText('Offline')
  await expect(check).toBeEnabled()
  await setUpdateReply(app, { body: release(installed.version) }); await check.click()
  await expect.poll(async () => (await state()).status).toBe('not-available')
  await expect(shortcut.locator('.update-available-dot')).toHaveCount(0)

  const unsafe = release('99.0.2')
  ;(unsafe.assets as Record<string, unknown>[])[0].browser_download_url = 'https://untrusted.example/installer.exe'
  await setUpdateReply(app, { body: unsafe }); await check.click()
  assert.equal((await state()).downloadAvailable, false)
  await expect(dialog.getByRole('button', { name: 'Download update', exact: true })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Open download page', exact: true }).click()
  assert.deepEqual((await updateProbe(app)).opened, [GITHUB_DOWNLOAD_PAGE])
  assert.equal((await updateProbe(app)).requests.filter((request) => request.url !== GITHUB_LATEST_API).length, 0)

  await setUpdateReply(app, { body: release('99.0.3') }); await check.click()
  await expect(page.locator('.update-notice')).toContainText('99.0.3')
  await setInstallerMode(app, 'slow')
  await dialog.getByRole('button', { name: 'Download update', exact: true }).click()
  await expect(dialog.getByRole('progressbar', { name: 'Update download progress', exact: true })).toBeVisible()
  await expect.poll(async () => (await updateProbe(app!)).requests.filter((request) => request.url !== GITHUB_LATEST_API).length).toBe(1)
  await dialog.getByRole('button', { name: 'Cancel update download', exact: true }).click()
  await expect.poll(async () => (await state()).status).toBe('available')
  assert.deepEqual(await files(cache), [])
  await setInstallerMode(app, 'corrupt')
  await dialog.getByRole('button', { name: 'Download update', exact: true }).click()
  await expect.poll(async () => (await state()).status).toBe('available')
  await expect(dialog.locator('.management-update-message')).toContainText(/checksum/i)
  assert.deepEqual(await files(cache), []); assert.equal((await updateProbe(app)).installs.length, 0)
  await setInstallerMode(app, 'normal')
  await dialog.getByRole('button', { name: 'Download update', exact: true }).click()
  await expect.poll(async () => (await state()).status, { timeout: 15_000 }).toBe('downloaded')
  const saved = await files(cache)
  assert.equal(saved.length, 1); assert.equal(path.extname(saved[0]), '.exe')
  assert.equal(createHash('sha256').update(await readFile(saved[0])).digest('hex'), createHash('sha256').update(installerFixture()).digest('hex'))
  assert.equal((await state()).downloadedBytes, installerFixture().length)
  assert.equal((await updateProbe(app)).installs.length, 0)
  await expect(dialog.getByRole('button', { name: 'Install now', exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(root, 'test-results', 'updates-downloaded.png') })
  await dialog.getByRole('button', { name: 'Install now', exact: true }).click()
  const confirm = page.getByRole('dialog', { name: 'Install update?', exact: true })
  await expect(confirm).toContainText('active SSH connections and transfers will stop')
  assert.equal((await updateProbe(app)).installs.length, 0)
  await confirm.getByRole('button', { name: 'Not now', exact: true }).click()
  assert.equal((await updateProbe(app)).installs.length, 0)
  await dialog.getByRole('button', { name: 'Install now', exact: true }).click()
  await confirm.getByRole('button', { name: 'Install now', exact: true }).click()
  // The native spawn callback is intercepted before it can execute any file.
  await expect.poll(async () => (await updateProbe(app!)).installs.length).toBe(1)
  await expect.poll(async () => (await state()).status).toBe('downloaded')
  probe = await updateProbe(app)
  assert.equal(probe.installs[0].filename, saved[0])
  assert.deepEqual(probe.installs[0].args, ['/S', '--updated', '--force-run']); assert.equal(probe.installs[0].hidden, true)
  assert.ok(probe.requests.every((request) => !('authorization' in request.headers)))
  assert.ok(probe.requests.filter((request) => request.url !== GITHUB_LATEST_API).every((request) => request.url.startsWith('https://github.com/hellokittypsycho/ssh-heaven/releases/download/v99.0.3/')))
  assert.deepEqual(probe.opened, [GITHUB_DOWNLOAD_PAGE]); assert.deepEqual(errors, [])
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })))
  assert.ok(windows.every((window) => !window.visible && !window.focused && window.offscreen))
  console.log('Background update UI passed: metadata-only startup, user-triggered in-app progress/cancel/retry, SHA256 corruption rejection, ready Install now, explicit confirmation, reverified native launch path/arguments intercepted without execution, and no visible/focused window.')
} catch (error) {
  if (page && app) console.error('Update UI state:', await state().catch(() => null), await updateProbe(app).catch(() => null))
  throw error
} finally {
  await app?.close(); await rm(temporary, { recursive: true, force: true })
}
