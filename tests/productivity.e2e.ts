import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-productivity-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture()
const remotePath = path.join(fixture.root, 'config.json')
await writeFile(remotePath, '\uFEFF{\r\n  "enabled": true,\r\n  "port": 22\r\n}\r\n')
let app: ElectronApplication | undefined
const errors: string[] = []

async function launch(): Promise<Page> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  const page = await app.firstWindow()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  return page
}
async function replaceText(page: Page, editor: Locator, content: string) {
  await editor.getByRole('textbox', { name: 'Remote file contents', exact: true }).focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(content)
  await expect(editor.getByRole('button', { name: 'Save remote file', exact: true })).toBeEnabled()
}
async function connectSaved(page: Page) {
  await page.getByTitle('Connect to Productivity fixture', { exact: true }).click()
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('placeholder', 'Saved password will be used')
  await expect(page.getByRole('checkbox', { name: 'Use saved password', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.locator('.session-workspace:not(.hidden-workspace) .terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
}

try {
  let page = await launch()
  assert.equal((await page.evaluate(() => window.sshHeaven.getCredentialStatus())).available, true, 'Windows must provide OS-backed credential encryption')
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page.getByLabel(/^Nickname/).fill('Productivity fixture')
  await page.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
  await page.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('checkbox', { name: 'Remember password on this device', exact: true }).check()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  const profiles = await page.evaluate(() => window.sshHeaven.listProfiles())
  const profile = profiles.find((item) => item.name === 'Productivity fixture')!
  assert.ok((await page.evaluate(() => window.sshHeaven.getCredentialStatus())).profileIds.includes(profile.id))
  const vaultSource = await readFile(path.join(dataDirectory, 'credentials.json'), 'utf8')
  assert.ok(!vaultSource.includes(fixture.password), 'The credential file must not contain a plaintext password')
  assert.ok(!JSON.stringify(profiles).includes(fixture.password), 'Renderer host metadata must not contain passwords')
  await app!.close(); app = undefined

  // A saved password survives an actual app restart and authenticates with an empty UI field.
  page = await launch()
  await connectSaved(page)
  const files = page.getByRole('complementary', { name: 'Remote files', exact: true })
  await expect(files.locator('.file-list').getByText('config.json', { exact: true })).toBeVisible()
  await files.locator('.file-list').getByText('config.json', { exact: true }).dblclick()
  const editor = page.getByRole('dialog', { name: 'Remote file editor', exact: true })
  await expect(editor.getByRole('textbox', { name: 'Remote file contents', exact: true })).toContainText('"enabled"')
  await expect(editor.getByLabel('Editor language', { exact: true })).toHaveValue('json')
  await expect.poll(() => editor.locator('.cm-line span').count()).toBeGreaterThan(0)
  await editor.getByRole('button', { name: 'Find and replace', exact: true }).click()
  await expect(editor.locator('.cm-search')).toBeVisible()
  await editor.getByRole('textbox', { name: 'Remote file contents', exact: true }).press('Escape')
  await expect(editor).toBeVisible()
  const revised = '{\n  "enabled": false,\n  "port": 2222\n}\n'
  await replaceText(page, editor, revised)
  await editor.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const discard = page.getByRole('dialog', { name: 'Discard unsaved changes?', exact: true })
  await expect(discard).toBeVisible()
  await discard.getByRole('button', { name: 'Keep editing', exact: true }).click()
  await editor.getByRole('textbox', { name: 'Remote file contents', exact: true }).focus()
  await page.keyboard.press('Control+s')
  await page.getByRole('dialog', { name: 'Review file changes', exact: true }).getByRole('button', { name: 'Confirm save to server', exact: true }).click()
  await expect(editor.getByRole('status')).toContainText('Saved to server')
  assert.equal(await readFile(remotePath, 'utf8'), `\uFEFF${revised.replace(/\n/g, '\r\n')}`)
  await page.screenshot({ path: path.join(root, 'test-results', 'remote-editor.png') })

  await replaceText(page, editor, '{"local":true}\n')
  await writeFile(remotePath, '{"external":true}\n')
  await editor.getByRole('button', { name: 'Save remote file', exact: true }).click()
  await page.getByRole('dialog', { name: 'Review file changes', exact: true }).getByRole('button', { name: 'Confirm save to server', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('changed')
  await expect(editor.getByRole('textbox', { name: 'Remote file contents', exact: true })).toContainText('"local"')
  assert.equal(await readFile(remotePath, 'utf8'), '{"external":true}\n', 'Conflicts must not overwrite server changes')
  await editor.getByRole('button', { name: 'Reload remote file', exact: true }).click()
  await page.getByRole('button', { name: 'Discard and reload', exact: true }).click()
  await expect(editor.getByRole('textbox', { name: 'Remote file contents', exact: true })).toContainText('"external"')
  await editor.getByRole('button', { name: 'Close dialog', exact: true }).click()

  await page.getByTitle('Connect to Productivity fixture', { exact: true }).click()
  await page.getByLabel('Username', { exact: true }).fill('different-user')
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('different-user')
  await expect(page.getByRole('checkbox', { name: 'Use saved password', exact: true })).toHaveCount(0)
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await expect(page.getByRole('checkbox', { name: 'Use saved password', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Forget saved password', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'Use saved password', exact: true })).toHaveCount(0)
  assert.ok(!(await page.evaluate(() => window.sshHeaven.getCredentialStatus())).profileIds.includes(profile.id))
  assert.ok(!JSON.parse(await readFile(path.join(dataDirectory, 'credentials.json'), 'utf8')).entries[profile.id])
  assert.deepEqual(errors, [], errors.join('\n'))
  console.log('Productivity E2E passed: Windows encrypted password storage/restart/reuse/forget, binding-aware UI, syntax-highlighted SFTP editor, find/replace, guarded close, Ctrl+S, BOM/CRLF preservation, conflict protection and reload.')
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => undefined)
    await page?.screenshot({ path: path.join(root, 'test-results', 'productivity-failure.png') }).catch(() => {})
    if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 7000))
  }
  throw error
} finally {
  await app?.close()
  await fixture.close()
  await rm(temporary, { recursive: true, force: true })
}
