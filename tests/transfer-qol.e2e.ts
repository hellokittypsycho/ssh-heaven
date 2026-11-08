import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { TransferJob } from '../shared/types'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-transfer-qol-'))
const directory = path.join(temporary, 'settings'), downloads = path.join(temporary, 'downloads')
await mkdir(directory); await mkdir(downloads); await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture({ ioDelayMs: 8 })
const first = randomBytes(1024 * 1024), second = randomBytes(128 * 1024), third = randomBytes(128 * 1024)
const names = ['first.bin', 'second.bin', 'third.bin']
const sources = names.map((name) => path.join(temporary, name))
await Promise.all([writeFile(sources[0], first), writeFile(sources[1], second), writeFile(sources[2], third)])
const original = Buffer.from('Keep the old remote destination until commit')
await writeFile(path.join(fixture.root, names[0]), original)
let app: ElectronApplication | undefined, page: Page | undefined, stage = 'launch'
const errors: string[] = []
interface Probe { events: TransferJob[] }
const probe = () => page!.evaluate(() => (window as unknown as { transferQol: Probe }).transferQol.events)
const watchdog = setTimeout(() => { console.error(`Transfer QoL timed out during ${stage}`); app?.process().kill() }, 120_000)
watchdog.unref()

async function assertHidden() {
  const windows = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })))
  assert.ok(windows.length && windows.every((window) => !window.visible && !window.focused && window.offscreen), 'Every QA window must remain hidden, unfocused and offscreen')
}
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${directory}`], env, timeout: 30_000 })
  page = await app.firstWindow(); page.setDefaultTimeout(12_000)
  page.on('pageerror', (error) => errors.push(error.message))
  await assertHidden()
  await page.evaluate(() => {
    const probe: Probe = { events: [] }
    ;(window as unknown as { transferQol: Probe }).transferQol = probe
    window.sshHeaven.onTransfer((event) => { probe.events.push(event); if (probe.events.length > 1000) probe.events.shift() })
  })
}
async function chooseFiles(paths: string[]) {
  await app!.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog
    // Only fixture files are replaced. No native dialog or OS input is used.
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  }, paths)
}

try {
  await launch()
  stage = 'connect'
  await page!.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page!.getByLabel(/^Nickname/).fill('Transfer QoL fixture')
  await page!.getByLabel('Hostname or IP address').fill(fixture.host)
  await page!.getByLabel('SSH port').fill(String(fixture.port))
  await page!.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page!.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page!.getByRole('button', { name: 'Connect', exact: true }).click()
  await page!.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page!.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  const files = page!.getByRole('complementary', { name: 'Remote files', exact: true })
  const row = (name: string, direction = 'upload') => files.getByRole('article', { name: new RegExp(`^${direction} ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`) })
  const limit = files.getByRole('combobox', { name: 'Transfer bandwidth limit', exact: true })
  await expect(limit).toBeVisible()
  await limit.selectOption(String(64 * 1024))
  await expect.poll(() => page!.evaluate(() => window.sshHeaven.getTransferBandwidthLimit())).toBe(64 * 1024)
  await chooseFiles(sources)
  stage = 'upload pause and queue reorder'
  await files.getByRole('button', { name: 'Upload files', exact: true }).click()
  await expect(row(names[0]).locator('small').first()).toContainText('ETA')
  await row(names[0]).getByRole('button', { name: 'Pause transfer first.bin', exact: true }).click()
  await expect(row(names[0])).toHaveAttribute('aria-label', 'upload first.bin: paused')
  await expect(row(names[0])).toContainText('Paused in progress')
  await row(names[1]).getByRole('button', { name: 'Pause transfer second.bin', exact: true }).click()
  await expect(row(names[1])).toContainText('Paused before starting')
  await row(names[2]).getByRole('button', { name: 'Move transfer third.bin up', exact: true }).click()
  await expect(row(names[2])).toContainText('Waiting · queue #1')
  await expect(row(names[1])).toContainText('queue #2')
  const paused = (await probe()).filter((event) => event.name === names[0]).at(-1)!
  assert.equal(paused.status, 'paused'); assert.ok(paused.transferred > 0 && paused.transferred < paused.total)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const partialName = (await readdir(fixture.root)).find((name) => name.endsWith('.part'))!
  assert.ok(partialName)
  const partialSize = (await stat(path.join(fixture.root, partialName))).size
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal((await stat(path.join(fixture.root, partialName))).size, partialSize)
  assert.deepEqual(await readFile(path.join(fixture.root, names[0])), original)
  await files.locator('.sftp-transfer-list').evaluate((element) => { element.scrollTop = 0 })
  await page!.screenshot({ path: path.join(root, 'test-results', 'transfer-qol-paused.png') })
  await limit.selectOption('0')
  await row(names[0]).getByRole('button', { name: 'Resume transfer first.bin', exact: true }).click()
  await expect(row(names[2])).toHaveAttribute('aria-label', 'upload third.bin: completed')
  await expect(row(names[1])).toHaveAttribute('aria-label', 'upload second.bin: paused')
  const completed = (await probe()).filter((event) => event.status === 'completed')
  assert.deepEqual(completed.map((event) => event.name), [names[0], names[2]])
  assert.equal(completed[0].id, paused.id, 'Resume must complete the original transfer identity')
  await row(names[1]).getByRole('button', { name: 'Resume transfer second.bin', exact: true }).click()
  await expect(row(names[1])).toHaveAttribute('aria-label', 'upload second.bin: completed')
  for (const [index, bytes] of [first, second, third].entries()) assert.deepEqual(await readFile(path.join(fixture.root, names[index])), bytes)

  stage = 'download pause and resume'
  await limit.selectOption(String(64 * 1024))
  const localOriginal = Buffer.from('Keep the original local destination while paused')
  await writeFile(path.join(downloads, names[0]), localOriginal)
  await chooseFiles([downloads])
  await files.getByLabel('Select first.bin', { exact: true }).check()
  await files.getByRole('button', { name: 'Download selected file', exact: true }).click()
  await expect(row(names[0], 'download').locator('small').first()).toContainText('ETA')
  await row(names[0], 'download').getByRole('button', { name: 'Pause transfer first.bin', exact: true }).click()
  await expect(row(names[0], 'download')).toHaveAttribute('aria-label', 'download first.bin: paused')
  assert.deepEqual(await readFile(path.join(downloads, names[0])), localOriginal)
  await limit.selectOption('0')
  await row(names[0], 'download').getByRole('button', { name: 'Resume transfer first.bin', exact: true }).click()
  await expect(row(names[0], 'download')).toHaveAttribute('aria-label', 'download first.bin: completed')
  assert.deepEqual(await readFile(path.join(downloads, names[0])), first)
  assert.deepEqual(await readdir(downloads), [names[0]])

  stage = 'paused cancellation'
  const canceledFile = path.join(temporary, 'cancel-me.bin')
  await writeFile(canceledFile, first)
  await chooseFiles([canceledFile]); await limit.selectOption(String(64 * 1024))
  await files.getByRole('button', { name: 'Upload files', exact: true }).click()
  await expect(row('cancel-me.bin').locator('small').first()).toContainText('ETA')
  await row('cancel-me.bin').getByRole('button', { name: 'Pause transfer cancel-me.bin', exact: true }).click()
  await expect(row('cancel-me.bin')).toHaveAttribute('aria-label', 'upload cancel-me.bin: paused')
  await row('cancel-me.bin').getByRole('button', { name: 'Cancel transfer cancel-me.bin', exact: true }).click()
  await expect(row('cancel-me.bin')).toHaveAttribute('aria-label', 'upload cancel-me.bin: canceled')
  assert.equal((await readdir(fixture.root)).some((name) => name.endsWith('.part') || name === 'cancel-me.bin'), false)
  await page!.locator('.session-workspace.is-active-pane .xterm-helper-textarea').focus()
  await page!.keyboard.type('echo transfer-qol-still-connected'); await page!.keyboard.press('Enter')
  await expect(page!.locator('.session-workspace.is-active-pane .xterm-rows')).toContainText('transfer-qol-still-connected')

  stage = 'custom bandwidth persistence'
  await limit.selectOption('custom')
  await files.getByRole('spinbutton', { name: 'Custom transfer limit in KiB per second', exact: true }).fill('96')
  await files.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect.poll(() => page!.evaluate(() => window.sshHeaven.getTransferBandwidthLimit())).toBe(96 * 1024)
  assert.equal(await page!.evaluate(() => localStorage.getItem('ssh-heaven:transfer-bandwidth-limit')), String(96 * 1024))
  await assertHidden(); await app!.close(); app = undefined
  await launch()
  await expect.poll(() => page!.evaluate(() => window.sshHeaven.getTransferBandwidthLimit())).toBe(96 * 1024)
  await assertHidden()
  assert.deepEqual(errors, [])
  console.log('Transfer QoL E2E passed: real streaming pause/resume, retained transfer identity and original destinations, ETA, queued-job reorder, paused cancellation, persistent all-session bandwidth limits, and a responsive shell. All windows stayed hidden and unfocused.')
} catch (error) {
  console.error(`Transfer QoL failure during ${stage}`)
  await page?.screenshot({ path: path.join(root, 'test-results', 'transfer-qol-failure.png'), timeout: 5000 }).catch(() => {})
  if (page) console.error((await page.locator('.sftp-transfers').innerText({ timeout: 2000 }).catch(() => '')).slice(0, 4000))
  throw error
} finally {
  clearTimeout(watchdog)
  await app?.close().catch(() => {})
  await fixture.close()
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()))
  await rm(temporary, { recursive: true, force: true })
}
