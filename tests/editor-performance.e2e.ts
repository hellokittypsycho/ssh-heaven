import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { channels } from '../electron/channels'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-editor-performance-'))
const dataDirectory = path.join(temporary, 'settings')
const baseline = process.env.SSH_HEAVEN_EDITOR_BASELINE === '1'
await mkdir(dataDirectory); await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture()
const original = '\uFEFF' + Array.from({ length: 8500 }, (_, index) => `row ${String(index).padStart(5, '0')} ${'x'.repeat(72)}`).join('\r\n') + '\r\n'
for (let index = 0; index < 6; index++) await writeFile(path.join(fixture.root, `large${index}.txt`), original)
await writeFile(path.join(fixture.root, 'late.txt'), 'late response must not replace another document\n')
type Probe = { largeEncodes: number; encodedUnits: number; encodeMilliseconds: number; samples: number[]; pending?: { key: string; started?: number }; trusted: boolean[] }
let app: ElectronApplication | undefined, page: Page | undefined
const errors: string[] = []
const editor = () => page!.getByRole('dialog', { name: 'Remote file editor', exact: true })
const active = () => editor().getByRole('tabpanel')
const contents = () => active().getByRole('textbox', { name: 'Remote file contents', exact: true })
async function frame() { await page!.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))) }
async function openFile(filename: string) {
  await editor().getByRole('button', { name: 'Open remote file path', exact: true }).click()
  const dialog = page!.getByRole('dialog', { name: 'Open remote file', exact: true })
  await dialog.getByLabel('Remote file path', { exact: true }).fill(`/${filename}`)
  await dialog.getByRole('button', { name: 'Open file', exact: true }).click()
  await expect(active().locator('.remote-editor-body')).toHaveAttribute('aria-busy', 'false')
}
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE; env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow(); page.on('pageerror', (cause) => errors.push(cause.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  await page.evaluate(async (host) => {
    await window.sshHeaven.importHosts({ text: `${host.host}:${host.username}:${host.password}`, port: host.port, authType: 'password' })
    const profile = (await window.sshHeaven.listProfiles())[0]
    await window.sshHeaven.saveProfile({ ...profile, name: 'Editor performance' })
  }, { host: fixture.host, port: fixture.port, username: fixture.username, password: fixture.password })
  await page.reload()
  await page.locator('.sidebar').getByRole('button', { name: 'Quick connect Editor performance', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Trust & connect', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  await page.getByRole('complementary', { name: 'Remote files', exact: true }).getByText('large0.txt', { exact: true }).dblclick()
  await expect(contents()).toContainText('row 00000')
  const firstNode = await active().locator('.cm-editor').elementHandle()
  for (let index = 1; index < 6; index++) await openFile(`large${index}.txt`)
  await editor().getByRole('tab', { name: /large0.txt on Editor performance/ }).click()
  await contents().focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('ArrowLeft'); await frame()
  await page.evaluate(() => {
    const target = window as unknown as { editorPerformance: Probe }
    const probe: Probe = target.editorPerformance = { largeEncodes: 0, encodedUnits: 0, encodeMilliseconds: 0, samples: [], trusted: [] }
    const original = TextEncoder.prototype.encode
    TextEncoder.prototype.encode = function (value) {
      const start = performance.now(), result = original.call(this, value)
      if (typeof value === 'string' && value.length > 128 * 1024) { probe.largeEncodes++; probe.encodedUnits += value.length; probe.encodeMilliseconds += performance.now() - start }
      return result
    }
    window.addEventListener('keydown', (event) => {
      const pending = probe.pending
      if (!pending || event.key !== pending.key || pending.started !== undefined) return
      pending.started = performance.now(); probe.trusted.push(event.isTrusted)
      requestAnimationFrame(() => { probe.samples.push(performance.now() - pending.started!); probe.pending = undefined })
    }, true)
  })
  for (const [index, key] of [...'ABCDEFGHIJKLMNOPQRSTUVWX'].entries()) {
    await page.keyboard.press('Shift+ArrowLeft')
    await page.evaluate((key) => { (window as unknown as { editorPerformance: Probe }).editorPerformance.pending = { key } }, key)
    await page.keyboard.press(key)
    await page.waitForFunction((count) => (window as unknown as { editorPerformance: Probe }).editorPerformance.samples.length === count, index + 1)
  }
  const cursor = await active().locator('.remote-editor-position').innerText()
  await editor().getByRole('tab', { name: /large5.txt on Editor performance/ }).click()
  await editor().getByRole('tab', { name: /large0.txt on Editor performance/ }).click()
  await expect(active().locator('.remote-editor-position')).toHaveText(cursor)
  assert.equal(await firstNode!.evaluate((node) => node.isConnected), true)
  await contents().focus()
  let undoCount = 0
  while (await active().getByRole('button', { name: 'Save remote file', exact: true }).isEnabled()) {
    assert.ok(undoCount++ < 32, 'Undo must return the large document exactly to its saved baseline')
    await page.keyboard.press('Control+z'); await frame()
  }
  for (let index = 0; index < undoCount; index++) { await page.keyboard.press('Control+y'); await frame() }
  await expect(active().getByRole('button', { name: 'Save remote file', exact: true })).toBeEnabled()
  const probe = await page.evaluate(() => (window as unknown as { editorPerformance: Probe }).editorPerformance)
  assert.equal(probe.samples.length, 24); assert.ok(probe.trusted.every(Boolean))
  if (baseline) assert.ok(probe.largeEncodes > 0, 'Baseline should observe the existing full-file encoder path')
  else assert.equal(probe.largeEncodes, 0, 'Editing/undo/redo must not encode the complete file on each change')
  const sorted = [...probe.samples].sort((a, b) => a - b)
  const summary = { baseline, version: await app.evaluate(({ app }) => app.getVersion()), tabs: 6, fileBytes: Buffer.byteLength(original), sameLengthKeys: probe.samples.length, largeEncodes: probe.largeEncodes, encodedUnits: probe.encodedUnits, encodeMilliseconds: probe.encodeMilliseconds, medianKeyToFrameMs: sorted[Math.floor(sorted.length / 2)], p95KeyToFrameMs: sorted[Math.ceil(sorted.length * .95) - 1], undoCount }
  await writeFile(path.join(root, 'test-results', baseline ? 'editor-performance-baseline.json' : 'editor-performance.json'), JSON.stringify(summary, null, 2))
  console.log('Editor performance metrics', JSON.stringify(summary))
  await active().getByRole('button', { name: 'Save remote file', exact: true }).click()
  await page.getByRole('dialog', { name: 'Review file changes', exact: true }).getByRole('button', { name: 'Confirm save to server', exact: true }).click()
  await expect(active().getByRole('status')).toContainText('Saved to server')
  const last = original.lastIndexOf('x')
  assert.equal(await readFile(path.join(fixture.root, 'large0.txt'), 'utf8'), original.slice(0, last) + 'X' + original.slice(last + 1), 'Save must preserve exact BOM/CRLF after typing, undo and redo')
  await contents().focus(); await page.keyboard.press('Control+z'); await frame()
  await expect(active().getByRole('button', { name: 'Save remote file', exact: true })).toBeEnabled()
  await page.keyboard.press('Control+y'); await frame()
  await expect(active().getByRole('button', { name: 'Save remote file', exact: true })).toBeDisabled()
  // Reloading unchanged server bytes must still discard an edited view even
  // though its baseline value prop is unchanged, without remounting CodeMirror.
  await page.keyboard.press('Control+z'); await frame()
  await active().getByRole('button', { name: 'Reload remote file', exact: true }).click()
  await page.getByRole('button', { name: 'Discard and reload', exact: true }).click()
  await expect(active().getByRole('button', { name: 'Save remote file', exact: true })).toBeDisabled()
  await expect(active().locator('.cm-line').filter({ hasText: /row 08499/ })).toContainText(/X$/)
  assert.equal(await firstNode!.evaluate((node) => node.isConnected), true)
  // Hold a real read response, close its loading tab, then release it. It must
  // not replace the surviving active file or resurrect the closed tab.
  await app.evaluate(({ ipcMain }, channel) => {
    const target = globalThis as unknown as { editorReadHeld?: boolean; releaseEditorRead?: () => void; originalEditorRead?: (event: unknown, id: string, path: string) => unknown }
    target.originalEditorRead = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, id: string, path: string) => unknown> })._invokeHandlers.get(channel)!
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, id, path) => {
      const result = await target.originalEditorRead!(event, id, path)
      if (path === '/late.txt') { target.editorReadHeld = true; await new Promise<void>((resolve) => { target.releaseEditorRead = resolve }) }
      return result
    })
  }, channels.readRemoteFile)
  await editor().getByRole('button', { name: 'Open remote file path', exact: true }).click()
  const pathDialog = page.getByRole('dialog', { name: 'Open remote file', exact: true })
  await pathDialog.getByLabel('Remote file path', { exact: true }).fill('/late.txt'); await pathDialog.getByRole('button', { name: 'Open file', exact: true }).click()
  await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { editorReadHeld?: boolean }).editorReadHeld)).toBe(true)
  await editor().getByRole('button', { name: 'Close late.txt on Editor performance', exact: true }).click()
  await app.evaluate(({ ipcMain }, channel) => {
    const target = globalThis as unknown as { releaseEditorRead?: () => void; originalEditorRead?: (event: unknown, id: string, path: string) => unknown }
    target.releaseEditorRead?.(); ipcMain.removeHandler(channel); ipcMain.handle(channel, target.originalEditorRead!)
  }, channels.readRemoteFile)
  await expect(editor().getByRole('tab', { name: /late.txt/ })).toHaveCount(0)
  await expect(contents()).toContainText('row 00000')
  assert.equal(await firstNode!.evaluate((node) => node.isConnected), true)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })))
  assert.ok(windows.every((window) => !window.visible && !window.focused && window.offscreen)); assert.deepEqual(errors, [])
  console.log('Hidden editor regression passed: six large tabs, same-length EOF edits, undo-to-baseline/redo, retained selection/instances, exact BOM/CRLF save and closed-tab late-read guard.')
} catch (cause) { await page?.screenshot({ path: path.join(root, 'test-results', 'editor-performance-failure.png') }).catch(() => {}); throw cause }
finally { await app?.close(); await fixture.close(); await rm(temporary, { recursive: true, force: true }) }
