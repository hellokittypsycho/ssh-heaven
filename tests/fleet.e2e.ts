import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { GroupCommandEvent } from '../shared/types'
import { startFixture, type SshFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-fleet-e2e-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixtures: SshFixture[] = []
const rendererErrors: string[] = []
let app: ElectronApplication | undefined

async function events(page: Page): Promise<GroupCommandEvent[]> {
  return page.evaluate(() => (window as unknown as { fleetEvents: GroupCommandEvent[] }).fleetEvents)
}

async function latestResults(page: Page, runId: string): Promise<GroupCommandEvent[]> {
  return page.evaluate((id) => {
    const latest = new Map<string, GroupCommandEvent>()
    for (const event of (window as unknown as { fleetEvents: GroupCommandEvent[] }).fleetEvents) {
      if (event.runId === id) latest.set(event.profileId, event)
    }
    return [...latest.values()]
  }, runId)
}

async function reviewAndRun(page: Page, commandDialog: Locator, command: string): Promise<string> {
  const beforeReview = (await events(page)).length
  await commandDialog.getByLabel('Group command', { exact: true }).fill(command)
  await commandDialog.getByRole('button', { name: 'Review command', exact: true }).click()
  await expect(commandDialog.getByLabel('Command to execute', { exact: true })).toHaveText(command)
  await expect(commandDialog.getByRole('button', { name: 'Run on 2 servers', exact: true })).toBeVisible()
  assert.equal((await events(page)).length, beforeReview, 'Reviewing a command must not start any SSH work')
  await commandDialog.getByRole('button', { name: 'Run on 2 servers', exact: true }).click()
  await expect.poll(async () => (await events(page)).length).toBeGreaterThan(beforeReview)
  const started = (await events(page)).slice(beforeReview)
  assert.ok(started[0]?.runId)
  return started[0].runId
}

async function assertNoInteractiveSessions(page: Page) {
  await expect(page.locator('.session-workspace')).toHaveCount(0)
  await expect(page.locator('.xterm-helper-textarea')).toHaveCount(0)
  await expect(page.getByRole('tablist', { name: 'Connection sessions', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab')).toHaveCount(0)
  for (const name of ['Open home', 'Open scripts', 'Open vault']) await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true })).toBeVisible()
}

try {
  const first = await startFixture({ host: '127.0.0.1', privateKeyAuth: true })
  fixtures.push(first)
  const second = await startFixture({ host: '127.0.0.2', port: first.port, username: 'root', password: first.password })
  fixtures.push(second)
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
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  await page.evaluate(() => {
    const target = window as unknown as { fleetEvents: GroupCommandEvent[] }
    target.fleetEvents = []
    window.sshHeaven.onGroupCommand((event) => target.fleetEvents.push(event))
  })
  const available = await page.evaluate(() => window.sshHeaven.getCredentialStatus())
  assert.equal(available.available, true, 'This test requires real encrypted OS credential storage')

  await page.getByRole('button', { name: 'Bulk import hosts', exact: true }).click()
  const importer = page.getByRole('dialog', { name: 'Bulk import hosts', exact: true })
  await importer.getByLabel('Port', { exact: true }).fill(String(first.port))
  await importer.getByLabel(/^Group/).fill('Fleet QA')
  await importer.getByLabel('Hosts to import', { exact: true }).fill(`${first.host}:${first.username}:${first.password}\n${second.host}:${second.password}\n${first.host}:${first.username}:${first.password}`)
  await importer.getByRole('button', { name: 'Preview import', exact: true }).click()
  await expect(importer.getByText('2 ready to import', { exact: true })).toBeVisible()
  await expect(importer.getByText(/^1 duplicates? skipped$/)).toBeVisible()
  await expect(importer.getByText(`${first.username}@${first.host}`, { exact: true })).toBeVisible()
  await expect(importer.getByText(`root@${second.host}`, { exact: true })).toBeVisible()
  assert.equal((await importer.innerText()).includes(first.password), false, 'Import preview must mask passwords')
  await page.screenshot({ path: path.join(root, 'test-results', 'fleet-import-preview.png') })
  await importer.getByRole('button', { name: 'Import 2 hosts', exact: true }).click()
  await expect(importer.getByRole('heading', { name: '2 hosts imported', exact: true })).toBeVisible()
  await importer.getByRole('button', { name: 'Done', exact: true }).click()
  const profiles = await page.evaluate(() => window.sshHeaven.listProfiles())
  assert.equal(profiles.length, 2)
  assert.deepEqual(profiles.map(({ host, port, username, group, authType }) => ({ host, port, username, group, authType })).sort((a, b) => a.host.localeCompare(b.host)), [
    { host: first.host, port: first.port, username: first.username, group: 'Fleet QA', authType: 'password' },
    { host: second.host, port: second.port, username: 'root', group: 'Fleet QA', authType: 'password' },
  ])
  const credentials = await page.evaluate(() => window.sshHeaven.getCredentialStatus())
  assert.deepEqual([...credentials.profileIds].sort(), profiles.map((profile) => profile.id).sort())
  const vault = await readFile(path.join(dataDirectory, 'credentials.json'), 'utf8')
  assert.equal(Object.keys(JSON.parse(vault).entries).length, 2)
  assert.equal(vault.includes(first.password), false, 'Vault file must not contain plaintext passwords')
  const settings = await readFile(path.join(dataDirectory, 'settings.json'), 'utf8')
  assert.equal(settings.includes(first.password), false, 'Host metadata must not contain plaintext passwords')

  await page.getByRole('button', { name: 'Run group command for Fleet QA', exact: true }).click()
  const commandDialog = page.getByRole('dialog', { name: 'Run group command', exact: true })
  await expect(commandDialog.getByLabel('Host group', { exact: true })).toHaveValue('Fleet QA')
  await commandDialog.getByLabel('Timeout per server (seconds)', { exact: true }).fill('1')
  const untrustedRun = await reviewAndRun(page, commandDialog, 'echo untrusted-should-not-run')
  await expect(page.getByRole('dialog', { name: 'Verify server identity', exact: true })).toBeVisible()
  await expect(commandDialog.locator('.group-server-result[data-status="failed"]')).toHaveCount(2)
  await expect(page.getByRole('dialog', { name: 'Verify server identity', exact: true })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Server identity has changed', exact: true })).toHaveCount(0)
  const untrusted = await latestResults(page, untrustedRun)
  assert.equal(untrusted.length, 2)
  assert.ok(untrusted.every((result) => result.status === 'failed' && /timed out/i.test(result.error ?? '') && !result.output?.includes('untrusted-should-not-run')))
  const untrustedSettings = JSON.parse(await readFile(path.join(dataDirectory, 'settings.json'), 'utf8'))
  assert.deepEqual(untrustedSettings.knownHosts, {}, 'Timed-out verification must not remember an unapproved fingerprint')
  await assertNoInteractiveSessions(page)
  await commandDialog.getByRole('button', { name: 'Another command', exact: true }).click()
  await commandDialog.getByLabel('Timeout per server (seconds)', { exact: true }).fill('300')
  const completedRun = await reviewAndRun(page, commandDialog, 'echo fleet-e2e')
  for (let index = 0; index < 2; index++) {
    await expect(page.getByRole('dialog', { name: 'Verify server identity', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  }
  await expect(commandDialog.locator('.group-server-result[data-status="completed"]')).toHaveCount(2)
  await expect(commandDialog.getByText('Exit 0', { exact: true })).toHaveCount(2)
  await expect(commandDialog.getByLabel(`Output from ${first.host}`, { exact: true })).toContainText('fleet-e2e')
  await expect(commandDialog.getByLabel(`Output from ${second.host}`, { exact: true })).toContainText('fleet-e2e')
  const completed = await latestResults(page, completedRun)
  assert.equal(completed.length, 2)
  assert.ok(completed.every((result) => result.status === 'completed' && result.exitCode === 0 && result.output?.includes('fleet-e2e')))
  await assertNoInteractiveSessions(page)
  await page.screenshot({ path: path.join(root, 'test-results', 'fleet-command-results.png') })

  await commandDialog.getByRole('button', { name: 'Another command', exact: true }).click()
  const canceledRun = await reviewAndRun(page, commandDialog, 'wait-for-cancel')
  await expect(commandDialog.locator('.group-server-result[data-status="running"]')).toHaveCount(2)
  await commandDialog.getByRole('button', { name: 'Cancel run', exact: true }).click()
  await expect(commandDialog.locator('.group-server-result[data-status="canceled"]')).toHaveCount(2)
  const canceled = await latestResults(page, canceledRun)
  assert.equal(canceled.length, 2)
  assert.ok(canceled.every((result) => result.status === 'canceled'))
  await assertNoInteractiveSessions(page)

  await commandDialog.getByRole('button', { name: 'Another command', exact: true }).click()
  const failedRun = await reviewAndRun(page, commandDialog, 'exit 7')
  await expect(commandDialog.locator('.group-server-result[data-status="failed"]')).toHaveCount(2)
  await expect(commandDialog.getByText('Command exited with status 7.', { exact: true })).toHaveCount(2)
  const failed = await latestResults(page, failedRun)
  assert.equal(failed.length, 2)
  assert.ok(failed.every((result) => result.status === 'failed' && result.exitCode === 7))
  await commandDialog.getByRole('button', { name: 'Done', exact: true }).click()
  await assertNoInteractiveSessions(page)
  const afterCommands = (await events(page)).length

  // Shared-key import uses the real main-process file-picker capability while
  // the native chooser is redirected to the fixture's temporary identity.
  const selectedKey = first.privateKeyPath
  assert.ok(selectedKey)
  await app.evaluate(({ dialog }, filename) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filename] })) as typeof dialog.showOpenDialog
  }, selectedKey)
  await page.getByRole('button', { name: 'Bulk import hosts', exact: true }).click()
  await importer.getByRole('button', { name: 'One SSH key for all', exact: true }).click()
  await importer.getByLabel(/^Group/).fill('Keyfleet')
  await importer.getByLabel('Port', { exact: true }).fill('22')
  await importer.getByRole('button', { name: 'Browse', exact: true }).click()
  await expect(importer.getByTitle(selectedKey, { exact: true })).toBeVisible()
  await importer.getByLabel('Hosts to import', { exact: true }).fill('192.0.2.20\n192.0.2.21:admin')
  await importer.getByRole('button', { name: 'Preview import', exact: true }).click()
  await expect(importer.getByText('2 ready to import', { exact: true })).toBeVisible()
  await importer.getByRole('button', { name: 'Import 2 hosts', exact: true }).click()
  await expect(importer.getByRole('heading', { name: '2 hosts imported', exact: true })).toBeVisible()
  await importer.getByRole('button', { name: 'Done', exact: true }).click()
  const allProfiles = await page.evaluate(() => window.sshHeaven.listProfiles())
  const keyProfiles = allProfiles.filter((profile) => profile.group === 'Keyfleet')
  assert.deepEqual(keyProfiles.map(({ host, username, port, authType, privateKeyPath: key }) => ({ host, username, port, authType, key })).sort((a, b) => a.host.localeCompare(b.host)), [
    { host: '192.0.2.20', username: 'root', port: 22, authType: 'privateKey', key: selectedKey },
    { host: '192.0.2.21', username: 'admin', port: 22, authType: 'privateKey', key: selectedKey },
  ])
  assert.equal(allProfiles.length, 4)
  const afterKeyImport = await page.evaluate(() => window.sshHeaven.getCredentialStatus())
  assert.deepEqual([...afterKeyImport.profileIds].sort(), [...credentials.profileIds].sort(), 'Shared-key import must not add passwords to the vault')
  assert.equal((await events(page)).length, afterCommands, 'Importing key profiles must not start network commands')
  await assertNoInteractiveSessions(page)
  assert.deepEqual(rendererErrors, [], `Renderer exceptions: ${rendererErrors.join(', ')}`)
  console.log('Fleet E2E passed: masked bulk preview, endpoint deduplication, root defaults, encrypted password import, timed-out host verification cleanup, reviewed group execution, host verification, output/exit codes, cancellation, shared-key import, and no interactive SSH sessions.')
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => undefined)
    await page?.screenshot({ path: path.join(root, 'test-results', 'fleet-failure.png') }).catch(() => {})
    if (page) {
      let body = (await page.locator('body').innerText().catch(() => '')).slice(0, 7000)
      for (const fixture of fixtures) {
        body = body.replaceAll(fixture.password, '[REDACTED]')
        if (fixture.passphrase) body = body.replaceAll(fixture.passphrase, '[REDACTED]')
      }
      console.error(body)
    }
  }
  throw error
} finally {
  await app?.close()
  await Promise.allSettled(fixtures.map((fixture) => fixture.close()))
  // temporary is the resolved absolute directory returned by mkdtemp above.
  await rm(temporary, { recursive: true, force: true })
}
