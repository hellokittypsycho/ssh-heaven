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
const identityDirectory = path.join(temporary, 'identities')
const privateKeyPath = path.join(identityDirectory, 'id_ed25519_workspace_test')
const publicKeyPath = `${privateKeyPath}.pub`
const passphrase = 'workspace-e2e-encrypted-key-7812'
const comment = 'workspace-e2e@ssh-heaven'
const originalNickname = 'Local workspace fixture'
const renamedNickname = 'My favorite test server'
await mkdir(dataDirectory)
await mkdir(identityDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture()
const rendererErrors: string[] = []
let app: ElectronApplication | undefined

async function launch(): Promise<Page> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({
    executablePath: executable || require('electron') as string,
    args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`],
    env,
    timeout: 30_000,
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  // These stubs keep every key inside the test's temporary directory and never
  // replace the contents of the user's real system clipboard.
  await app.evaluate(({ dialog, clipboard }, destination) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as typeof dialog.showSaveDialog
    let contents = ''
    clipboard.writeText = async (value) => { contents = value }
    clipboard.readText = async () => contents
  }, privateKeyPath)
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
  await generator.getByLabel(/^Passphrase/).fill(passphrase)
  await generator.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase)
  await generator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
  await expect(generator.getByRole('heading', { name: 'Your SSH key is ready', exact: true })).toBeVisible()
  await expect(generator.getByTestId('private-key-path')).toHaveText(privateKeyPath)
  await expect(generator.getByTestId('public-key-path')).toHaveText(publicKeyPath)
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

  // Selecting an existing destination must leave both halves of the identity intact.
  const overwriteGenerator = await openGenerator(page)
  await overwriteGenerator.getByRole('button', { name: 'Generate key pair', exact: true }).click()
  await expect(overwriteGenerator.locator('.form-error')).toContainText(/already exists|overwrite|existing/i)
  assert.deepEqual(await readFile(privateKeyPath), privateBytes)
  assert.equal((await readFile(publicKeyPath, 'utf8')).trim(), publicKey)
  await overwriteGenerator.getByRole('button', { name: 'Close dialog', exact: true }).click()

  // Key generation itself must not create a recently accessed host. Only a
  // successful SSH session belongs in this list.
  await expect((await openHome(page)).locator('.recent-host-card')).toHaveCount(0)
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page.getByLabel(/^Nickname/).fill(originalNickname)
  await page.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
  await page.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page.getByRole('button', { name: 'Password', exact: true }).click()
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Verify server identity', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
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
  console.log('Workspace E2E passed: empty Home, encrypted Ed25519 generation, public key/fingerprint, safe clipboard, key use, overwrite protection, successful recent connection, nickname edits, restart persistence, credential isolation, confirmed history clearing without deleting saved hosts.')
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
