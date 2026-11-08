import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import ssh2 from 'ssh2'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-workspace-e2e-'))
const dataDirectory = path.join(temporary, 'settings')
const passphrase = 'workspace-e2e-encrypted-key-7812'
const comment = 'workspace-e2e@ssh-heaven'
const originalNickname = 'Local workspace fixture'
const renamedNickname = 'My favorite test server'
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture()
const rendererErrors: string[] = []
let app: ElectronApplication | undefined

async function launch(): Promise<Page> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({
    executablePath: executable || require('electron') as string,
    args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`],
    env,
    timeout: 30_000,
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  // Managed key generation must never open a save picker. Clipboard operations
  // remain isolated from the user's real system clipboard.
  await app.evaluate(({ dialog, clipboard }) => {
    const target = globalThis as unknown as { keygenSaveDialogs: number }
    target.keygenSaveDialogs = 0
    dialog.showSaveDialog = (async () => { target.keygenSaveDialogs++; throw new Error('Key generation must not open a save picker') }) as typeof dialog.showSaveDialog
    let contents = ''
    clipboard.writeText = async (value) => { contents = value }
    clipboard.readText = async () => contents
  })
  return page
}

async function openHome(page: Page) {
  await page.getByRole('button', { name: 'Open home', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Your workspace, ready.', exact: true })).toBeVisible()
  return page.getByRole('region', { name: 'Recently accessed hosts', exact: true })
}

async function openGenerator(page: Page) {
  await openHome(page)
  await page.getByRole('button', { name: 'Generate SSH key', exact: true }).first().click()
  const generator = page.getByRole('dialog', { name: 'Generate SSH key', exact: true })
  await expect(generator).toBeVisible()
  return generator
}

try {
  let page = await launch()
  const recent = await openHome(page)
  await expect(recent.locator('.recent-host-card')).toHaveCount(0)
  await page.screenshot({ path: path.join(root, 'test-results', 'workspace-home-empty.png') })

  const generator = await openGenerator(page)
  await expect(generator.getByLabel('Key type', { exact: true })).toHaveValue('ed25519')
  await generator.getByLabel(/^Key comment/).fill(comment)
  await generator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
  await expect(generator.getByRole('alert')).toContainText('at least 12 characters')
  for (const invalid of ['            ', '😀😀😀😀😀😀']) {
    await generator.getByLabel('Passphrase', { exact: true }).fill(invalid)
    await generator.getByLabel('Confirm passphrase', { exact: true }).fill(invalid)
    await generator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
    await expect(generator.getByRole('alert')).toContainText('at least 12 characters')
    await expect(generator.getByLabel('Passphrase', { exact: true })).toHaveValue(invalid)
  }
  await generator.getByLabel('Passphrase', { exact: true }).fill('too-short')
  await generator.getByLabel('Confirm passphrase', { exact: true }).fill('too-short')
  await generator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
  await expect(generator.getByRole('alert')).toContainText('at least 12 characters')
  await generator.getByLabel(/^Passphrase/).fill(passphrase)
  await generator.getByLabel('Confirm passphrase', { exact: true }).fill('a-different-password')
  await generator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
  await expect(generator.getByRole('alert')).toContainText('Passphrases do not match')
  await generator.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase)
  await generator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
  await expect(generator.getByRole('heading', { name: 'Your SSH key is ready', exact: true })).toBeVisible()
  const privateKeyPath = (await generator.getByTestId('private-key-path').innerText()).trim()
  const publicKeyPath = (await generator.getByTestId('public-key-path').innerText()).trim()
  assert.equal(path.dirname(privateKeyPath), path.join(dataDirectory, 'ssh-keys'))
  assert.equal(publicKeyPath, `${privateKeyPath}.pub`)
  assert.equal(await app!.evaluate(() => (globalThis as unknown as { keygenSaveDialogs: number }).keygenSaveDialogs), 0)
  assert.equal((await page.evaluate(() => window.sshHeaven.getLibrary())).keys.filter((key) => key.path === privateKeyPath).length, 1, 'Managed key generation registers one named key automatically')
  const privateBytes = await readFile(privateKeyPath)
  const publicKey = (await readFile(publicKeyPath, 'utf8')).trim()
  assert.match(publicKey, /^ssh-ed25519 [A-Za-z0-9+/=]+ workspace-e2e@ssh-heaven$/)
  const parsedValue = ssh2.utils.parseKey(privateBytes, passphrase)
  if (parsedValue instanceof Error) throw parsedValue
  const parsed = Array.isArray(parsedValue) ? parsedValue[0] : parsedValue
  assert.equal(parsed.type, 'ssh-ed25519')
  assert.deepEqual(parsed.getPublicSSH(), Buffer.from(publicKey.split(' ')[1], 'base64'))
  const withoutPassphrase = ssh2.utils.parseKey(privateBytes)
  assert.ok(withoutPassphrase instanceof Error, 'The generated identity must require its passphrase')
  const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`
  await expect(generator.getByText(fingerprint, { exact: true })).toBeVisible()
  await expect.poll(async () => (await generator.getByLabel('Generated public key', { exact: true }).inputValue()).trim()).toBe(publicKey)
  await generator.getByRole('button', { name: 'Copy public key', exact: true }).click()
  await expect.poll(async () => (await page.evaluate(() => window.sshHeaven.readClipboard())).trim()).toBe(publicKey)
  await page.screenshot({ path: path.join(root, 'test-results', 'workspace-generated-key.png') })
  await generator.getByRole('button', { name: 'Use key in connection', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'SSH key', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTitle(privateKeyPath, { exact: true })).toBeVisible()

  // A second generation gets a fresh managed path and preserves the first key.
  const secondGenerator = await openGenerator(page)
  await secondGenerator.getByLabel('Passphrase', { exact: true }).fill(passphrase)
  await secondGenerator.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase)
  await secondGenerator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
  await expect(secondGenerator.getByRole('heading', { name: 'Your SSH key is ready', exact: true })).toBeVisible()
  const secondPath = (await secondGenerator.getByTestId('private-key-path').innerText()).trim()
  assert.notEqual(secondPath, privateKeyPath)
  assert.equal(path.dirname(secondPath), path.join(dataDirectory, 'ssh-keys'))
  assert.deepEqual(await readFile(privateKeyPath), privateBytes)
  assert.equal((await readFile(publicKeyPath, 'utf8')).trim(), publicKey)
  await secondGenerator.getByRole('button', { name: 'Done', exact: true }).click()

  // Key generation itself must not create a recently accessed host. Only a
  // successful SSH session belongs in this list.
  await expect((await openHome(page)).locator('.recent-host-card')).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page.getByLabel(/^Nickname/).fill(originalNickname)
  await page.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
  await page.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page.getByRole('button', { name: 'Password', exact: true }).click()
  await expect(page.getByLabel('Remember password on this device', { exact: true })).toBeChecked()
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Verify server identity', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  const connectedProfile = (await page.evaluate(() => window.sshHeaven.listProfiles())).find((profile) => profile.name === originalNickname)!
  assert.ok((await page.evaluate(() => window.sshHeaven.getCredentialStatus())).profileIds.includes(connectedProfile.id), 'A successful password connection remembers its encrypted credential by default')
  assert.ok(!(await readFile(path.join(dataDirectory, 'credentials.json'), 'utf8')).includes(fixture.password), 'Remembered server passwords must stay encrypted at rest')
  const afterConnection = await openHome(page)
  await expect(afterConnection.locator('.recent-host-card')).toHaveCount(1)
  await expect(afterConnection.getByRole('heading', { name: originalNickname, exact: true })).toBeVisible()
  await afterConnection.getByRole('button', { name: `Edit nickname for ${originalNickname}`, exact: true }).click()
  await page.getByLabel(/^Nickname/).fill(renamedNickname)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  const renamed = await openHome(page)
  await expect(page.getByRole('tab', { name: renamedNickname, exact: true })).toBeVisible()
  await expect(renamed.getByRole('heading', { name: renamedNickname, exact: true })).toBeVisible()
  await expect(renamed.getByRole('button', { name: `Open ${renamedNickname} connection`, exact: true })).toBeVisible()
  const notification = page.getByRole('button', { name: 'Dismiss notification', exact: true })
  if (await notification.count()) await notification.click()
  await page.screenshot({ path: path.join(root, 'test-results', 'workspace-recent-hosts.png') })

  const metadata = await readFile(path.join(dataDirectory, 'settings.json'), 'utf8')
  assert.ok(metadata.includes(renamedNickname))
  assert.ok(!metadata.includes(fixture.password), 'SSH passwords must not be saved')
  assert.ok(!metadata.includes(passphrase), 'Generated-key passphrases must not be saved')
  assert.ok(!metadata.includes('BEGIN OPENSSH PRIVATE KEY'), 'Private-key material must not be saved in settings')
  await app!.close()
  app = undefined

  page = await launch()
  const restored = await openHome(page)
  await expect(restored.locator('.recent-host-card')).toHaveCount(1)
  await expect(restored.getByRole('heading', { name: renamedNickname, exact: true })).toBeVisible()
  await restored.getByRole('button', { name: `Open ${renamedNickname} connection`, exact: true }).click()
  await expect(page.getByLabel(/^Nickname/)).toHaveValue(renamedNickname)
  await expect(page.getByLabel('Hostname or IP address', { exact: true })).toHaveValue(fixture.host)
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue(fixture.username)
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')

  const history = await openHome(page)
  await history.getByRole('button', { name: 'Clear history', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Clear recent connections?', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Keep history', exact: true }).click()
  await expect(history.locator('.recent-host-card')).toHaveCount(1)
  await history.getByRole('button', { name: 'Clear history', exact: true }).click()
  await page.getByRole('button', { name: 'Clear recent connections', exact: true }).click()
  await expect(history.locator('.recent-host-card')).toHaveCount(0)
  const profiles = await page.evaluate(() => window.sshHeaven.listProfiles())
  assert.ok(profiles.some((profile) => profile.name === renamedNickname), 'Clearing history must preserve saved hosts')
  assert.deepEqual(await page.evaluate(() => window.sshHeaven.listRecentHosts()), [])

  assert.deepEqual(rendererErrors, [], `Renderer exceptions: ${rendererErrors.join(', ')}`)
  assert.equal(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible())), false)
  console.log('Background workspace E2E passed: required encryption password, managed encrypted Ed25519 keys without file pickers, automatic library registration, distinct destinations, public key/fingerprint, safe clipboard, key use, recents/nicknames, restart persistence, credential isolation and confirmed history clearing.')
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => undefined)
    await page?.screenshot({ path: path.join(root, 'test-results', 'workspace-failure.png') }).catch(() => {})
    if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 7000))
  }
  throw error
} finally {
  await app?.close()
  await fixture.close()
  // temporary is the absolute path returned by mkdtemp above.
  await rm(temporary, { recursive: true, force: true })
}
