import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { UpdateState } from '../shared/types'
import { GITHUB_DOWNLOAD_PAGE, GITHUB_LATEST_API, installUpdateFixture, release, setUpdateReply, updateProbe } from './update-fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = process.env.SSH_HEAVEN_EXECUTABLE || path.join(root, 'release', 'win-unpacked', 'SSH Heaven.exe')
if (!(await stat(executable).catch(() => null))?.isFile()) throw new Error('Updates E2E needs a fresh packaged app. Run npm run dist:win first, or set SSH_HEAVEN_EXECUTABLE to a packaged SSH Heaven executable.')
const expectedVersion = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-updates-ui-'))
const directory = path.join(temporary, 'settings')
await mkdir(directory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
let app: ElectronApplication | undefined
let page: Page | undefined
const errors: string[] = []
let popupCount = 0
async function state() { return page!.evaluate(() => window.sshHeaven.getUpdateState()) }
async function updatesPanel(): Promise<Locator> {
  const before = (await updateProbe(app!)).requests.length
  await page!.locator('.sidebar').getByRole('button', { name: 'Updates', exact: true }).click()
  const dialog = page!.getByRole('dialog', { name: 'Workspace library', exact: true })
  await expect(dialog.getByRole('button', { name: 'Updates', exact: true })).toHaveAttribute('aria-pressed', 'true')
  assert.equal((await updateProbe(app!)).requests.length, before, 'Opening update status must not start another check or download')
  return dialog
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const launchedAt = Date.now()
  app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${directory}`], env, timeout: 30_000 })
  // Install before waiting for renderer readiness, ahead of its five-second
  // startup timer. The shipped configuration and native parser stay real.
  const installed = await installUpdateFixture(app, { body: release('99.0.0') })
  assert.equal(installed.packaged, true, 'The enabled update path is tested only in the packaged app')
  assert.equal(installed.version, expectedVersion, 'The packaged app is outdated. Run npm run dist:win to rebuild before testing updates.')
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('popup', () => popupCount++)
  const rendererUrl = page.url()
  assert.notEqual((await state()).status, 'unconfigured', 'This packaged app has no enabled release feed. Rebuild the current release before testing updates.')
  await page.evaluate(() => {
    const target = window as unknown as { updateTestEvents: UpdateState[] }
    target.updateTestEvents = []
    window.sshHeaven.onUpdate((event) => target.updateTestEvents.push(event))
  })
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), false)
  await expect.poll(async () => (await updateProbe(app!)).requests.length, { timeout: 15_000 }).toBe(1)
  await expect(page.locator('.update-notice')).toContainText('99.0.0')
  const shortcut = page.locator('.sidebar').getByRole('button', { name: 'Updates', exact: true })
  await expect(shortcut.locator('.update-available-dot')).toBeVisible()
  let probe = await updateProbe(app)
  assert.ok(probe.requests[0].at - launchedAt >= 4500, 'The startup check should run after the five-second startup delay')
  assert.equal(probe.requests[0].url, GITHUB_LATEST_API)
  assert.deepEqual(probe.requests[0].headers, { accept: 'application/vnd.github+json', 'accept-encoding': 'identity', 'user-agent': 'SSH-Heaven-Update-Check', 'x-github-api-version': '2026-03-10' })
  assert.deepEqual(probe.opened, [], 'A startup version check must not navigate or download anything')
  assert.equal((await state()).currentVersion, installed.version)
  assert.equal((await state()).status, 'available')
  await page.screenshot({ path: path.join(root, 'test-results', 'updates-available.png') })
  await page.getByRole('button', { name: 'Dismiss update notification', exact: true }).click()
  await expect(page.locator('.update-notice')).toHaveCount(0)
  await expect(shortcut.locator('.update-available-dot')).toBeVisible()

  let dialog = await updatesPanel()
  const check = dialog.getByRole('button', { name: 'Check for updates', exact: true })
  await check.click()
  await expect(dialog.locator('.management-update-message')).toContainText('99.0.0')
  await expect(page.locator('.update-notice')).toHaveCount(0)
  assert.deepEqual((await updateProbe(app)).opened, [], 'Manual metadata checks must not open the download page')
  await setUpdateReply(app, { body: release('99.0.1') })
  await check.click()
  await expect(page.locator('.update-notice')).toContainText('99.0.1')
  await expect(dialog.getByRole('button', { name: 'Open download page', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^(?:Install|Download update|Restart)/i })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Open download page', exact: true }).click()
  assert.deepEqual((await updateProbe(app)).opened, [GITHUB_DOWNLOAD_PAGE], 'Only the fixed release page may open; feed-provided URLs are ignored')
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Update available', exact: true }).click()
  assert.deepEqual((await updateProbe(app)).opened, [GITHUB_DOWNLOAD_PAGE, GITHUB_DOWNLOAD_PAGE])

  dialog = await updatesPanel()
  await setUpdateReply(app, { body: release(installed.version) })
  await dialog.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await expect(dialog.locator('.management-update-message')).toContainText('No newer stable release is available')
  assert.equal((await state()).status, 'not-available')
  await expect(page.locator('.update-notice')).toHaveCount(0)
  await expect(shortcut.locator('.update-available-dot')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Open download page', exact: true })).toHaveCount(0)
  const deniedDownload = await page.evaluate(() => window.sshHeaven.openUpdateDownload().then(() => false, () => true))
  assert.equal(deniedDownload, true)

  await setUpdateReply(app, { error: 'Offline update fixture' })
  await dialog.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await expect(dialog.locator('.management-update-message')).toContainText(/offline/i)
  assert.equal((await state()).status, 'error')
  await expect(page.locator('.update-notice')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled()
  assert.equal((await updateProbe(app)).opened.length, 2)
  await page.screenshot({ path: path.join(root, 'test-results', 'updates-offline.png') })
  await setUpdateReply(app, { body: release('99.0.2') })
  await dialog.getByRole('button', { name: 'Check for updates', exact: true }).click()
  await expect(dialog.locator('.management-update-message')).toContainText('99.0.2')
  await expect(page.locator('.update-notice')).toContainText('99.0.2')
  for (const excluded of [{ draft: true }, { prerelease: true }]) {
    await setUpdateReply(app, { body: { ...release('99.0.3'), ...excluded } })
    await dialog.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await expect.poll(async () => (await state()).status).not.toBe('checking')
    assert.notEqual((await state()).status, 'available', 'Draft and prerelease tags must not be offered as stable updates')
    await expect(page.locator('.update-notice')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: 'Open download page', exact: true })).toHaveCount(0)
  }
  probe = await updateProbe(app)
  assert.ok(probe.requests.length >= 8)
  assert.ok(probe.requests.every((request) => request.url === GITHUB_LATEST_API))
  assert.ok(probe.requests.every((request) => !('authorization' in request.headers)), 'Release checks must not send account credentials')
  assert.deepEqual(probe.opened, [GITHUB_DOWNLOAD_PAGE, GITHUB_DOWNLOAD_PAGE])
  assert.equal(page.url(), rendererUrl, 'Update metadata must not navigate the application renderer')
  assert.equal(popupCount, 0)
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), false)
  assert.deepEqual(errors, [])
  console.log('Packaged background updates E2E passed: delayed GitHub startup check, exact URL/headers, version dismissal and supersession, current/offline/retry states, draft/prerelease rejection, fixed manual-only release-page actions, and no installer/network/browser automation.')
} catch (error) {
  if (page && app) await page.screenshot({ path: path.join(root, 'test-results', 'updates-failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.close()
  await rm(temporary, { recursive: true, force: true })
}
