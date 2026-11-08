import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-file-workflow-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory); await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixtures = await Promise.all([startFixture(), startFixture()])
const original = '{\n  "enabled": true,\n  "address": "192.0.2.10",\n  "domain": "workflow-secret.example"\n}\n'
const revised = original.replace('true', 'false')
await writeFile(path.join(fixtures[0].root, 'documents', 'alpha.json'), original)
await writeFile(path.join(fixtures[0].root, 'documents', 'beta.yaml'), 'name: beta\n')
let app: ElectronApplication | undefined
let page: Page | undefined
const errors: string[] = []
const files = () => page!.getByRole('complementary', { name: 'Remote files', exact: true })
const editor = () => page!.getByRole('dialog', { name: 'Remote file editor', exact: true })
const activeDocument = () => editor().getByRole('tabpanel')
const contents = () => activeDocument().getByRole('textbox', { name: 'Remote file contents', exact: true })
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE; env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.on('pageerror', (cause) => errors.push(cause.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  await assertHidden()
}
async function assertHidden() {
  const windows = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })))
  assert.ok(windows.length > 0 && windows.every((window) => !window.visible && !window.focused && window.offscreen))
}
async function connect(name: string) {
  await page!.locator('.sidebar').getByRole('button', { name: `Quick connect ${name}`, exact: true }).click()
  await expect.poll(async () => {
    const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true })
    if (await trust.isVisible()) await trust.click()
    return page!.getByRole('region', { name: `${name} session`, exact: true }).locator('.terminal-footer').getByText('Connected', { exact: true }).count()
  }, { timeout: 20_000 }).toBe(1)
}
async function go(directory: string) {
  await files().getByLabel('Remote path', { exact: true }).fill(directory)
  await files().getByLabel('Remote path', { exact: true }).press('Enter')
  await expect(files().getByLabel('Remote path', { exact: true })).toHaveValue(directory)
  await expect(files().getByRole('listbox', { name: 'Directory contents', exact: true })).toHaveAttribute('aria-busy', 'false')
}
async function changeText(text: string) { await contents().focus(); await page!.keyboard.press('Control+a'); await page!.keyboard.insertText(text) }
async function reviewSave() { await activeDocument().getByRole('button', { name: 'Save remote file', exact: true }).click(); return page!.getByRole('dialog', { name: 'Review file changes', exact: true }) }
async function openPath(filename: string) {
  await editor().getByRole('button', { name: 'Open remote file path', exact: true }).click()
  const dialog = page!.getByRole('dialog', { name: 'Open remote file', exact: true })
  await dialog.getByLabel('Remote file path', { exact: true }).fill(filename)
  await dialog.getByRole('button', { name: 'Open file', exact: true }).click()
}

