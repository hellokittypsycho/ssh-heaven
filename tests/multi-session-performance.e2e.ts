import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { channels } from '../electron/channels'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-many-sessions-'))
const directory = path.join(temporary, 'settings')
await mkdir(directory)
const fixtures = await Promise.all([startFixture(), startFixture()])
let app: ElectronApplication | undefined, page: Page | undefined
const errors: string[] = []
type Probe = { requests: { id: string; path: string }[]; pending: number }
const files = () => page!.getByRole('complementary', { name: 'Remote files', exact: true })
const editor = () => page!.getByRole('dialog', { name: 'Remote file editor', exact: true })
async function probe() { return app!.evaluate(() => structuredClone((globalThis as unknown as { loadProbe: Probe }).loadProbe)) }
async function settled() {
  await page!.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect.poll(async () => (await probe()).pending).toBe(0)
}
async function reset() { await settled(); await app!.evaluate(() => { (globalThis as unknown as { loadProbe: Probe }).loadProbe.requests = [] }) }
async function save(suffix: string) {
  const content = editor().getByRole('textbox', { name: 'Remote file contents', exact: true })
  await content.focus(); await page!.keyboard.press('Control+End'); await page!.keyboard.insertText(suffix)
  await editor().getByRole('button', { name: 'Save remote file', exact: true }).click()
  await page!.getByRole('dialog', { name: 'Review file changes', exact: true }).getByRole('button', { name: 'Confirm save to server', exact: true }).click()
  await expect(editor().getByRole('status')).toContainText('Saved to server')
  await settled()
}
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE; env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${directory}`], env })
  page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  await page.evaluate(async (servers) => {
    await window.sshHeaven.setupVaultPin('83926')
    const ids: string[] = []
    for (let index = 0; index < 12; index++) {
      const server = servers[index % servers.length], id = `load-host-${index}`
      await window.sshHeaven.saveProfile({ id, name: `Load host ${String(index + 1).padStart(2, '0')}`, host: server.host, port: server.port, username: server.username, authType: 'password' })
      await window.sshHeaven.saveVaultPassword(id, server.password)
      ids.push(id)
    }
    await window.sshHeaven.saveLibraryItem('workspace', { id: 'load-workspace', name: 'Twelve server workspace', profileIds: ids, layout: 'tabs' })
    await window.sshHeaven.lockVault()
  }, fixtures.map(({ host, port, username, password }) => ({ host, port, username, password })))
  await page.reload()
  await expect(page.locator('.sidebar .host-row-item')).toHaveCount(12)
  await app.evaluate(({ ipcMain }, channel) => {
    const target = globalThis as unknown as { loadProbe: Probe }
    target.loadProbe = { requests: [], pending: 0 }
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, id: string, path: string) => Promise<unknown>> })._invokeHandlers
    const original = handlers.get(channel)!
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, id: string, path: string) => {
      target.loadProbe.requests.push({ id, path }); target.loadProbe.pending++
      try { return await original(event, id, path) } finally { target.loadProbe.pending-- }
    })
  }, channels.listDirectory)
  await page.getByRole('button', { name: 'Workspaces', exact: true }).click()
  await page.getByRole('button', { name: 'Restore workspace Twelve server workspace', exact: true }).click()
  await page.getByRole('button', { name: 'Connect workspace', exact: true }).click()
  await expect.poll(async () => {
    const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true })
    if (await trust.isVisible()) await trust.click()
    return await page!.getByRole('status', { name: 'SSH session summary', exact: true }).innerText()
  }, { timeout: 30_000 }).toBe('12 online')
  await expect(files().getByRole('listbox', { name: 'Directory contents', exact: true })).toHaveAttribute('aria-busy', 'false')
  await settled()
  const initialRequests = (await probe()).requests.length
  const firstId = await page.locator('.session-workspace.is-active-pane').getAttribute('data-session-id')
  await files().getByText('welcome.txt', { exact: true }).dblclick()
  await expect(editor().getByRole('textbox', { name: 'Remote file contents', exact: true })).toContainText('Welcome')
  await reset(); await save('\nvisible-save-marker\n')
  const savedRequests = (await probe()).requests
  await editor().getByRole('button', { name: 'Back to files', exact: true }).click()
  await page.getByRole('button', { name: 'Toggle remote files', exact: true }).click()
  await page.getByRole('button', { name: 'Open editor', exact: true }).click()
  await reset(); await save('hidden-save-marker\n')
  const hiddenRequests = (await probe()).requests.length
  await editor().getByRole('button', { name: 'Back to files', exact: true }).click()
  await page.getByRole('button', { name: 'Toggle remote files', exact: true }).click()
  await expect(files().getByRole('listbox', { name: 'Directory contents', exact: true })).toHaveAttribute('aria-busy', 'false')
  await settled()
  const revealedRequests = (await probe()).requests.length
  const contents = await readFile(path.join(fixtures[0].root, 'welcome.txt'), 'utf8')
  assert.ok(contents.includes('visible-save-marker') && contents.includes('hidden-save-marker'))
  console.log(`Many-session SFTP metrics: 12 connected servers; initial listings=${initialRequests}; visible-save listings=${savedRequests.length}; hidden-save listings=${hiddenRequests}; after reveal=${revealedRequests}`)
  assert.equal(initialRequests, 1, 'A background workspace must list only the visible server')
  assert.equal(savedRequests.length, 1, 'Saving one document must refresh only its own visible file browser')
  assert.equal(savedRequests[0].id, firstId)
  assert.equal(hiddenRequests, 0, 'Hidden file browsers must defer save-triggered reloads')
  assert.equal(revealedRequests, 1, 'Revealing a dirty file browser must refresh it exactly once')
  await page.getByRole('button', { name: 'Stream mode', exact: true }).click()
  const ids = await page.locator('.session-workspace').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-session-id')!))
  await page.evaluate((sessions) => { for (const [index, id] of sessions.entries()) window.sshHeaven.write(id, `echo load-output-${index} 192.0.2.51\r`) }, ids)
  await page.getByRole('button', { name: 'All sessions', exact: true }).click()
  await page.getByRole('dialog', { name: 'All sessions', exact: true }).getByRole('button', { name: 'Select Load host 12 session', exact: true }).click()
  await expect(page.locator('.session-workspace.is-active-pane .ssh-terminal-host')).toHaveAttribute('data-stream-ready', 'true')
  await expect(page.locator('.session-workspace.is-active-pane .xterm-rows')).toContainText('load-output-11')
  await expect(page.locator('.session-workspace.is-active-pane .xterm-rows')).not.toContainText('192.0.2.51')
  await page.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await expect(page.locator('.session-workspace.is-active-pane .xterm-rows')).toContainText('192.0.2.51')
  assert.deepEqual(errors, [])
  assert.ok((await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })))).every((window) => !window.visible && !window.focused && window.offscreen))
  console.log('Many-session performance E2E passed: deferred background SFTP, targeted document-save reloads, and hidden terminal output/privacy catchup with twelve real SSH sessions.')
} finally { await app?.close(); await Promise.all(fixtures.map((fixture) => fixture.close())); await rm(temporary, { recursive: true, force: true }) }
