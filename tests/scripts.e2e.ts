import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { channels } from '../electron/channels'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-scripts-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const first = await startFixture()
const second = await startFixture()
let app: ElectronApplication | undefined
let page: Page | undefined
const errors: string[] = []
type Submission = { id: string; command: string }
interface ScriptProbe { scriptSubmissions: Submission[]; scriptNotifications: string[]; notificationsShown: number; visibility: string[] }
const original = '#!/bin/sh\nmessage="quoted \'value\' and 中文"\nprintf \'%s\\t%s\\n\' "$message" "192.0.2.55" >> scripts-result.txt\nprintf \'%s\\n\' \'literal\tTAB\' >> scripts-result.txt\nprintf \'%s\\n\' \'SCRIPT-RUN-OK\'\nexit 7\n\n'
const edited = original.replace('exit 7', "printf '%s\\n' 'DRAFT-ONLY' >> scripts-result.txt\nexit 7")
const expected = "quoted 'value' and 中文\t192.0.2.55\nliteral\tTAB\nDRAFT-ONLY\n"
const panel = () => page!.getByRole('region', { name: 'Scripts workspace', exact: true })
const editor = () => panel().getByRole('textbox', { name: 'Script contents', exact: true })
const activePane = () => page!.locator('.session-workspace.is-active-pane')
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open scripts', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const target = window as unknown as { scriptsOutput: string }
    target.scriptsOutput = ''
    window.sshHeaven.onData(({ data }) => { target.scriptsOutput += new TextDecoder().decode(data) })
  })
  await app.evaluate(({ ipcMain, BrowserWindow, Notification }, names) => {
    const target = globalThis as unknown as ScriptProbe
    target.scriptSubmissions = []
    target.scriptNotifications = []; target.notificationsShown = 0; target.visibility = []
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> })._invokeHandlers
    const handler = handlers.get(names.run)!, notify = handlers.get(names.notify)!
    ipcMain.removeHandler(names.run); ipcMain.removeHandler(names.notify)
    ipcMain.handle(names.run, (event, id, command, details) => { target.scriptSubmissions.push({ id, command }); return handler(event, id, command, details) })
    ipcMain.handle(names.notify, (event, id) => { target.scriptNotifications.push(id); return notify(event, id) })
    Notification.prototype.show = function () { target.notificationsShown++; throw new Error('Background tests must never display desktop notifications') }
    for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => target.visibility.push('show')); window.on('focus', () => target.visibility.push('focus')) }
  }, { run: channels.runTerminalScript, notify: channels.notifyScriptRun })
  await hidden()
}
async function submissions(): Promise<Submission[]> { return app!.evaluate(() => (globalThis as unknown as { scriptSubmissions: Submission[] }).scriptSubmissions) }
async function notificationProbe() { return app!.evaluate(() => { const target = globalThis as unknown as ScriptProbe; return { ids: target.scriptNotifications, shown: target.notificationsShown } }) }
async function hidden() {
  const result = await app!.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })), events: (globalThis as unknown as ScriptProbe).visibility }))
  assert.ok(result.windows.every((window) => !window.visible && !window.focused && window.offscreen))
  assert.deepEqual(result.events, [])
}
async function runs() { return page!.evaluate(() => window.sshHeaven.listScriptRuns()) }
async function setCode(content: string) {
  await editor().focus(); await page!.keyboard.press('Control+a'); await page!.keyboard.insertText(content)
}
async function openScripts() { await page!.getByRole('button', { name: 'Open scripts', exact: true }).click(); await expect(panel()).toBeVisible() }
async function connect(name: string) {
  await page!.locator('.sidebar').getByRole('button', { name: `Quick connect ${name}`, exact: true }).click()
  await expect(activePane()).toHaveAttribute('aria-label', `${name} session`)
  await expect.poll(async () => {
    const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true })
    if (await trust.isVisible()) await trust.click()
    return activePane().locator('.terminal-footer').getByText('Connected', { exact: true }).count()
  }, { timeout: 20_000 }).toBe(1)
  await expect(page!.getByRole('dialog', { name: 'Verify server identity', exact: true })).toHaveCount(0)
}
async function target(name: string) {
  const select = panel().getByRole('combobox', { name: 'Script target terminal', exact: true })
  const value = await select.locator('option').filter({ hasText: name }).getAttribute('value')
  assert.ok(value)
  await select.selectOption(value)
  return value
}
async function content(filename: string): Promise<string | null> { return readFile(filename, 'utf8').catch((error) => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }) }

