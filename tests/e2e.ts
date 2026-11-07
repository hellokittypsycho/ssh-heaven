import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication } from '@playwright/test'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-e2e-'))
const dataDirectory = path.join(temporary, 'settings')
const downloads = path.join(temporary, 'downloads')
await mkdir(dataDirectory)
await mkdir(downloads)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture({ ioDelayMs: 12 })
await writeFile(path.join(fixture.root, '.hidden-test'), 'Hidden fixture file')
await writeFile(path.join(fixture.root, 'alpha.txt'), 'Second file')
let app: ElectronApplication | undefined

try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const packagedExecutable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({
    executablePath: packagedExecutable || require('electron') as string,
    args: [...(packagedExecutable ? [] : [root]), `--user-data-dir=${dataDirectory}`],
    env,
    timeout: 30_000
  })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Connection sessions', exact: true })).toHaveCount(0)
  await expect(page.getByRole('tab')).toHaveCount(0)
  await page.screenshot({ path: path.join(root, 'test-results', 'home-empty.png') })
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'New connection', exact: true })).toBeVisible()
  await page.screenshot({ path: path.join(root, 'test-results', 'welcome.png') })
  const appWindow = await app.browserWindow(page)
  await appWindow.evaluate((browserWindow) => browserWindow.setSize(1024, 720))
  await page.getByRole('button', { name: 'Connect', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeInViewport()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'The minimum desktop size must not overflow horizontally')
  await page.screenshot({ path: path.join(root, 'test-results', 'compact.png') })
  await appWindow.evaluate((browserWindow) => browserWindow.setSize(1440, 920))

  // Collect output through the public transport while exercising actual terminal keyboard input.
  await page.evaluate(() => {
    const target = window as unknown as { testOutput: string; testDecoder: TextDecoder; testTransfers: { name: string; transferred: number; status: string }[] }
    target.testOutput = ''
    target.testDecoder = new TextDecoder()
    target.testTransfers = []
    window.sshHeaven.onData(({ data }) => {
      target.testOutput += target.testDecoder.decode(new Uint8Array(data), { stream: true })
    })
    window.sshHeaven.onTransfer((job) => target.testTransfers.push(job))
  })
  await page.getByLabel(/^Nickname/).fill('Local integration')
  await page.getByLabel(/^Group/).fill('Development')
  await page.getByLabel('Hostname or IP address').fill(fixture.host)
  await page.getByLabel('SSH port').fill(String(fixture.port))
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Verify server identity' })).toBeVisible()
  await expect(page.locator('.fingerprint-card code')).toContainText('SHA256:')
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  await expect(page.getByRole('tablist', { name: 'Connection sessions', exact: true }).getByRole('tab')).toHaveCount(1)
  await expect(page.getByRole('tab', { name: 'Local integration', exact: true })).toHaveAttribute('aria-selected', 'true')

  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('echo electron-terminal-verified')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { testOutput: string }).testOutput)).toContain('\r\nelectron-terminal-verified\r\n')

  await page.keyboard.press('Control+Shift+F')
  await page.getByLabel('Find in terminal', { exact: true }).fill('electron-terminal-verified')
  await expect(page.getByLabel('Terminal search results', { exact: true })).toContainText(/of [1-9]/)
  await page.getByRole('button', { name: 'Next terminal match', exact: true }).click()
  await page.getByLabel('Find in terminal', { exact: true }).fill('no-such-search-result-99382')
  await expect(page.getByLabel('Terminal search results', { exact: true })).toContainText('No matches')
  await page.getByLabel('Find in terminal', { exact: true }).press('Escape')
  await page.getByRole('button', { name: 'Increase terminal font size', exact: true }).click()
  await expect(page.getByLabel('Terminal font size', { exact: true })).toHaveText('14px')
  await page.getByRole('button', { name: 'Reset terminal font size', exact: true }).click()

  await page.getByRole('button', { name: 'Favorite Local integration', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unfavorite Local integration', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: /^Favorites/ }).click()
  await expect(page.getByTitle('Connect to Local integration', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^All hosts/ }).click()

  const files = page.getByRole('complementary', { name: 'Remote files', exact: true })
  await expect(files.locator('.file-list').getByText('welcome.txt', { exact: true })).toBeVisible()
  await expect(files.locator('.file-list').getByText('documents', { exact: true })).toBeVisible()
  await expect(files.locator('.file-list').getByText('.hidden-test', { exact: true })).toHaveCount(0)
  await files.getByRole('button', { name: 'Show hidden files', exact: true }).click()
  await expect(files.locator('.file-list').getByText('.hidden-test', { exact: true })).toBeVisible()
  await files.getByRole('button', { name: 'Show hidden files', exact: true }).click()
  await files.getByLabel('Filter remote files', { exact: true }).fill('welcome')
  await expect(files.getByRole('option')).toHaveCount(1)
  await files.getByLabel('Filter remote files', { exact: true }).clear()
  await files.getByRole('button', { name: 'Sort files by size', exact: true }).click()
  await files.getByRole('button', { name: 'Sort files by size', exact: true }).click()
  assert.deepEqual(await files.locator('.sftp-entry-name').allTextContents(), ['documents', 'welcome.txt', 'alpha.txt'])
  await files.getByRole('button', { name: 'Sort files by name', exact: true }).click()
  const fileWidth = (await files.boundingBox())!.width
  await files.getByRole('separator', { name: 'Resize file browser' }).focus()
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await files.boundingBox())!.width).toBeGreaterThan(fileWidth)
  await files.locator('.file-list').getByText('documents', { exact: true }).dblclick()
  await expect(files.getByLabel('Remote path', { exact: true })).toHaveValue('/documents')
  await expect(files.locator('.file-list').getByText('notes.txt', { exact: true })).toBeVisible()
  await files.getByRole('button', { name: 'Parent folder', exact: true }).click()
  await expect(files.getByLabel('Remote path', { exact: true })).toHaveValue('/')

  await files.getByRole('button', { name: 'New remote folder' }).click()
  await page.getByLabel('Folder name', { exact: true }).fill(' .. ')
  await page.getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect(page.getByText('Enter a name without slashes or parent-directory references.', { exact: true }).last()).toBeVisible()
  await page.getByLabel('Folder name', { exact: true }).fill('e2e-folder')
  await page.getByRole('button', { name: 'Create folder', exact: true }).click()
  await expect(files.locator('.file-list').getByText('e2e-folder', { exact: true })).toBeVisible()
  await files.locator('.file-list').getByText('e2e-folder', { exact: true }).click()
  await files.getByRole('button', { name: 'Rename selected item' }).click()
  await page.getByLabel('New name', { exact: true }).fill('e2e-renamed')
  await page.getByRole('button', { name: 'Rename', exact: true }).click()
  await expect(files.locator('.file-list').getByText('e2e-renamed', { exact: true })).toBeVisible()
  await files.locator('.file-list').getByText('e2e-renamed', { exact: true }).click()
  await files.getByRole('button', { name: 'Delete selected item' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(files.locator('.file-list').getByText('e2e-renamed', { exact: true })).toHaveCount(0)

  const upload = path.join(temporary, 'e2e-upload.txt')
  const payload = 'SSH Heaven upload and download \u2601\n'.repeat(4000)
  await writeFile(upload, payload)
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
  }, upload)
  await files.getByRole('button', { name: 'Upload files', exact: true }).click()
  await expect(files.locator('.file-list').getByText('e2e-upload.txt', { exact: true })).toBeVisible()
  assert.equal(await readFile(path.join(fixture.root, 'e2e-upload.txt'), 'utf8'), payload)

  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as typeof dialog.showOpenDialog
  }, downloads)
  await files.locator('.file-list').getByText('e2e-upload.txt', { exact: true }).click()
  await files.getByRole('button', { name: 'Download selected file' }).click()
  await expect(files.getByRole('status')).toContainText('1 file downloaded')
  assert.equal(await readFile(path.join(downloads, 'e2e-upload.txt'), 'utf8'), payload)

  await app.evaluate(({ dialog }) => { dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox })
  await files.getByLabel('Select welcome.txt', { exact: true }).check()
  await files.getByRole('button', { name: 'Download selected file' }).click()
  await expect(files.getByRole('status')).toContainText('2 files downloaded')
  assert.equal(await readFile(path.join(downloads, 'welcome.txt'), 'utf8'), await readFile(path.join(fixture.root, 'welcome.txt'), 'utf8'))
  await files.getByLabel('Select welcome.txt', { exact: true }).uncheck()

  // Queued and in-flight jobs can both be canceled without losing the SSH session.
  const largeUpload = path.join(temporary, 'cancel-running.bin')
  const queuedUpload = path.join(temporary, 'cancel-queued.bin')
  await writeFile(largeUpload, Buffer.alloc(6 * 1024 * 1024, 0x61))
  await writeFile(queuedUpload, Buffer.alloc(1024, 0x62))
  await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog }, [largeUpload, queuedUpload])
  await files.getByRole('button', { name: 'Upload files', exact: true }).click()
  await files.getByRole('button', { name: 'Cancel transfer cancel-queued.bin', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { testTransfers: { name: string; transferred: number; status: string }[] }).testTransfers.some((job) => job.name === 'cancel-running.bin' && job.transferred >= 65536 && job.status === 'running'))).toBe(true)
  await page.screenshot({ path: path.join(root, 'test-results', 'transfers.png') })
  await files.getByRole('button', { name: 'Cancel transfer cancel-running.bin', exact: true }).click()
  await expect(files.getByRole('article', { name: 'upload cancel-running.bin: canceled', exact: true })).toBeVisible()
  await expect(files.getByRole('article', { name: 'upload cancel-queued.bin: canceled', exact: true })).toBeVisible()
  const remoteAfterCancel = await readdir(fixture.root)
  assert.ok(!remoteAfterCancel.some((name) => name.endsWith('.part') || name.startsWith('cancel-')))
  await appWindow.evaluate((browserWindow) => browserWindow.setSize(1024, 720))
  const compactPanel = (await files.boundingBox())!
  const compactTransfers = (await files.getByRole('region', { name: 'File transfers', exact: true }).boundingBox())!
  assert.ok(compactTransfers.y + compactTransfers.height <= compactPanel.y + compactPanel.height + 1, 'Compact file browser must keep the transfer controls inside its panel')
  await page.screenshot({ path: path.join(root, 'test-results', 'compact-workspace.png') })
  await appWindow.evaluate((browserWindow) => browserWindow.setSize(1440, 920))

  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [directory] })) as typeof dialog.showOpenDialog }, downloads)

  // A canceled overwrite must preserve the existing local file.
  await writeFile(path.join(downloads, 'e2e-upload.txt'), 'keep existing')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox
  })
  await files.getByRole('button', { name: 'Download selected file' }).click()
  await expect(files.getByRole('button', { name: 'Download selected file' })).toBeEnabled()
  assert.equal(await readFile(path.join(downloads, 'e2e-upload.txt'), 'utf8'), 'keep existing')
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
  })
  await files.getByRole('button', { name: 'Download selected file' }).click()
  await expect(files.getByRole('status')).toContainText('1 file downloaded')
  assert.equal(await readFile(path.join(downloads, 'e2e-upload.txt'), 'utf8'), payload)

  // Exercise clipboard IPC without replacing the user's actual clipboard.
  await app.evaluate(({ clipboard }) => {
    let content = ''
    clipboard.writeText = async (value) => { content = value }
    clipboard.readText = async () => content
  })
  await page.evaluate(async () => {
    await window.sshHeaven.writeClipboard('ssh-heaven-clipboard-test')
    if (await window.sshHeaven.readClipboard() !== 'ssh-heaven-clipboard-test') throw new Error('Clipboard mismatch')
  })
  await files.getByRole('button', { name: 'Clear finished transfers', exact: true }).click()
  await files.getByRole('button', { name: 'Download selected file', exact: true }).click()
  await expect(files.getByRole('status')).toContainText('1 file downloaded')
  const notification = page.getByRole('button', { name: 'Dismiss notification', exact: true })
  if (await notification.count()) await notification.click()
  await page.screenshot({ path: path.join(root, 'test-results', 'connected.png') })
  const metadata = await readFile(path.join(dataDirectory, 'settings.json'), 'utf8')
  assert.ok(metadata.includes('Local integration'))
  assert.ok(!metadata.includes(fixture.password), 'Password must not be persisted')
  assert.ok(metadata.includes('SHA256:'), 'Trusted host fingerprint must be remembered')
  assert.ok(metadata.includes('Development'), 'Host groups must persist')
  assert.equal(JSON.parse(metadata).profiles[0].favorite, true, 'Favorites must persist')

  // Sidebar navigation back from an SSH tab preserves the unfinished draft.
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page.getByLabel('Hostname or IP address').fill('unfinished.example')
  await page.getByLabel('Username', { exact: true }).fill('unfinished-user')
  await page.getByRole('tab', { name: 'Local integration', exact: true }).click()
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await expect(page.getByLabel('Hostname or IP address')).toHaveValue('unfinished.example')
  await expect(page.getByLabel('Username', { exact: true })).toHaveValue('unfinished-user')

  // Open a second session to a remembered host; the previous terminal remains mounted.
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Search hosts and actions', exact: true }).fill('Development')
  await expect(page.getByRole('option', { name: /Local integration/ })).toBeVisible()
  await page.screenshot({ path: path.join(root, 'test-results', 'command-palette.png') })
  await page.getByRole('combobox', { name: 'Search hosts and actions', exact: true }).press('Enter')
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('status', { name: 'SSH session summary', exact: true })).toHaveText('2 online')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.locator('.session-workspace:not(.hidden-workspace) .xterm-helper-textarea').focus()
  await page.keyboard.type('echo second-session-verified')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { testOutput: string }).testOutput)).toContain('\r\nsecond-session-verified\r\n')
  await page.keyboard.press('Control+w')
  await expect(page.getByRole('dialog', { name: 'Close this session?', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Keep open', exact: true }).click()
  await expect(page.getByRole('status', { name: 'SSH session summary', exact: true })).toHaveText('2 online')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(page.getByRole('tab', { name: 'Local integration', exact: true }).first()).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Control+Tab')
  await expect(page.getByRole('tab', { name: 'Local integration', exact: true }).nth(1)).toHaveAttribute('aria-selected', 'true')
  await page.locator('.session-workspace.is-active-pane').getByRole('button', { name: 'Disconnect session', exact: true }).click()
  await expect(page.locator('.session-workspace:not(.hidden-workspace)').getByText('Session disconnected', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Local integration', exact: true }).first().click()

  await page.locator('.session-workspace.is-active-pane').getByRole('button', { name: 'Disconnect session', exact: true }).click()
  await expect(page.locator('.session-workspace:not(.hidden-workspace)').getByText('Session disconnected', { exact: true })).toBeVisible()
  assert.deepEqual(errors, [], `Renderer exceptions: ${errors.join(', ')}`)
  console.log('Electron E2E passed: host trust, terminal search/font controls, favorites/groups, command palette, SFTP sort/filter/hidden files, resize, multi-file download, queued/running cancellation, overwrite protection, clipboard, draft preservation, multiple sessions, disconnect.')
} catch (error) {
  if (app) {
    const page = await app.firstWindow().catch(() => undefined)
    await page?.screenshot({ path: path.join(root, 'test-results', 'failure.png') }).catch(() => {})
    if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 6000))
  }
  throw error
} finally {
  await app?.close()
  await fixture.close()
  await rm(temporary, { recursive: true, force: true })
}
