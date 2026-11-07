import assert from 'node:assert/strict'
import { createConnection, createServer } from 'node:net'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import type { HostProfile, SessionStatus } from '../shared/types'
import { startFixture } from './fixture'
import { startTransportFixture } from './transport-fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-workspace-tools-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const first = await startFixture({ privateKeyAuth: true })
const second = await startFixture()
const transport = await startTransportFixture({ forwarding: true, tmux: true })
const echo = createServer((socket) => { socket.on('error', () => {}); socket.pipe(socket) })
await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
const echoAddress = echo.address()
if (!echoAddress || typeof echoAddress === 'string') throw new Error('Loopback echo listener failed')
let app: ElectronApplication | undefined
let page: Page | undefined
const errors: string[] = []

async function launch() {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  const current = await app.firstWindow()
  current.on('pageerror', (error) => errors.push(error.message))
  await expect(current.getByRole('tab', { name: 'Home', exact: true })).toBeVisible()
  await installObservers(current)
  page = current
  return current
}
async function installObservers(current: Page) {
  await current.evaluate(() => {
    const target = window as unknown as { workspaceOutput: Record<string, string>; workspaceStatus: SessionStatus[] }
    target.workspaceOutput = {}; target.workspaceStatus = []
    window.sshHeaven.onData(({ sessionId, data }) => { target.workspaceOutput[sessionId] = (target.workspaceOutput[sessionId] || '') + new TextDecoder().decode(data) })
    window.sshHeaven.onStatus((status) => target.workspaceStatus.push(status))
  })
}
const activePane = (current: Page) => current.locator('.session-workspace.is-active-pane')
async function connectHost(current: Page, name: string) {
  await current.getByTitle(`Connect to ${name}`, { exact: true }).click()
  await expect(current.getByLabel('Password', { exact: true })).toHaveValue('')
  await expect(current.getByRole('checkbox', { name: 'Use saved password', exact: true })).toBeChecked()
  await current.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(async () => {
    const trust = current.getByRole('button', { name: 'Trust & connect', exact: true })
    if (await trust.isVisible()) await trust.click()
    return await activePane(current).locator('.terminal-footer').getByText('Connected', { exact: true }).count()
  }, { timeout: 20_000 }).toBe(1)
}
async function typeCommand(current: Page, command: string) {
  await activePane(current).locator('.xterm-helper-textarea').focus()
  await current.keyboard.type(command)
  await current.keyboard.press('Enter')
}
async function combinedOutput(current: Page) { return current.evaluate(() => Object.values((window as unknown as { workspaceOutput: Record<string, string> }).workspaceOutput).join('')) }
async function roundTrip(port: number, text: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Forwarded loopback connection timed out')) }, 5000)
    socket.once('error', (error) => { clearTimeout(timer); reject(error) })
    socket.once('connect', () => socket.write(text))
    socket.once('data', (data) => { clearTimeout(timer); socket.end(); resolve(data.toString()) })
  })
}

