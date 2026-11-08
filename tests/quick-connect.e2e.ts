import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { HostProfile } from '../shared/types'
import { channels } from '../electron/channels'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-quick-connect-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const [good, rejected, unsaved] = await Promise.all([startFixture(), startFixture(), startFixture()])
let app: ElectronApplication | undefined
let page: Page | undefined
const rendererErrors: string[] = []
type Attempt = { sessionId: string; profileId: string; host: string; useSavedCredential: boolean; hasPassword: boolean }

const sidebarQuick = (name: string) => page!.locator('.sidebar').getByRole('button', { name: `Quick connect ${name}`, exact: true })
const activePane = () => page!.locator('.session-workspace.is-active-pane')
async function attempts(): Promise<Attempt[]> {
  return app!.evaluate(() => (globalThis as unknown as { quickConnectAttempts: Attempt[] }).quickConnectAttempts)
}
async function trustAndConnect() {
  await expect.poll(async () => {
    const trust = page!.getByRole('button', { name: 'Trust & connect', exact: true })
    if (await trust.isVisible()) await trust.click()
    return activePane().locator('.terminal-footer').getByText('Connected', { exact: true }).count()
  }, { timeout: 20_000 }).toBe(1)
}
async function assertDraft() {
  await page!.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await expect(page!.getByLabel(/^Nickname/)).toHaveValue('Unfinished draft')
  await expect(page!.getByLabel('Hostname or IP address', { exact: true })).toHaveValue('draft.example')
  await expect(page!.getByLabel('Username', { exact: true })).toHaveValue('draft-user')
  await expect(page!.getByLabel('Password', { exact: true })).toHaveValue('unsubmitted-draft-secret')
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  // Observe native invocation metadata only, without returning passwords to the
  // renderer or replacing the real vault, authentication, or SSH transport.
  await app.evaluate(({ ipcMain, clipboard }, channel) => {
    const target = globalThis as unknown as { quickConnectAttempts: Attempt[]; quickConnectClipboard: string[] }
    target.quickConnectAttempts = []; target.quickConnectClipboard = []
    const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, request: Record<string, unknown>) => unknown> })._invokeHandlers.get(channel)!
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, request) => {
      target.quickConnectAttempts.push({ sessionId: request.sessionId, profileId: request.profile.id, host: request.profile.host, useSavedCredential: request.useSavedCredential === true, hasPassword: typeof request.password === 'string' && request.password.length > 0 })
      return handler(event, request)
    })
    clipboard.writeText = async (value) => { target.quickConnectClipboard.push(value) }
  }, channels.connect)
  const profiles = await page.evaluate(async (hosts) => {
    const result: HostProfile[] = []
    for (const [index, host] of hosts.entries()) {
      await window.sshHeaven.importHosts({ text: `${host.host}:${host.username}:${host.password}`, port: host.port, authType: 'password', group: 'Quick connect QA' })
      const profile = (await window.sshHeaven.listProfiles()).find((item) => item.port === host.port)!
      result.push(await window.sshHeaven.saveProfile({ ...profile, name: index ? 'Rejected password' : 'Remembered server', autoReconnect: index === 1 }))
    }
    return result
  }, [good, { ...rejected, password: `${rejected.password}-incorrect` }].map(({ host, port, username, password }) => ({ host, port, username, password })))
  assert.equal((await page.evaluate(() => window.sshHeaven.getCredentialStatus())).profileIds.length, 2)
  const encryptedVault = await readFile(path.join(dataDirectory, 'credentials.json'), 'utf8')
  assert.ok(!encryptedVault.includes(good.password), 'The native vault must encrypt imported passwords')
  assert.ok(!JSON.stringify(profiles).includes(good.password))
  await page.reload()
  await expect(sidebarQuick('Remembered server')).toBeVisible()

  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page.getByLabel(/^Nickname/).fill('Unfinished draft')
  await page.getByLabel('Hostname or IP address', { exact: true }).fill('draft.example')
  await page.getByLabel('Username', { exact: true }).fill('draft-user')
  await page.getByLabel('Password', { exact: true }).fill('unsubmitted-draft-secret')
  // Two click events in one turn exercise the immediate guard before React
  // commits the disabled state or the native host-key modal appears.
  await sidebarQuick('Remembered server').evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click() })
  await expect(page.getByRole('dialog', { name: 'Verify server identity', exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true })).not.toHaveAttribute('aria-current', 'page')
  await expect(sidebarQuick('Remembered server')).toBeDisabled()
  assert.equal((await attempts()).length, 1, 'Repeated clicks must create one pending SSH connection')
  await trustAndConnect()
  await expect(sidebarQuick('Remembered server')).toBeEnabled()
  assert.deepEqual((await attempts()).map(({ useSavedCredential, hasPassword }) => ({ useSavedCredential, hasPassword })), [{ useSavedCredential: true, hasPassword: false }])
  await assertDraft()

  await page.getByRole('button', { name: 'Open home', exact: true }).click()
  await page.getByRole('button', { name: 'Quick connect recent Remembered server', exact: true }).click()
  await trustAndConnect()
  await expect(page.getByRole('status', { name: 'SSH session summary', exact: true })).toHaveText('2 online')
  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Quick switcher', exact: true })
  await palette.getByRole('combobox', { name: 'Search hosts and actions', exact: true }).fill('Quick connect Remembered server')
  await expect(palette.getByRole('option', { name: 'Quick connect Remembered server', exact: true })).toBeVisible()
  await palette.getByRole('combobox', { name: 'Search hosts and actions', exact: true }).press('Enter')
  await trustAndConnect()
  await expect(page.getByRole('status', { name: 'SSH session summary', exact: true })).toHaveText('3 online')
  await assertDraft()
  assert.ok((await attempts()).every((attempt) => attempt.useSavedCredential && !attempt.hasPassword), 'Every quick connection must use the native vault without a renderer password')
  assert.deepEqual(await app.evaluate(() => (globalThis as unknown as { quickConnectClipboard: string[] }).quickConnectClipboard), [])
  assert.ok(!(await page.locator('body').innerText()).includes(good.password), 'Quick connect must not render the saved password')

  // Forgetting through native IPC deliberately leaves the action's cached UI
  // eligibility stale. Fresh status must stop any connection attempt.
  await page.evaluate((id) => window.sshHeaven.forgetCredential(id), profiles[0].id)
  await expect(sidebarQuick('Remembered server')).toBeVisible()
  await sidebarQuick('Remembered server').click()
  await expect(page.locator('.connection-card .form-error')).toContainText('saved password is unavailable')
  await expect(page.locator('.credential-recovery-message')).toBeInViewport({ ratio: 1 })
  await expect(page.getByLabel('Password', { exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  await expect(page.getByRole('checkbox', { name: 'Use saved password', exact: true })).toHaveCount(0)
  assert.equal((await attempts()).length, 3)
  await page.getByLabel('Password', { exact: true }).fill(good.password)
  await page.getByRole('checkbox', { name: 'Remember password on this device', exact: true }).check()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await trustAndConnect()
  await expect(sidebarQuick('Remembered server')).toBeEnabled()

  await sidebarQuick('Rejected password').click()
  await expect(page.getByRole('dialog', { name: 'Verify server identity', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.connection-card .form-error')).toContainText('saved password could not sign in')
  await expect(page.locator('.credential-recovery-message')).toBeInViewport({ ratio: 1 })
  await expect(page.getByLabel('Password', { exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
  await expect(page.getByRole('checkbox', { name: 'Use saved password', exact: true })).not.toBeChecked()
  const rejectedAttempts = (await attempts()).filter((attempt) => attempt.profileId === profiles[1].id)
  assert.equal(rejectedAttempts.length, 1)
  await page.waitForTimeout(2500)
  assert.equal((await attempts()).filter((attempt) => attempt.profileId === profiles[1].id).length, 1, 'A rejected saved password must not be retried automatically')
  await page.screenshot({ path: path.join(root, 'test-results', 'quick-connect-credentials.png') })
  await page.getByLabel('Password', { exact: true }).fill(rejected.password)
  await page.getByRole('checkbox', { name: 'Remember password on this device', exact: true }).check()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await trustAndConnect()
  await expect(page.locator('.connection-card button[type="submit"]')).toBeEnabled()
  const recovered = (await attempts()).filter((attempt) => attempt.profileId === profiles[1].id)
  assert.equal(recovered.length, 2)
  assert.equal(recovered[0].sessionId, recovered[1].sessionId, 'Credential recovery must reuse the failed session tab')

  // A cached action must not silently follow an ID whose endpoint changed.
  await expect(sidebarQuick('Remembered server')).toBeEnabled()
  await page.evaluate((profile) => window.sshHeaven.saveProfile({ ...profile, host: '127.0.0.2' }), profiles[0])
  const countBeforeChangedEndpoint = (await attempts()).length
  await sidebarQuick('Remembered server').click()
  await expect(page.locator('.connection-card .form-error')).toContainText('saved connection details changed')
  await expect(page.getByLabel('Hostname or IP address', { exact: true })).toHaveValue('127.0.0.2')
  assert.equal((await attempts()).length, countBeforeChangedEndpoint)

  // An unsaved recent connection gets an ordinary Open action. It becomes
  // eligible only after matching, separately saved metadata has a vault entry.
  await page.locator('.sidebar').getByRole('button', { name: 'Create a new connection', exact: true }).click()
  await page.getByLabel(/^Nickname/).fill('Unsaved recent')
  await page.getByLabel('Hostname or IP address', { exact: true }).fill(unsaved.host)
  await page.getByLabel('SSH port', { exact: true }).fill(String(unsaved.port))
  await page.getByLabel('Username', { exact: true }).fill(unsaved.username)
  await page.getByLabel('Password', { exact: true }).fill(unsaved.password)
  await page.getByRole('checkbox', { name: 'Remember password on this device', exact: true }).uncheck()
  await page.getByRole('checkbox', { name: 'Save to hosts', exact: true }).uncheck()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await trustAndConnect()
  await page.getByRole('button', { name: 'Open home', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open Unsaved recent connection', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Quick connect recent Unsaved recent', exact: true })).toHaveCount(0)
  await page.evaluate(async (host) => {
    await window.sshHeaven.importHosts({ text: `${host.host}:${host.username}:${host.password}`, port: host.port, authType: 'password' })
    const profile = (await window.sshHeaven.listProfiles()).find((item) => item.port === host.port)!
    await window.sshHeaven.saveProfile({ ...profile, name: 'Saved recent endpoint' })
  }, { host: unsaved.host, port: unsaved.port, username: unsaved.username, password: unsaved.password })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Quick connect recent Saved recent endpoint', exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(root, 'test-results', 'quick-connect-home.png') })
  assert.deepEqual(rendererErrors, [])
  console.log('Quick connect E2E passed: encrypted native passwords, sidebar/recent/palette actions, click deduplication, untouched drafts, host verification, fresh credential/endpoint checks, password recovery without automatic retries, and saved-metadata matching for recents.')
} catch (error) {
  if (page && app) await page.screenshot({ path: path.join(root, 'test-results', 'quick-connect-failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.close()
  await Promise.all([good.close(), rejected.close(), unsaved.close()])
  // This is the absolute directory returned by mkdtemp above.
  await rm(temporary, { recursive: true, force: true })
}
