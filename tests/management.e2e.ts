import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { startFixture } from './fixture'
import type { GroupCommandEvent } from '../shared/types'
import { GITHUB_LATEST_API, installUpdateFixture, updateProbe } from './update-fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-management-e2e-'))
const sourceData = path.join(temporary, 'source'), targetData = path.join(temporary, 'restored')
const backupPath = path.join(temporary, 'workspace.sshbackup')
const backupPassword = 'management portable backup passphrase'
await mkdir(sourceData); await mkdir(targetData)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture({ privateKeyAuth: true })
const rendererErrors: string[] = []
let app: ElectronApplication | undefined

async function launch(directory: string): Promise<Page> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${directory}`], env, timeout: 30_000 })
  await installUpdateFixture(app)
  const page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await expect(page.getByRole('button', { name: 'Manage workspace', exact: true })).toBeVisible()
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), false)
  await page.evaluate(() => {
    const target = window as unknown as { managementEvents: GroupCommandEvent[] }
    target.managementEvents = []
    window.sshHeaven.onGroupCommand((event) => target.managementEvents.push(event))
  })
  return page
}
async function management(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Manage workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Workspace library', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
async function runSavedRunbook(page: Page, dialog: Locator, marker: string, trust: boolean) {
  await dialog.getByRole('button', { name: 'Runbooks', exact: true }).click()
  await dialog.getByRole('button', { name: 'Use runbook', exact: true }).click()
  await dialog.getByLabel('Runbook variable message', { exact: true }).fill(marker)
  await dialog.getByRole('button', { name: 'Continue to target review', exact: true }).click()
  const runner = page.getByRole('dialog', { name: 'Run group command', exact: true })
  await expect(runner.getByLabel('Group command', { exact: true })).toHaveValue(`echo '${marker}'`)
  const before = await page.evaluate(() => (window as unknown as { managementEvents: GroupCommandEvent[] }).managementEvents.length)
  await runner.getByRole('button', { name: 'Review command', exact: true }).click()
  await expect(runner.getByLabel('Command to execute', { exact: true })).toHaveText(`echo '${marker}'`)
  assert.equal(await page.evaluate(() => (window as unknown as { managementEvents: GroupCommandEvent[] }).managementEvents.length), before)
  await runner.getByRole('button', { name: 'Run on 1 server', exact: true }).click()
  if (trust) {
    await expect(page.getByRole('dialog', { name: 'Verify server identity', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  }
  await expect(runner.locator('.group-server-result[data-status="completed"]')).toHaveCount(1)
  await expect(runner.locator('pre')).toContainText(marker)
  await expect(runner.getByText('Exit 0', { exact: true })).toBeVisible()
  await runner.getByRole('button', { name: 'Done', exact: true }).click()
}

try {
  let page = await launch(sourceData)
  const keyPath = fixture.privateKeyPath!
  await app!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filename] })) as typeof dialog.showOpenDialog }, keyPath)

  // Import one real password host so the runbook and portable vault are tested.
  await page.getByRole('button', { name: 'Bulk import hosts', exact: true }).click()
  const importer = page.getByRole('dialog', { name: 'Bulk import hosts', exact: true })
  await importer.getByLabel('Port', { exact: true }).fill(String(fixture.port))
  await importer.getByLabel(/^Group/).fill('Management QA')
  await importer.getByLabel('Hosts to import', { exact: true }).fill(`${fixture.host}:${fixture.username}:${fixture.password}`)
  await importer.getByRole('button', { name: 'Preview import', exact: true }).click()
  await importer.getByRole('button', { name: 'Import 1 host', exact: true }).click()
  await expect(importer.getByRole('heading', { name: '1 host imported', exact: true })).toBeVisible()
  await importer.getByRole('button', { name: 'Done', exact: true }).click()

  let dialog = await management(page)
  await dialog.getByRole('button', { name: 'SSH keys', exact: true }).click()
  await dialog.getByLabel('Key name', { exact: true }).fill('Fixture deployment key')
  await dialog.getByRole('button', { name: 'Browse', exact: true }).click()
  await dialog.getByRole('button', { name: 'Save key', exact: true }).click()
  await expect(dialog.getByText('Fixture deployment key', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Available', { exact: true })).toBeVisible()
  const savedKey = (await page.evaluate(() => window.sshHeaven.getLibrary())).keys[0]
  await dialog.getByRole('button', { name: 'Group defaults', exact: true }).click()
  await dialog.getByLabel('Group name', { exact: true }).fill('Management QA')
  await dialog.getByLabel('Default username', { exact: true }).fill(fixture.username)
  await dialog.getByLabel('Default SSH port', { exact: true }).fill(String(fixture.port))
  await dialog.getByLabel('Default SSH key', { exact: true }).selectOption(savedKey.id)
  await dialog.getByRole('button', { name: 'Save group defaults', exact: true }).click()
  await expect(dialog.getByText(`${fixture.username} · port ${fixture.port} · Fixture deployment key`, { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click()

  await page.getByRole('button', { name: 'Bulk import hosts', exact: true }).click()
  await importer.getByLabel(/^Group/).fill('Management QA')
  await importer.getByLabel('Hosts to import', { exact: true }).fill('192.0.2.20:admin')
  await importer.getByRole('button', { name: 'Apply group defaults', exact: true }).click()
  await expect(importer.getByLabel('Port', { exact: true })).toHaveValue(String(fixture.port))
  await expect(importer.getByRole('button', { name: 'One SSH key for all', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(importer.getByTitle(keyPath, { exact: true })).toBeVisible()
  await expect(importer.getByLabel('Hosts to import', { exact: true })).toHaveValue('192.0.2.20:admin')
  await importer.getByRole('button', { name: 'Cancel', exact: true }).click()

  dialog = await management(page)
  await dialog.getByLabel('Runbook name', { exact: true }).fill('Fleet message')
  await dialog.getByLabel(/^Default group/).fill('Management QA')
  await dialog.getByLabel('Runbook command', { exact: true }).fill('echo {{message}}')
  await dialog.getByRole('button', { name: 'Save runbook', exact: true }).click()
  await expect(dialog.getByText('Fleet message', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(root, 'test-results', 'management-library.png') })
  await runSavedRunbook(page, dialog, 'management-e2e-marker', true)

  await page.evaluate(() => { localStorage.setItem('ssh-heaven:theme', 'pink'); localStorage.setItem('ssh-heaven:terminal-font-size', '16'); localStorage.setItem('ssh-heaven-files-width', '520') })
  dialog = await management(page)
  await dialog.getByRole('button', { name: 'Backup & restore', exact: true }).click()
  await dialog.getByLabel('Backup passphrase', { exact: true }).fill(backupPassword)
  await dialog.getByLabel('Confirm backup passphrase', { exact: true }).fill(backupPassword)
  await dialog.getByLabel('Include remembered server passwords', { exact: true }).check()
  await dialog.getByLabel('Include private key files', { exact: true }).check()
  await app!.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: filename })) as typeof dialog.showSaveDialog }, backupPath)
  await dialog.getByRole('button', { name: 'Choose location & export', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Encrypted backup saved (1 hosts, 1 private keys).')
  const encrypted = await readFile(backupPath)
  assert.equal(encrypted.includes(Buffer.from(fixture.password)), false)
  assert.equal(encrypted.includes(Buffer.from('BEGIN RSA PRIVATE KEY')), false)
  assert.equal(encrypted.includes(Buffer.from('Management QA')), false)
  await app!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filename] })) as typeof dialog.showOpenDialog }, backupPath)
  await dialog.getByLabel('Restore passphrase', { exact: true }).fill(backupPassword)
  await dialog.getByRole('button', { name: 'Choose backup & preview', exact: true }).click()
  await expect(dialog.getByText('0 new hosts · 1 existing hosts skipped', { exact: true })).toBeVisible()
  assert.equal((await page.evaluate(() => window.sshHeaven.listProfiles())).length, 1)
  await dialog.getByRole('button', { name: 'Merge backup', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Restored 0 hosts and 0 keys.')
  assert.equal((await page.evaluate(() => window.sshHeaven.getLibrary())).keys.length, 1, 'Restoring into the source workspace must not duplicate its existing key')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'pink')
  await app!.close(); app = undefined

  // A different app data directory forces re-encryption into a fresh vault and
  // private-key restoration into an app-managed path, without exposing bytes to UI.
  page = await launch(targetData)
  await app!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filename] })) as typeof dialog.showOpenDialog }, backupPath)
  dialog = await management(page)
  await dialog.getByRole('button', { name: 'Backup & restore', exact: true }).click()
  await dialog.getByLabel('Restore passphrase', { exact: true }).fill(backupPassword)
  await dialog.getByRole('button', { name: 'Choose backup & preview', exact: true }).click()
  await expect(dialog.getByText('1 new hosts · 0 existing hosts skipped', { exact: true })).toBeVisible()
  assert.deepEqual(await page.evaluate(() => window.sshHeaven.listProfiles()), [])
  await assert.rejects(readdir(path.join(targetData, 'backup-keys')), { code: 'ENOENT' })
  await page.screenshot({ path: path.join(root, 'test-results', 'management-backup-preview.png') })
  await dialog.getByRole('button', { name: 'Merge backup', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Restored 1 hosts and 1 keys.')
  const restoredProfiles = await page.evaluate(() => window.sshHeaven.listProfiles())
  const restoredLibrary = await page.evaluate(() => window.sshHeaven.getLibrary())
  assert.equal(restoredProfiles.length, 1); assert.equal(restoredLibrary.keys.length, 1)
  assert.equal(path.dirname(restoredLibrary.keys[0].path), path.join(targetData, 'backup-keys'))
  assert.deepEqual(await readFile(restoredLibrary.keys[0].path), await readFile(keyPath))
  assert.equal(restoredLibrary.keys[0].available, true)
  assert.deepEqual((await page.evaluate(() => window.sshHeaven.getCredentialStatus())).profileIds, [restoredProfiles[0].id])
  assert.equal((await readFile(path.join(targetData, 'credentials.json'), 'utf8')).includes(fixture.password), false)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'pink')
  assert.equal(await page.evaluate(() => localStorage.getItem('ssh-heaven:terminal-font-size')), '16')
  await dialog.getByRole('button', { name: 'SSH keys', exact: true }).click()
  await expect(dialog.getByText('Available', { exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(root, 'test-results', 'management-restored.png') })
  await runSavedRunbook(page, dialog, 'restored-vault-e2e-marker', false)
  dialog = await management(page)
  await dialog.getByRole('button', { name: 'Updates', exact: true }).click()
  const updateFixture = await updateProbe(app!)
  if (updateFixture.packaged) {
    await dialog.getByRole('button', { name: 'Check for updates', exact: true }).click()
    await expect(dialog.locator('.management-update-message')).toContainText('No newer stable release is available')
    assert.equal((await page.evaluate(() => window.sshHeaven.getUpdateState())).status, 'not-available')
    assert.ok((await updateProbe(app!)).requests.every((request) => request.url === GITHUB_LATEST_API))
    assert.deepEqual((await updateProbe(app!)).opened, [])
  } else {
    assert.equal((await page.evaluate(() => window.sshHeaven.getUpdateState())).status, 'unconfigured')
    await expect(dialog.getByText(/Release hosting has not been configured/)).toBeVisible()
    assert.deepEqual(updateFixture.requests, [])
  }
  await expect(dialog.getByRole('button', { name: /Install|Download update|Restart/i })).toHaveCount(0)
  assert.deepEqual(rendererErrors, [], `Renderer errors: ${rendererErrors.join(', ')}`)
  console.log('Management E2E passed: named keys, group defaults and explicit bulk application, quoted runbook execution, encrypted portable backup and merge, restored vault/key files/preferences, and deterministic manual-only update UI in packaged/dev builds.')
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => undefined)
    await page?.screenshot({ path: path.join(root, 'test-results', 'management-failure.png') }).catch(() => {})
    if (page) console.error((await page.locator('body').innerText().catch(() => '')).replaceAll(fixture.password, '[REDACTED]').replaceAll(backupPassword, '[REDACTED]').slice(0, 6500))
  }
  throw error
} finally {
  await app?.close(); await fixture.close()
  // temporary is the absolute path returned by mkdtemp above.
  await rm(temporary, { recursive: true, force: true })
}
