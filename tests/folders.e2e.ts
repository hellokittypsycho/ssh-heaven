import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication } from '@playwright/test'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-folders-e2e-'))
const dataDirectory = path.join(temporary, 'settings')
const source = path.join(temporary, 'website')
const downloads = path.join(temporary, 'downloads')
await mkdir(dataDirectory); await mkdir(downloads)
await mkdir(path.join(source, 'assets', 'empty'), { recursive: true })
await mkdir(path.join(root, 'test-results'), { recursive: true })
const payload = randomBytes(176_543)
await writeFile(path.join(source, 'assets', 'data.bin'), payload)
await writeFile(path.join(source, 'index.html'), '<h1>Folder upload</h1>')
const dropped = path.join(temporary, 'dropped.txt')
await writeFile(dropped, 'Native File drag and drop')
const fixture = await startFixture()
let app: ElectronApplication | undefined
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page.getByLabel(/^Nickname/).fill('Folder fixture')
  await page.getByLabel('Hostname or IP address').fill(fixture.host)
  await page.getByLabel('SSH port').fill(String(fixture.port))
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  const files = page.getByRole('complementary', { name: 'Remote files', exact: true })
  await expect(files.locator('.file-list').getByText('welcome.txt', { exact: true })).toBeVisible()
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filename] })) as typeof dialog.showOpenDialog }, source)
  await files.getByRole('button', { name: 'Upload folder', exact: true }).click()
  await expect(files.getByRole('article', { name: 'upload website: completed', exact: true })).toBeVisible()
  await expect(files.locator('.file-list').getByText('website', { exact: true })).toBeVisible()
  assert.deepEqual(await readFile(path.join(fixture.root, 'website', 'assets', 'data.bin')), payload)
  assert.deepEqual(await readdir(path.join(fixture.root, 'website', 'assets', 'empty')), [])

  await files.getByLabel('Select website', { exact: true }).check()
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filename] })) as typeof dialog.showOpenDialog }, downloads)
  await files.getByRole('button', { name: 'Download selected file', exact: true }).click()
  await expect(files.getByRole('article', { name: 'download website: completed', exact: true })).toBeVisible()
  assert.deepEqual(await readFile(path.join(downloads, 'website', 'assets', 'data.bin')), payload)
  assert.deepEqual(await readdir(path.join(downloads, 'website', 'assets', 'empty')), [])

  // A native disk-backed File is required: JS-created Files have no path and
  // must not grant the renderer arbitrary local file access through IPC.
  await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'fixture-drop-file'; input.style.display = 'none'; document.body.append(input) })
  await page.locator('#fixture-drop-file').setInputFiles(dropped)
  const transfer = await page.evaluateHandle(() => { const data = new DataTransfer(); const file = (document.getElementById('fixture-drop-file') as HTMLInputElement).files![0]; data.items.add(file); return data })
  await files.dispatchEvent('dragover', { dataTransfer: transfer })
  await expect(files.getByText('Drop files or folders to upload', { exact: true })).toBeVisible()
  await files.dispatchEvent('drop', { dataTransfer: transfer })
  await expect(files.getByRole('article', { name: 'upload dropped.txt: completed', exact: true })).toBeVisible()
  assert.equal(await readFile(path.join(fixture.root, 'dropped.txt'), 'utf8'), 'Native File drag and drop')
  await page.evaluate(async () => {
    let rejected = false
    try { await window.sshHeaven.uploadDropped('missing-session', '/', [new File(['data'], 'fake.txt')]) } catch { rejected = true }
    if (!rejected) throw new Error('A synthetic File must not expose arbitrary disk paths')
  })

  const vanished = path.join(temporary, 'vanishing.txt')
  await app.evaluate(({ dialog }, filename) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [filename] })) as typeof dialog.showOpenDialog }, vanished)
  await files.getByRole('button', { name: 'Upload files', exact: true }).click()
  await expect(files.getByRole('article', { name: 'upload vanishing.txt: failed', exact: true })).toBeVisible()
  await writeFile(vanished, 'Recovered transfer')
  await files.getByRole('button', { name: 'Retry transfer vanishing.txt', exact: true }).click()
  await expect(files.getByRole('article', { name: 'upload vanishing.txt: completed', exact: true })).toBeVisible()
  await expect(files.locator('.file-list').getByText('vanishing.txt', { exact: true })).toBeVisible()
  assert.equal(await readFile(path.join(fixture.root, 'vanishing.txt'), 'utf8'), 'Recovered transfer')
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(root, 'test-results', 'folder-transfers.png') })
  console.log('Folder E2E passed: recursive binary/empty-directory transfers, real disk-backed drag/drop, synthetic-file rejection, failed-job retry, and refreshed file listing.')
} catch (error) {
  if (app) await (await app.firstWindow()).screenshot({ path: path.join(root, 'test-results', 'folders-failure.png') }).catch(() => {})
  throw error
} finally {
  await app?.close()
  await fixture.close()
  await rm(temporary, { recursive: true, force: true })
}
