import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { channels } from '../electron/channels'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-vault-ui-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture({ privateKeyAuth: true })
const generatedPath = path.join(temporary, 'generated', 'vault_ed25519')
await mkdir(path.dirname(generatedPath))
const pin = '57286', newPin = '93174', replacement = 'temporary-vault-replacement'
let app: ElectronApplication | undefined
let page: Page | undefined
const errors: string[] = []
const vault = () => page!.getByRole('region', { name: 'Vault workspace', exact: true })
async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open vault', exact: true })).toBeVisible()
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false, 'Vault E2E must keep the application hidden')
  await app.evaluate(({ clipboard }) => {
    const target = globalThis as unknown as { vaultTestClipboard: string }
    target.vaultTestClipboard = ''
    clipboard.writeText = async (value) => { target.vaultTestClipboard = value }
    clipboard.readText = async () => target.vaultTestClipboard
  })
}
async function openVault() { await page!.getByRole('button', { name: 'Open vault', exact: true }).click(); await expect(vault()).toBeVisible() }
async function unlock(value = pin) {
  await vault().getByLabel('Vault PIN', { exact: true }).fill(value)
  await vault().getByRole('button', { name: 'Unlock vault', exact: true }).click()
  await expect(vault().getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
  await expect(vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true })).toBeVisible()
}
async function replacePassword(value: string) {
  await vault().getByRole('button', { name: 'Replace password for Vault server', exact: true }).click()
  const dialog = page!.getByRole('dialog', { name: 'Replace saved password?', exact: true })
  await dialog.getByLabel('New server password', { exact: true }).fill(value)
  await dialog.getByLabel('Confirm server password', { exact: true }).fill(value)
  await dialog.getByRole('button', { name: 'Save vault password', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

try {
  await launch()
  const saved = await page!.evaluate(async (host) => {
    await window.sshHeaven.importHosts({ text: `${host.host}:${host.username}:${host.password}`, port: host.port, authType: 'password' })
    const profile = (await window.sshHeaven.listProfiles())[0]
    await window.sshHeaven.saveProfile({ ...profile, name: 'Vault server' })
    await window.sshHeaven.saveProfile({ id: 'vault-empty-password', name: 'No stored password', host: 'offline.example', username: 'demo', port: 22, authType: 'password' })
    return profile
  }, { host: fixture.host, port: fixture.port, username: fixture.username, password: fixture.password })
  await page!.reload(); await openVault()
  await expect(vault().getByRole('button', { name: 'Enable vault', exact: true })).toBeVisible()
  const deniedBeforeSetup = await page!.evaluate(() => window.sshHeaven.getVaultSnapshot().then(() => false, () => true))
  assert.equal(deniedBeforeSetup, true)
  await vault().getByLabel('New vault PIN', { exact: true }).fill(pin)
  await vault().getByLabel('Confirm vault PIN', { exact: true }).fill('11111')
  await vault().getByRole('button', { name: 'Enable vault', exact: true }).click()
  await expect(vault().getByRole('alert')).toContainText('PINs do not match')
  await vault().getByLabel('Confirm vault PIN', { exact: true }).fill(pin)
  await vault().getByRole('button', { name: 'Enable vault', exact: true }).click()
  await expect(vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true })).toBeVisible()
  assert.equal((await page!.evaluate(() => window.sshHeaven.getVaultState())).unlocked, true)
  assert.ok(!(await readFile(path.join(dataDirectory, 'vault-lock.json'), 'utf8')).includes(pin), 'The PIN file must not contain the plaintext PIN')
  await page!.clock.install()
  await vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true }).click()
  const secret = vault().getByLabel('Revealed password for Vault server', { exact: true })
  await expect(secret).toHaveText(fixture.password)
  await page!.clock.fastForward(31_000)
  await expect(secret).toHaveCount(0)
  await vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true }).click()
  await expect(secret).toHaveText(fixture.password)
  await page!.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await expect(secret).toHaveCount(0)
  await expect(vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true })).toBeDisabled()
  await expect(vault()).not.toContainText(fixture.password)
  await page!.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await replacePassword(replacement)
  await vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true }).click()
  await expect(secret).toHaveText(replacement)
  await vault().getByRole('button', { name: 'Copy password for Vault server', exact: true }).click()
  assert.equal(await app!.evaluate(() => (globalThis as unknown as { vaultTestClipboard: string }).vaultTestClipboard), replacement)
  await expect(vault().getByRole('status').filter({ hasText: 'clipboard clears' })).toBeVisible()
  await replacePassword(fixture.password)

  await vault().getByRole('button', { name: 'Set password for No stored password', exact: true }).click()
  let passwordDialog = page!.getByRole('dialog', { name: 'Set saved password', exact: true })
  await passwordDialog.getByLabel('New server password', { exact: true }).fill('stored-from-vault')
  await passwordDialog.getByLabel('Confirm server password', { exact: true }).fill('mismatch')
  await passwordDialog.getByRole('button', { name: 'Save vault password', exact: true }).click()
  await expect(passwordDialog.getByRole('alert')).toContainText('passwords do not match')
  await passwordDialog.getByLabel('Confirm server password', { exact: true }).fill('stored-from-vault')
  await passwordDialog.getByRole('button', { name: 'Save vault password', exact: true }).click()
  await expect(vault().getByRole('button', { name: 'Reveal password for No stored password', exact: true })).toBeVisible()
  await vault().getByRole('button', { name: 'Forget password for No stored password', exact: true }).click()
  const forgetting = page!.getByRole('dialog', { name: 'Forget saved password?', exact: true })
  await forgetting.getByRole('button', { name: 'Keep password', exact: true }).click()
  await vault().getByRole('button', { name: 'Forget password for No stored password', exact: true }).click()
  await forgetting.getByRole('button', { name: 'Confirm forget password', exact: true }).click()
  await expect(vault().getByRole('button', { name: 'Set password for No stored password', exact: true })).toBeVisible()
  assert.ok(!(await readFile(path.join(dataDirectory, 'credentials.json'), 'utf8')).includes(fixture.password))

  await vault().getByRole('button', { name: /^SSH keys/ }).click()
  await app!.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filename] })) as typeof dialog.showOpenDialog }, fixture.privateKeyPath!)
  await vault().getByRole('button', { name: 'Add SSH key', exact: true }).click()
  let keyDialog = page!.getByRole('dialog', { name: 'Add SSH key', exact: true })
  await keyDialog.getByLabel('Vault key name', { exact: true }).fill('Existing vault identity')
  await keyDialog.getByRole('button', { name: 'Browse vault SSH key', exact: true }).click()
  await keyDialog.getByRole('button', { name: 'Save vault key', exact: true }).click()
  await expect(vault().getByRole('button', { name: 'Edit vault key Existing vault identity', exact: true })).toBeVisible()
  assert.ok((await page!.evaluate(() => window.sshHeaven.getLibrary())).keys.some((key) => key.path === fixture.privateKeyPath))
  await app!.evaluate(({ dialog }, filename) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: filename })) as typeof dialog.showSaveDialog }, generatedPath)
  await vault().getByRole('button', { name: 'Generate SSH key', exact: true }).click()
  const generator = page!.getByRole('dialog', { name: 'Generate SSH key', exact: true })
  await generator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
  await generator.getByRole('button', { name: 'Add key to vault', exact: true }).click()
  await expect(generator).toHaveCount(0)
  await expect(vault().getByRole('button', { name: 'Edit vault key vault_ed25519', exact: true })).toBeVisible()
  assert.ok((await stat(generatedPath)).isFile())
  assert.ok(!(await page!.locator('body').innerText()).includes('PRIVATE KEY-----'))
  await vault().getByRole('button', { name: 'Remove vault key Existing vault identity', exact: true }).click()
  const removal = page!.getByRole('dialog', { name: 'Remove SSH key from library?', exact: true })
  await removal.getByRole('button', { name: 'Keep key', exact: true }).click()
  await vault().getByRole('button', { name: 'Remove vault key Existing vault identity', exact: true }).click()
  await removal.getByRole('button', { name: 'Confirm remove vault key', exact: true }).click()
  await expect(vault().getByRole('button', { name: 'Edit vault key Existing vault identity', exact: true })).toHaveCount(0)
  assert.ok((await stat(fixture.privateKeyPath!)).isFile(), 'Removing a saved key must preserve its private file')

  await vault().getByRole('button', { name: 'PIN settings', exact: true }).click()
  await vault().getByRole('button', { name: 'Change vault PIN', exact: true }).click()
  const change = page!.getByRole('dialog', { name: 'Change vault PIN', exact: true })
  await change.getByLabel('Current vault PIN', { exact: true }).fill(pin)
  await change.getByLabel('New vault PIN', { exact: true }).fill(newPin)
  await change.getByLabel('Confirm vault PIN', { exact: true }).fill(newPin)
  await expect(change.getByLabel('Current vault PIN', { exact: true })).toHaveValue(pin)
  await expect(change.getByLabel('New vault PIN', { exact: true })).toHaveValue(newPin)
  await expect(change.getByLabel('Confirm vault PIN', { exact: true })).toHaveValue(newPin)
  await change.getByRole('button', { name: 'Confirm change vault PIN', exact: true }).click()
  await expect(change).toHaveCount(0)
  await vault().getByRole('button', { name: /^Passwords/ }).click()
  await expect(vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true })).toBeVisible()
  // Hold one authorized native response after decryption to simulate delayed
  // IPC delivery. Manual Lock must revoke access and discard the late value.
  await app!.evaluate(({ ipcMain }, channel) => {
    const target = globalThis as unknown as { vaultRevealHeld: boolean; vaultReleaseReveal?: () => void; vaultOriginalReveal?: (event: unknown, id: string) => unknown }
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, id: string) => unknown> })._invokeHandlers
    target.vaultOriginalReveal = handlers.get(channel)!
    target.vaultRevealHeld = false
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, id) => {
      const value = await target.vaultOriginalReveal!(event, id)
      target.vaultRevealHeld = true
      await new Promise<void>((resolve) => { target.vaultReleaseReveal = resolve })
      return value
    })
  }, channels.revealVaultPassword)
  await vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true }).click()
  await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { vaultRevealHeld: boolean }).vaultRevealHeld)).toBe(true)
  await vault().getByRole('button', { name: 'Lock vault', exact: true }).click()
  await expect(vault().getByLabel('Vault PIN', { exact: true })).toBeVisible()
  await app!.evaluate(({ ipcMain }, channel) => {
    const target = globalThis as unknown as { vaultReleaseReveal?: () => void; vaultOriginalReveal?: (event: unknown, id: string) => unknown }
    target.vaultReleaseReveal?.()
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, target.vaultOriginalReveal!)
  }, channels.revealVaultPassword)
  await expect(vault().getByRole('button', { name: 'Unlock vault', exact: true })).toBeEnabled()
  await expect(page!.locator('.vault-secret')).toHaveCount(0)
  await vault().getByLabel('Vault PIN', { exact: true }).fill('12')
  await page!.evaluate(() => window.sshHeaven.lockVault())
  await expect(vault().getByLabel('Vault PIN', { exact: true })).toHaveValue('')
  assert.equal(await app!.evaluate(() => (globalThis as unknown as { vaultTestClipboard: string }).vaultTestClipboard), '')
  const deniedLocked = await page!.evaluate((id) => window.sshHeaven.revealVaultPassword(id).then(() => false, () => true), saved.id)
  assert.equal(deniedLocked, true)
  await vault().getByLabel('Vault PIN', { exact: true }).fill(pin)
  await vault().getByRole('button', { name: 'Unlock vault', exact: true }).click()
  await expect(vault().getByRole('alert')).toContainText('Incorrect vault PIN')
  await expect(vault().getByLabel('Vault PIN', { exact: true })).toHaveValue('')
  // Delay the successful unlock reply after its native grant notification, then
  // revoke it. The stale reply must not reopen the manager after minimize.
  await app!.evaluate(({ ipcMain }, channel) => {
    const target = globalThis as unknown as { vaultUnlockHeld: boolean; vaultReleaseUnlock?: () => void; vaultOriginalUnlock?: (event: unknown, pin: string) => unknown }
    target.vaultOriginalUnlock = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, pin: string) => unknown> })._invokeHandlers.get(channel)!
    target.vaultUnlockHeld = false
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, value) => {
      const result = await target.vaultOriginalUnlock!(event, value)
      target.vaultUnlockHeld = true
      await new Promise<void>((resolve) => { target.vaultReleaseUnlock = resolve })
      return result
    })
  }, channels.unlockVault)
  await vault().getByLabel('Vault PIN', { exact: true }).fill(newPin)
  await vault().getByRole('button', { name: 'Unlock vault', exact: true }).click()
  await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { vaultUnlockHeld: boolean }).vaultUnlockHeld)).toBe(true)
  await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    // Exercise the native minimize binding without showing or focusing a window.
    window.emit('minimize')
    if (window.isVisible()) throw new Error('Background vault test unexpectedly showed a window')
  })
  await expect.poll(async () => (await page!.evaluate(() => window.sshHeaven.getVaultState())).unlocked).toBe(false)
  await app!.evaluate(({ ipcMain, BrowserWindow }, channel) => {
    const target = globalThis as unknown as { vaultReleaseUnlock?: () => void; vaultOriginalUnlock?: (event: unknown, pin: string) => unknown }
    target.vaultReleaseUnlock?.()
    ipcMain.removeHandler(channel); ipcMain.handle(channel, target.vaultOriginalUnlock!)
    if (BrowserWindow.getAllWindows()[0].isVisible()) throw new Error('Background vault test unexpectedly showed a window')
  }, channels.unlockVault)
  await expect(vault().getByRole('button', { name: 'Unlock vault', exact: true })).toBeEnabled()
  await expect(vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true })).toHaveCount(0)
  await unlock(newPin)
  await vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true }).click()
  await expect(secret).toHaveText(fixture.password)
  await page!.getByRole('button', { name: 'Open home', exact: true }).click()
  await expect.poll(async () => (await page!.evaluate(() => window.sshHeaven.getVaultState())).unlocked).toBe(false)
  await expect(page!.locator('.vault-secret')).toHaveCount(0)
  await page!.locator('.sidebar').getByRole('button', { name: 'Quick connect Vault server', exact: true }).click()
  await expect.poll(async () => { const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true }); if (await trust.isVisible()) await trust.click(); return page!.locator('.session-workspace.is-active-pane .terminal-footer').getByText('Connected', { exact: true }).count() }, { timeout: 20_000 }).toBe(1)
  assert.equal((await page!.evaluate(() => window.sshHeaven.getVaultState())).unlocked, false, 'Quick connect must work without unlocking vault management')

  await openVault(); await unlock(newPin)
  await app!.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.emit('minimize')
    if (window.isVisible()) throw new Error('Background vault test unexpectedly showed a window')
  })
  await expect.poll(async () => (await page!.evaluate(() => window.sshHeaven.getVaultState())).unlocked).toBe(false)
  await unlock(newPin)
  await vault().getByRole('button', { name: 'PIN settings', exact: true }).click()
  await vault().getByRole('button', { name: 'Disable vault PIN', exact: true }).click()
  const disable = page!.getByRole('dialog', { name: 'Disable vault PIN?', exact: true })
  await disable.getByLabel('Current vault PIN', { exact: true }).fill(newPin)
  await disable.getByRole('button', { name: 'Confirm disable vault PIN', exact: true }).click()
  await expect(vault().getByRole('button', { name: 'Enable vault', exact: true })).toBeVisible()
  assert.equal((await page!.evaluate(() => window.sshHeaven.getCredentialStatus())).profileIds.includes(saved.id), true)
  await vault().getByLabel('New vault PIN', { exact: true }).fill(pin)
  await vault().getByLabel('Confirm vault PIN', { exact: true }).fill(pin)
  await vault().getByRole('button', { name: 'Enable vault', exact: true }).click()
  await expect(vault().getByRole('button', { name: 'Lock vault', exact: true })).toBeVisible()
  await app!.close(); app = undefined
  await launch(); await openVault()
  await expect(vault().getByRole('button', { name: 'Unlock vault', exact: true })).toBeVisible()
  assert.equal((await page!.evaluate(() => window.sshHeaven.getVaultState())).unlocked, false)
  await unlock(pin)
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 680))
  await vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true }).scrollIntoViewIfNeeded()
  await expect(vault().getByRole('button', { name: 'Reveal password for Vault server', exact: true })).toBeInViewport()
  await page!.screenshot({ path: path.join(root, 'test-results', 'vault-workspace.png') })
  assert.equal(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  assert.deepEqual(errors, [])
  console.log('Background Vault E2E passed: five-digit PIN setup/change/disable, native denial and delayed-response guards, auto-hiding reveal/native copy, Stream privacy, password/key management, lock on leave/native minimize lifecycle event/restart, and Quick connect while locked. The window stayed hidden; physical minimize/focus was not exercised.')
} catch (error) {
  if (page && app) await page.screenshot({ path: path.join(root, 'test-results', 'vault-failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.close(); await fixture.close(); await rm(temporary, { recursive: true, force: true })
}