try {
  await launch()
  const profiles = await page!.evaluate(async (hosts) => {
    const saved = []
    for (const [index, host] of hosts.entries()) {
      await window.sshHeaven.importHosts({ text: `${host.host}:${host.username}:${host.password}`, port: host.port, authType: 'password' })
      const profile = (await window.sshHeaven.listProfiles()).find((item) => item.port === host.port)!
      saved.push(await window.sshHeaven.saveProfile({ ...profile, name: index ? 'File workflow Beta' : 'File workflow Alpha' }))
    }
    return saved
  }, fixtures.map(({ host, port, username, password }) => ({ host, port, username, password })))
  await page!.reload(); await connect('File workflow Alpha')
  await files().getByText('documents', { exact: true }).dblclick()
  await expect(files().getByLabel('Remote path', { exact: true })).toHaveValue('/documents')
  await files().getByRole('button', { name: 'Manage folder bookmarks', exact: true }).click()
  const bookmarks = page!.getByRole('dialog', { name: 'Remote folder bookmarks', exact: true })
  await bookmarks.getByLabel('Bookmark name', { exact: true }).fill('Project files')
  await page!.screenshot({ path: path.join(root, 'test-results', 'remote-folder-bookmarks.png') })
  await bookmarks.getByRole('button', { name: 'Save folder bookmark', exact: true }).click()
  await go('/')
  await files().getByLabel('Saved remote folders', { exact: true }).selectOption('/documents')
  await expect(files().getByLabel('Remote path', { exact: true })).toHaveValue('/documents')
  await files().getByText('alpha.json', { exact: true }).dblclick()
  await expect(contents()).toContainText('"enabled": true')
  const alphaNode = await activeDocument().locator('.cm-editor').elementHandle()
  await changeText(revised)
  await expect(editor().getByRole('tab', { name: /alpha.json.*unsaved changes/ })).toBeVisible()
  await editor().getByRole('button', { name: 'Back to files', exact: true }).click()
  await expect(page!.getByRole('dialog')).toHaveCount(0)
  assert.equal(await alphaNode!.evaluate((node) => node.isConnected), true, 'Hiding the editor retains its CodeMirror instance and draft')
  await files().getByText('beta.yaml', { exact: true }).dblclick()
  await expect(editor().getByRole('tablist', { name: 'Open remote files', exact: true }).getByRole('tab')).toHaveCount(2)
  await expect(contents()).toContainText('name: beta')
  await editor().getByRole('button', { name: 'Close alpha.json on File workflow Alpha', exact: true }).click()
  await expect(page!.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })).toBeVisible()
  await expect(editor().getByRole('tab', { name: /alpha.json on File workflow Alpha/ })).toHaveAttribute('aria-selected', 'true')
  await page!.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await expect(contents()).toContainText('"enabled": false')
  await editor().getByRole('tab', { name: /beta.yaml on File workflow Alpha/ }).click()
  const inactiveAlpha = editor().getByRole('tab', { name: /alpha.json on File workflow Alpha/ })
  await inactiveAlpha.focus(); await inactiveAlpha.press('Delete')
  await expect(page!.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })).toBeVisible()
  await expect(inactiveAlpha).toHaveAttribute('aria-selected', 'true')
  await page!.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await editor().getByRole('tab', { name: /alpha.json on File workflow Alpha/ }).click()
  await expect(contents()).toContainText('"enabled": false')
  await openPath('/documents/alpha.json')
  await expect(editor().getByRole('tablist', { name: 'Open remote files', exact: true }).getByRole('tab')).toHaveCount(2)

  let review = await reviewSave()
  await expect(review.getByRole('region', { name: 'File changes', exact: true })).toContainText('"enabled": false')
  await expect(review.locator('.diff-line.diff-removed')).toContainText('"enabled": true')
  assert.equal(await readFile(path.join(fixtures[0].root, 'documents', 'alpha.json'), 'utf8'), original, 'Opening a diff must not save')
  await page!.screenshot({ path: path.join(root, 'test-results', 'file-editor-review.png') })
  await review.getByRole('button', { name: 'Keep editing', exact: true }).click()
  // Enable Stream mode through the same DOM button while the modal traps focus.
  await page!.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Stream mode"]')!.click())
  await page!.evaluate(() => {
    localStorage.setItem('ssh-heaven:stream-rules', JSON.stringify([{ text: 'workflow-secret.example', caseSensitive: false }]))
    window.dispatchEvent(new StorageEvent('storage', { key: 'ssh-heaven:stream-rules' }))
  })
  await expect(activeDocument().locator('.cm-content')).not.toContainText('192.0.2.10')
  await expect(activeDocument().locator('.cm-content')).not.toContainText('workflow-secret.example')
  review = await reviewSave()
  await expect(review.getByRole('region', { name: 'File changes', exact: true })).not.toContainText('192.0.2.10')
  await expect(review.getByRole('region', { name: 'File changes', exact: true })).not.toContainText('workflow-secret.example')
  await review.getByRole('button', { name: 'Confirm save to server', exact: true }).click()
  await expect(activeDocument().getByRole('status')).toContainText('Saved to server')
  assert.equal(await readFile(path.join(fixtures[0].root, 'documents', 'alpha.json'), 'utf8'), revised, 'Display masking must never alter transmitted content')
  await page!.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Stream mode"]')!.click())
  await changeText('{"local":"draft-survives-conflict"}\n')
  await writeFile(path.join(fixtures[0].root, 'documents', 'alpha.json'), '{"external":"another writer"}\n')
  review = await reviewSave()
  await review.getByRole('button', { name: 'Confirm save to server', exact: true }).click()
  await expect(activeDocument().getByRole('alert')).toContainText('changed')
  await expect(contents()).toContainText('draft-survives-conflict')
  await activeDocument().getByRole('button', { name: 'Reload remote file', exact: true }).click()
  await page!.getByRole('button', { name: 'Discard and reload', exact: true }).click()
  await expect(contents()).toContainText('another writer')
  await editor().getByRole('tab', { name: /beta.yaml on File workflow Alpha/ }).click()
  await changeText('name: unpersisted-draft-marker\n')
  await editor().getByRole('button', { name: 'Back to files', exact: true }).click()

  await connect('File workflow Beta')
  await expect(files().getByLabel('Remote path', { exact: true })).toHaveValue('/')
  await expect(files().getByLabel('Saved remote folders', { exact: true })).toBeDisabled()
  await files().getByText('welcome.txt', { exact: true }).dblclick()
  await expect(editor().getByRole('tablist', { name: 'Open remote files', exact: true }).getByRole('tab')).toHaveCount(3)
  await expect(editor().getByRole('tab', { name: /welcome.txt on File workflow Beta/ })).toBeVisible()
  await editor().getByRole('tab', { name: /beta.yaml on File workflow Alpha/ }).click()
  await expect(contents()).toContainText('unpersisted-draft-marker')
  await page!.screenshot({ path: path.join(root, 'test-results', 'file-editor-tabs.png') })
  await editor().getByRole('button', { name: 'Close dialog', exact: true }).click()
  await expect(page!.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })).toBeVisible()
  await page!.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await editor().getByRole('button', { name: 'Back to files', exact: true }).click()
  for (const name of ['File workflow Alpha', 'File workflow Beta']) {
    await page!.getByRole('button', { name: `Close ${name} session`, exact: true }).click()
    await page!.getByRole('dialog', { name: 'Close this session?', exact: true }).getByRole('button', { name: 'Disconnect & close', exact: true }).click()
  }
  await expect(page!.getByRole('tablist', { name: 'Connection sessions', exact: true })).toHaveCount(0)
  await expect(page!.locator('.session-workspace')).toHaveCount(0)
  // Draft recovery must work from the global workspace with no SSH session.
  // Reconnecting merely to reach a retained editor would strand unsaved work.
  await page!.getByRole('button', { name: 'Open editor', exact: true }).click()
  await expect(contents()).toContainText('unpersisted-draft-marker')
  await expect(editor().getByRole('tablist', { name: 'Open remote files', exact: true }).getByRole('tab')).toHaveCount(3)
  await expect(page!.locator('.session-workspace')).toHaveCount(0)
  await page!.screenshot({ path: path.join(root, 'test-results', 'file-editor-offline-draft.png') })
  await editor().getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page!.getByRole('button', { name: 'Discard and close', exact: true }).click()
  assert.equal(await readFile(path.join(fixtures[0].root, 'documents', 'beta.yaml'), 'utf8'), 'name: beta\n')
  await connect('File workflow Alpha')
  await expect(files().getByLabel('Remote path', { exact: true })).toHaveValue('/documents')
  await files().getByRole('listbox', { name: 'Directory contents', exact: true }).getByRole('option').filter({ hasText: 'alpha.json' }).click()
  await files().getByRole('button', { name: 'File properties', exact: true }).click()
  const properties = page!.getByRole('dialog', { name: 'File properties', exact: true })
  await expect(properties.getByText('Modified', { exact: true })).toBeVisible()
  await expect(properties.getByRole('term').filter({ hasText: /^Owner$/ })).toBeVisible()
  await properties.getByLabel('Octal permissions', { exact: true }).fill('755')
  await expect(properties.getByLabel('Owner execute permission', { exact: true })).toBeChecked()
  await properties.getByLabel('Group write permission', { exact: true }).check()
  await expect(properties.getByLabel('Octal permissions', { exact: true })).toHaveValue('775')
  await properties.getByRole('button', { name: 'Save file permissions', exact: true }).click()
  await expect(properties.getByRole('status')).toContainText('Permissions saved')
  await properties.getByLabel('Octal permissions', { exact: true }).fill('644')
  await writeFile(path.join(fixtures[0].root, 'documents', 'alpha.json'), '{"external":"new size triggers properties conflict"}\n')
  await properties.getByRole('button', { name: 'Save file permissions', exact: true }).click()
  await expect(properties.getByRole('alert')).toContainText('changed')
  await expect(properties.getByLabel('Octal permissions', { exact: true })).toHaveValue('644')
  await properties.getByRole('button', { name: 'Reload file properties', exact: true }).click()
  await expect(properties.getByLabel('Octal permissions', { exact: true })).toHaveValue('775')
  await page!.screenshot({ path: path.join(root, 'test-results', 'file-properties.png') })
  await properties.getByRole('button', { name: 'Done', exact: true }).click()
  const stored = await page!.evaluate(() => localStorage.getItem('ssh-heaven:remote-folders:v1'))
  assert.ok(stored?.includes('/documents') && !stored.includes('unpersisted-draft-marker') && !stored.includes(fixtures[0].password))
  assert.equal(JSON.parse(stored!)[profiles[0].id].lastFolder, '/documents')
  assert.deepEqual(JSON.parse(stored!)[profiles[1].id].bookmarks, [])
  await app!.close(); app = undefined
  await launch(); await connect('File workflow Alpha')
  await expect(files().getByLabel('Remote path', { exact: true })).toHaveValue('/documents')
  await expect(files().getByLabel('Saved remote folders', { exact: true })).toHaveValue('/documents')
  await app!.close(); app = undefined
  await rename(path.join(fixtures[0].root, 'documents'), path.join(fixtures[0].root, 'moved-documents'))
  await launch(); await connect('File workflow Alpha')
  await expect(files().getByLabel('Remote path', { exact: true })).toHaveValue('/')
  await expect(files().getByRole('status')).toContainText('remembered folder is unavailable')
  await assertHidden(); assert.deepEqual(errors, [])
  console.log('Hidden file workflow passed: per-host bookmarks/last folder and missing-folder fallback, retained multi-host editor tabs/drafts, explicit privacy-aware save diff, conflict/close guards, no draft persistence, and version-checked checkbox/octal permission changes.')
} catch (cause) {
  await page?.screenshot({ path: path.join(root, 'test-results', 'file-workflow-failure.png') }).catch(() => {})
  throw cause
} finally {
  await app?.close(); await Promise.all(fixtures.map((fixture) => fixture.close())); await rm(temporary, { recursive: true, force: true })
}