try {
  let current = await launch()
  const metadata = await current.evaluate(async (fixtures) => {
    for (const fixture of fixtures) await window.sshHeaven.importHosts({ text: `${fixture.host}:${fixture.username}:${fixture.password}`, port: fixture.port, authType: 'password', group: 'Workspace QA' })
    const profiles = await window.sshHeaven.listProfiles()
    const saved: HostProfile[] = []
    for (let index = 0; index < fixtures.length; index++) {
      const profile = profiles.find((item) => item.port === fixtures[index].port)!
      saved.push(await window.sshHeaven.saveProfile({ ...profile, name: ['Workspace Alpha', 'Workspace Beta', 'Transport QA'][index], ...(index === 2 ? { autoReconnect: true, tmuxSession: 'workspace-shell' } : {}) }))
    }
    return saved
  }, [first, second, transport].map((fixture) => ({ host: fixture.host, port: fixture.port, username: fixture.username, password: fixture.password })))
  await current.reload(); await installObservers(current)
  await connectHost(current, 'Workspace Alpha')
  await typeCommand(current, 'echo alpha-history-marker')
  await expect.poll(() => combinedOutput(current)).toContain('alpha-history-marker')
  const alphaTerminal = await activePane(current).locator('.xterm-helper-textarea').elementHandle()
  const files = current.getByRole('complementary', { name: 'Remote files', exact: true })
  await files.getByText('documents', { exact: true }).dblclick()
  await expect(files.getByLabel('Remote path', { exact: true })).toHaveValue('/documents')

  await connectHost(current, 'Workspace Beta')
  await typeCommand(current, 'echo beta-history-marker')
  await expect.poll(() => combinedOutput(current)).toContain('beta-history-marker')
  const betaTerminal = await activePane(current).locator('.xterm-helper-textarea').elementHandle()
  await current.getByRole('button', { name: 'Split layout', exact: true }).click()
  await expect(current.locator('.session-workspace:not(.hidden-workspace)')).toHaveCount(2)
  const alphaPane = current.getByRole('region', { name: 'Workspace Alpha session', exact: true })
  await alphaPane.getByRole('button', { name: 'Move Workspace Alpha pane left', exact: true }).click()
  await expect(alphaPane).toHaveCSS('order', '0')
  await alphaPane.locator('.xterm-helper-textarea').click()
  await expect(current.getByRole('tab', { name: 'Workspace Alpha', exact: true })).toHaveAttribute('aria-selected', 'true')
  await current.getByRole('button', { name: 'Grid layout', exact: true }).click()
  await expect(current.locator('.session-panes')).toHaveAttribute('data-layout', 'grid')
  await expect.poll(async () => {
    const area = await current.locator('.session-panes').boundingBox()
    const pane = await alphaPane.boundingBox()
    return !!area && !!pane && pane.height >= area.height * .95
  }).toBe(true)
  assert.equal(await alphaTerminal!.evaluate((node) => node.isConnected), true, 'Alpha terminal must remain mounted through layout changes')
  assert.equal(await betaTerminal!.evaluate((node) => node.isConnected), true, 'Beta terminal must remain mounted through layout changes')
  await current.screenshot({ path: path.join(root, 'test-results', 'workspace-grid.png') })
  await current.getByRole('button', { name: 'Tabs layout', exact: true }).click()
  await current.getByRole('button', { name: 'Toggle remote files', exact: true }).click()
  await expect(files.getByLabel('Remote path', { exact: true })).toHaveValue('/documents')
  await activePane(current).getByRole('button', { name: 'Search terminal', exact: true }).click()
  await activePane(current).getByLabel('Find in terminal', { exact: true }).fill('alpha-history-marker')
  await expect(activePane(current).getByLabel('Terminal search results', { exact: true })).not.toHaveText('No matches')
  await activePane(current).getByRole('button', { name: 'Close terminal search', exact: true }).click()
  await current.getByRole('button', { name: 'Grid layout', exact: true }).click()
  await current.getByRole('button', { name: 'Workspaces', exact: true }).click()
  let workspaces = current.getByRole('dialog', { name: 'Workspaces', exact: true })
  await workspaces.getByLabel('Workspace name', { exact: true }).fill('Workspace layout QA')
  await workspaces.getByRole('button', { name: 'Save workspace', exact: true }).click()
  await expect(workspaces.getByRole('button', { name: 'Restore workspace Workspace layout QA', exact: true })).toBeVisible()
  const savedWorkspace = (await current.evaluate(() => window.sshHeaven.getLibrary())).workspaces[0]
  assert.equal(savedWorkspace.layout, 'grid'); assert.equal(savedWorkspace.profileIds.length, 2)
  assert.ok(!JSON.stringify(savedWorkspace).includes(first.password))
  await app!.close(); app = undefined

  current = await launch()
  await current.getByRole('button', { name: 'Workspaces', exact: true }).click()
  workspaces = current.getByRole('dialog', { name: 'Workspaces', exact: true })
  await workspaces.getByRole('button', { name: 'Restore workspace Workspace layout QA', exact: true }).click()
  await expect(current.locator('.session-workspace:not(.hidden-workspace)')).toHaveCount(2)
  assert.equal((await current.evaluate(() => (window as unknown as { workspaceStatus: SessionStatus[] }).workspaceStatus)).length, 0, 'Restoring metadata must not start any SSH connection')
  // A restored placeholder must pick up a key/auth change saved after restoration.
  await app!.evaluate(({ dialog }, privateKeyPath) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [privateKeyPath] })) as typeof dialog.showOpenDialog }, first.privateKeyPath!)
  await current.getByRole('button', { name: 'Edit Workspace Alpha', exact: true }).click()
  await current.getByRole('button', { name: 'SSH key', exact: true }).click()
  await current.getByRole('button', { name: 'Browse', exact: true }).click()
  await current.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect.poll(async () => (await current.evaluate(() => window.sshHeaven.listProfiles())).find((profile) => profile.name === 'Workspace Alpha')?.authType).toBe('privateKey')
  await current.getByRole('button', { name: 'Connect workspace', exact: true }).click()
  await expect(current.locator('.workspace-restored-banner')).toContainText('1 need credentials')
  await expect(current.getByRole('button', { name: 'SSH key', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(current.getByLabel('Key passphrase', { exact: true })).toBeVisible()
  await current.getByLabel('Key passphrase', { exact: true }).fill(first.passphrase!)
  await current.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(current.locator('.terminal-footer').getByText('Connected', { exact: true })).toHaveCount(2, { timeout: 20_000 })
  await expect(current.locator('.workspace-restored-banner')).toContainText('Workspace layout QA')
  await current.screenshot({ path: path.join(root, 'test-results', 'workspace-restored.png') })

  await current.getByRole('tab', { name: 'Home', exact: true }).click()
  await connectHost(current, 'Transport QA')
  assert.ok(transport.commands.includes('tmux new-session -A -s workspace-shell'), 'Opt-in tmux must be attached when connecting')
  await current.getByRole('button', { name: 'Server dashboard', exact: true }).click()
  const dashboard = current.getByRole('dialog', { name: 'Server dashboard', exact: true })
  await expect(dashboard.getByLabel('CPU usage', { exact: true })).toHaveText('50.0%')
  await expect(dashboard.getByText('Fixture Linux', { exact: true })).toBeVisible()
  await current.screenshot({ path: path.join(root, 'test-results', 'server-dashboard.png') })
  await dashboard.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const samples = transport.commands.filter((command) => command.includes('SSH_HEAVEN_METRICS_V1')).length
  await current.waitForTimeout(5200)
  assert.equal(transport.commands.filter((command) => command.includes('SSH_HEAVEN_METRICS_V1')).length, samples, 'Closing the dashboard must stop metrics polling')

  await current.getByRole('button', { name: 'SSH tunnels', exact: true }).click()
  const tunnels = current.getByRole('dialog', { name: 'SSH tunnels', exact: true })
  await tunnels.getByLabel(/^Rule name/).fill('Loopback local')
  await tunnels.getByLabel('Listening port', { exact: true }).fill('0')
  await tunnels.getByLabel('Target port', { exact: true }).fill(String(echoAddress.port))
  await tunnels.getByRole('checkbox', { name: 'Save forwarding rule', exact: true }).check()
  await tunnels.getByRole('button', { name: 'Start tunnel', exact: true }).click()
  await expect(tunnels.getByRole('button', { name: 'Stop tunnel Loopback local', exact: true })).toBeVisible()
  const local = (await current.evaluate(() => window.sshHeaven.listTunnels())).find((tunnel) => tunnel.name === 'Loopback local' && tunnel.status === 'active')!
  assert.equal(await roundTrip(local.boundPort, 'workspace-local-forward'), 'workspace-local-forward')
  await expect.poll(async () => (await current.evaluate(() => window.sshHeaven.getLibrary())).tunnelRules.length).toBe(1)
  const savedRuleId = (await current.evaluate(() => window.sshHeaven.getLibrary())).tunnelRules[0].id
  await tunnels.getByLabel('Saved tunnel rule', { exact: true }).selectOption(savedRuleId)
  await tunnels.getByLabel(/^Rule name/).fill('Loopback remote')
  await tunnels.getByLabel('Tunnel direction', { exact: true }).selectOption('remote')
  await tunnels.getByRole('button', { name: 'Start tunnel', exact: true }).click()
  await expect(tunnels.getByRole('button', { name: 'Stop tunnel Loopback remote', exact: true })).toBeVisible()
  const remote = (await current.evaluate(() => window.sshHeaven.listTunnels())).find((tunnel) => tunnel.name === 'Loopback remote' && tunnel.status === 'active')!
  assert.equal(await roundTrip(remote.boundPort, 'workspace-remote-forward'), 'workspace-remote-forward')
  assert.notEqual(remote.id, local.id, 'Each running tunnel must retain its own runtime identity')
  await expect.poll(async () => (await current.evaluate(() => window.sshHeaven.getLibrary())).tunnelRules[0]?.name).toBe('Loopback remote')
  const updatedRules = (await current.evaluate(() => window.sshHeaven.getLibrary())).tunnelRules
  assert.equal(updatedRules.length, 1, 'Saving a selected rule must update metadata rather than append a duplicate')
  assert.equal(updatedRules[0].id, savedRuleId)
  assert.equal(updatedRules[0].direction, 'remote')
  await tunnels.getByRole('button', { name: 'Remove saved rule', exact: true }).click()
  await tunnels.getByRole('button', { name: 'Confirm remove rule', exact: true }).click()
  await expect.poll(async () => (await current.evaluate(() => window.sshHeaven.getLibrary())).tunnelRules.length).toBe(0)
  assert.equal((await current.evaluate(() => window.sshHeaven.listTunnels())).filter((tunnel) => tunnel.status === 'active').length, 2, 'Removing saved metadata must preserve active tunnels')
  assert.equal(await roundTrip(remote.boundPort, 'workspace-after-rule-removal'), 'workspace-after-rule-removal')
  await current.screenshot({ path: path.join(root, 'test-results', 'tunnel-manager.png') })
  await tunnels.getByRole('button', { name: 'Stop tunnel Loopback local', exact: true }).click()
  await tunnels.getByRole('button', { name: 'Stop tunnel Loopback remote', exact: true }).click()
  await tunnels.getByRole('button', { name: 'Close dialog', exact: true }).click()

  await typeCommand(current, 'echo never-replay-terminal-input')
  await expect.poll(() => combinedOutput(current)).toContain('never-replay-terminal-input')
  const markersBefore = (await combinedOutput(current)).split('never-replay-terminal-input').length
  const authenticatedBefore = transport.authentications
  transport.disconnectClients()
  await expect.poll(() => transport.authentications, { timeout: 15_000 }).toBeGreaterThan(authenticatedBefore)
  await expect(activePane(current).locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  assert.equal((await combinedOutput(current)).split('never-replay-terminal-input').length, markersBefore, 'Automatic reconnect must not replay terminal input')
  await activePane(current).getByRole('button', { name: 'Disconnect session', exact: true }).click()
  await expect(activePane(current).locator('.terminal-footer').getByText('Disconnected', { exact: true })).toBeVisible()
  const manuallyStopped = transport.authentications
  await current.waitForTimeout(2600)
  assert.equal(transport.authentications, manuallyStopped, 'Manual disconnect must suppress automatic reconnect')

  await app!.evaluate(({ dialog }, privateKeyPath) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [privateKeyPath] })) as typeof dialog.showOpenDialog }, first.privateKeyPath!)
  await current.evaluate(async ({ privateKeyPath, port }) => {
    const chosen = await window.sshHeaven.pickPrivateKey()
    if (chosen !== privateKeyPath) throw new Error('Fixture private key picker returned the wrong path')
    const keyId = crypto.randomUUID()
    await window.sshHeaven.saveLibraryItem('key', { id: keyId, name: 'Workspace fixture key', path: privateKeyPath })
    await window.sshHeaven.saveLibraryItem('group', { id: crypto.randomUUID(), group: 'Defaults QA', username: 'group-admin', port, keyId })
  }, { privateKeyPath: first.privateKeyPath!, port: first.port })
  await current.reload(); await installObservers(current)
  await current.getByRole('tab', { name: 'New connection', exact: true }).click()
  await current.getByLabel(/^Group/).fill('Defaults QA')
  await expect(current.getByLabel('Username', { exact: true })).toHaveValue('group-admin')
  await expect(current.getByLabel('SSH port', { exact: true })).toHaveValue(String(first.port))
  await expect(current.getByRole('button', { name: 'SSH key', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(current.getByLabel('Key library', { exact: true })).not.toHaveValue('')
  await expect(current.locator('.key-picker>span')).toHaveAttribute('title', first.privateKeyPath!)
  await current.getByText('Connection options', { exact: true }).click()
  await current.getByLabel('Jump host', { exact: true }).selectOption(metadata[0].id)
  await current.getByLabel(/^Nickname/).fill('Defaults applied')
  await current.getByLabel('Hostname or IP address', { exact: true }).fill('127.0.0.3')
  await current.getByRole('button', { name: 'Save host', exact: true }).click()
  const applied = (await current.evaluate(() => window.sshHeaven.listProfiles())).find((profile) => profile.name === 'Defaults applied')!
  assert.equal(applied.username, 'group-admin'); assert.equal(applied.privateKeyPath, first.privateKeyPath); assert.equal(applied.jumpHostId, metadata[0].id)
  await current.screenshot({ path: path.join(root, 'test-results', 'group-defaults-applied.png') })
  assert.ok(!(await readFile(path.join(dataDirectory, 'settings.json'), 'utf8')).includes(first.password))
  assert.deepEqual(errors, [])
  console.log('Workspace tools E2E passed: persistent split/grid panes, SFTP/terminal history, saved workspace metadata restore and explicit connect, group/key defaults, tmux, metrics polling, local/remote tunnels, reconnect without input replay, and manual-stop suppression.')
} catch (error) {
  await page?.screenshot({ path: path.join(root, 'test-results', 'workspace-tools-failure.png') }).catch(() => {})
  throw error
} finally {
  if (app) await app.close()
  await first.close(); await second.close(); await transport.close()
  await new Promise<void>((resolve) => echo.close(() => resolve()))
  await rm(temporary, { recursive: true, force: true })
}