try {
  await launch()
  await page!.evaluate(async (hosts) => {
    for (const [index, host] of hosts.entries()) {
      await window.sshHeaven.importHosts({ text: `${host.host}:${host.username}:${host.password}`, port: host.port, authType: 'password' })
      const profile = (await window.sshHeaven.listProfiles()).find((item) => item.port === host.port)!
      await window.sshHeaven.saveProfile({ ...profile, name: index ? 'Scripts Beta' : 'Scripts Alpha' })
    }
  }, [first, second].map(({ host, port, username, password }) => ({ host, port, username, password })))
  await page!.reload()
  await page!.evaluate(() => {
    const target = window as unknown as { scriptsOutput: string }
    target.scriptsOutput = ''; window.sshHeaven.onData(({ data }) => { target.scriptsOutput += new TextDecoder().decode(data) })
  })
  await connect('Scripts Alpha'); await connect('Scripts Beta')
  await openScripts()
  await expect(panel().getByRole('checkbox', { name: 'Notify when scripts finish', exact: true })).not.toBeChecked()
  await expect(panel().getByRole('combobox', { name: 'Script target terminal', exact: true })).toContainText('Scripts Beta')
  await panel().getByLabel('Script name', { exact: true }).fill('Inspect service')
  await panel().getByLabel('Script group', { exact: true }).fill('Script QA')
  await panel().getByLabel('Script description', { exact: true }).fill('Check quoting, Unicode and literal tab handling.')
  await setCode(original)
  await expect(editor().locator('span').first()).toBeVisible()
  await page!.keyboard.press('Control+s')
  await expect(panel().getByRole('button', { name: 'Open script Inspect service', exact: true })).toBeVisible()
  await expect(panel().getByRole('button', { name: 'Save script', exact: true })).toBeDisabled()
  const saved = (await page!.evaluate(() => window.sshHeaven.getLibrary())).runbooks.find((item) => item.name === 'Inspect service')!
  assert.equal(saved.command, original)

  await panel().getByLabel('Script name', { exact: true }).fill('Unfinished script edit')
  await page!.getByRole('button', { name: 'Open home', exact: true }).click()
  await openScripts()
  await expect(panel().getByLabel('Script name', { exact: true })).toHaveValue('Unfinished script edit')
  await panel().getByRole('button', { name: 'New script', exact: true }).click()
  const discard = page!.getByRole('dialog', { name: 'Discard script changes?', exact: true })
  await discard.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(panel().getByLabel('Script name', { exact: true })).toHaveValue('Unfinished script edit')
  await panel().getByRole('button', { name: 'New script', exact: true }).click()
  await discard.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await setCode('printf disposable\n')
  await panel().getByRole('button', { name: 'Save script', exact: true }).click()
  await expect(panel().getByRole('alert')).toContainText('Give this script a name')
  await panel().getByLabel('Script name', { exact: true }).fill('Disposable script')
  await panel().getByRole('button', { name: 'Save script', exact: true }).click()
  await expect(panel().getByRole('button', { name: 'Open script Disposable script', exact: true })).toBeVisible()
  await panel().getByLabel('Search scripts', { exact: true }).fill('Inspect')
  await expect(panel().getByRole('button', { name: 'Open script Disposable script', exact: true })).toHaveCount(0)
  await panel().getByRole('button', { name: 'Open script Inspect service', exact: true }).click()
  await panel().getByLabel('Search scripts', { exact: true }).fill('')
  await setCode(edited)
  const alphaId = await target('Scripts Alpha')
  await panel().getByRole('button', { name: 'Review script run', exact: true }).click()
  const review = page!.getByRole('dialog', { name: 'Run script in terminal?', exact: true })
  await expect(review.getByLabel('Script run preview', { exact: true })).toHaveText(edited)
  await expect(review).toContainText('Scripts Alpha')
  await review.getByRole('button', { name: 'Cancel run', exact: true }).click()
  assert.deepEqual(await submissions(), [])
  assert.equal(await content(path.join(first.root, 'scripts-result.txt')), null)
  await panel().getByRole('button', { name: 'Review script run', exact: true }).click()
  await review.getByRole('button', { name: 'Run reviewed script', exact: true }).evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
  await expect.poll(() => content(path.join(first.root, 'scripts-result.txt'))).toBe(expected)
  await expect(page!.getByRole('tab', { name: 'Scripts Alpha', exact: true })).toHaveAttribute('aria-selected', 'true')
  assert.equal(await content(path.join(second.root, 'scripts-result.txt')), null)
  assert.deepEqual(await submissions(), [{ id: alphaId, command: edited }])
  await expect.poll(async () => (await runs()).find((run) => run.sessionId === alphaId)?.status).toBe('failed')
  const alphaRun = (await runs()).find((run) => run.sessionId === alphaId)!
  assert.equal(alphaRun.exitCode, 7); assert.equal(alphaRun.scriptId, saved.id); assert.equal(alphaRun.name, 'Inspect service')
  assert.ok(alphaRun.durationMs! >= 0)
  assert.deepEqual((await notificationProbe()).ids, [], 'notifications must remain opt-in')
  assert.equal((await notificationProbe()).shown, 0)
  assert.equal((await page!.evaluate(() => (window as unknown as { scriptsOutput: string }).scriptsOutput)).includes('\x1b]777;ssh-heaven;'), false, 'private completion frames must never enter terminal history')
  assert.equal((await page!.evaluate(() => window.sshHeaven.getLibrary())).runbooks.find((item) => item.id === saved.id)!.command, original, 'Running an unsaved draft must not overwrite its saved script')
  await activePane().locator('.xterm-helper-textarea').focus()
  await page!.keyboard.type('echo TERMINAL-STILL-OPEN'); await page!.keyboard.press('Enter')
  await expect.poll(() => page!.evaluate(() => (window as unknown as { scriptsOutput: string }).scriptsOutput)).toContain('TERMINAL-STILL-OPEN')

  await openScripts()
  const alphaResult = panel().locator(`.script-run-result[data-run-id="${alphaRun.id}"]`)
  await expect(alphaResult).toHaveAttribute('data-status', 'failed')
  await expect(alphaResult).toContainText('Exit 7')
  await expect(alphaResult).toContainText(/\d+\.\ds/)
  await panel().getByRole('checkbox', { name: 'Notify when scripts finish', exact: true }).check()
  await panel().getByRole('button', { name: 'Review script run', exact: true }).click()
  await page!.evaluate((id) => window.sshHeaven.disconnect(id), alphaId)
  await expect(review.getByRole('button', { name: 'Run reviewed script', exact: true })).toBeDisabled()
  await expect(review.getByRole('alert')).toContainText('target terminal changed')
  await review.getByRole('button', { name: 'Cancel run', exact: true }).click()
  const betaId = await target('Scripts Beta')
  await page!.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await expect(editor()).not.toContainText('192.0.2.55')
  await expect(editor().locator('.stream-private-widget')).toContainText('•')
  await editor().focus()
  await page!.keyboard.press('Control+f')
  const editorSearch = panel().locator('.cm-search input[name="search"]')
  await editorSearch.fill('192.0.2.55')
  await editorSearch.dispatchEvent('change')
  assert.equal(await editorSearch.evaluate((input) => getComputedStyle(input).getPropertyValue('-webkit-text-security')), 'disc')
  await editorSearch.press('Enter')
  const announcement = await panel().locator('.cm-announced').textContent()
  assert.ok(!announcement?.includes('192.0.2.55'), 'screen-reader search announcements must not disclose the raw address')
  assert.ok(announcement?.includes('•'), 'the search announcement must retain useful masked context')
  await editorSearch.press('Escape')
  await panel().getByRole('button', { name: 'Review script run', exact: true }).click()
  await expect(review.getByLabel('Script run preview', { exact: true })).not.toContainText('192.0.2.55')
  await review.getByRole('button', { name: 'Run reviewed script', exact: true }).click()
  await expect.poll(() => content(path.join(second.root, 'scripts-result.txt'))).toBe(expected)
  assert.deepEqual(await submissions(), [{ id: alphaId, command: edited }, { id: betaId, command: edited }], 'Stream mode must mask only the display, preserving the exact script and real terminal target')
  await expect.poll(async () => (await runs()).find((run) => run.sessionId === betaId)?.status).toBe('failed')
  await expect.poll(async () => (await notificationProbe()).ids.length).toBe(1)
  assert.equal((await notificationProbe()).shown, 0, 'background mode suppresses desktop notifications even when opted in')
  await page!.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await openScripts()

  await setCode("printf '%s\\n' 'SCRIPT-SUCCESS-OK'\n")
  await panel().getByLabel('Script name', { exact: true }).fill('Completion probe')
  await panel().getByRole('button', { name: 'Review script run', exact: true }).click()
  await review.getByRole('button', { name: 'Run reviewed script', exact: true }).click()
  await expect.poll(async () => (await runs()).find((run) => run.name === 'Completion probe')?.status).toBe('completed')
  const completed = (await runs()).find((run) => run.name === 'Completion probe')!
  assert.equal(completed.exitCode, 0); assert.ok(completed.finishedAt! >= completed.startedAt)
  await expect.poll(async () => (await notificationProbe()).ids.length).toBe(2)
  await openScripts()
  await expect(panel().locator(`.script-run-result[data-run-id="${completed.id}"]`)).toContainText('Completed')
  await expect(panel().locator(`.script-run-result[data-run-id="${completed.id}"]`)).toContainText('Exit 0')
  await setCode("printf '%s\\n' 'SCRIPT-WAITING-FOR-INPUT'\nread response\nprintf '%s' \"$response\"\n")
  await panel().getByLabel('Script name', { exact: true }).fill('Disconnect probe')
  await panel().getByRole('button', { name: 'Review script run', exact: true }).click()
  await review.getByRole('button', { name: 'Run reviewed script', exact: true }).click()
  await expect.poll(() => page!.evaluate(() => (window as unknown as { scriptsOutput: string }).scriptsOutput)).toContain('SCRIPT-WAITING-FOR-INPUT')
  const pending = (await runs()).find((run) => run.name === 'Disconnect probe')!
  assert.equal(pending.status, 'running')
  await openScripts()
  await expect(panel().getByRole('button', { name: 'Review script run', exact: true })).toBeDisabled()
  await expect(panel().locator(`.script-run-result[data-run-id="${pending.id}"]`)).toContainText('Running')
  await panel().getByRole('region', { name: 'Script run history', exact: true }).scrollIntoViewIfNeeded()
  await page!.screenshot({ path: path.join(root, 'test-results', 'scripts-results.png') })
  await page!.evaluate((id) => window.sshHeaven.disconnect(id), betaId)
  await expect.poll(async () => (await runs()).find((run) => run.id === pending.id)?.status).toBe('disconnected')
  await expect(panel().locator(`.script-run-result[data-run-id="${pending.id}"]`)).toContainText('Disconnected')
  await expect.poll(async () => (await notificationProbe()).ids.length).toBe(3)
  assert.equal((await notificationProbe()).shown, 0)
  assert.equal((await runs()).find((run) => run.id === pending.id)?.exitCode, undefined)
  await hidden()

  await panel().getByRole('button', { name: 'Open script Disposable script', exact: true }).click()
  await discard.getByRole('button', { name: 'Discard changes', exact: true }).click()
  await panel().getByRole('button', { name: 'Delete script Disposable script', exact: true }).click()
  const deletion = page!.getByRole('dialog', { name: 'Delete saved script?', exact: true })
  await deletion.getByRole('button', { name: 'Keep script', exact: true }).click()
  await expect(panel().getByRole('button', { name: 'Open script Disposable script', exact: true })).toBeVisible()
  await panel().getByRole('button', { name: 'Delete script Disposable script', exact: true }).click()
  await deletion.getByRole('button', { name: 'Confirm delete script', exact: true }).click()
  await expect(panel().getByRole('button', { name: 'Open script Disposable script', exact: true })).toHaveCount(0)
  await app!.close(); app = undefined
  await launch(); await openScripts()
  await panel().getByRole('button', { name: 'Open script Inspect service', exact: true }).click()
  await expect(panel().getByLabel('Script name', { exact: true })).toHaveValue('Inspect service')
  await expect(panel().getByRole('button', { name: 'Review script run', exact: true })).toBeDisabled()
  await expect(panel().getByRole('checkbox', { name: 'Notify when scripts finish', exact: true })).toBeChecked()
  assert.deepEqual(await runs(), [], 'run results are session-local and must not persist after a fresh process')
  assert.deepEqual((await page!.evaluate(() => window.sshHeaven.getLibrary())).runbooks.map((item) => ({ name: item.name, command: item.command })), [{ name: 'Inspect service', command: original }])
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680))
  await expect(panel().getByRole('button', { name: 'Save script', exact: true })).toBeInViewport()
  await expect(panel().getByRole('button', { name: 'Review script run', exact: true })).toBeInViewport()
  await page!.screenshot({ path: path.join(root, 'test-results', 'scripts-workspace.png') })
  assert.deepEqual(errors, [])
  await hidden()
  console.log('Scripts E2E passed in hidden offscreen mode: persistent CRUD/draft guards, reviewed exact-once live-terminal execution with exact shell bytes, real completed/failed/disconnected results and exit/duration, owned run history with private marker stripping, opt-in notification requests suppressed on the desktop, target switching, and display-only Stream mode.')
} catch (error) {
  if (page && app) await page.screenshot({ path: path.join(root, 'test-results', 'scripts-failure.png') }).catch(() => {})
  throw error
} finally {
  if (app) await hidden()
  await app?.close(); await Promise.all([first.close(), second.close()])
  await rm(temporary, { recursive: true, force: true })
}
