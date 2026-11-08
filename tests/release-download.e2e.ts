import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'

// Standalone post-publication verification, deliberately excluded from the
// packaged regression runner. It downloads real public bytes, never installs.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const baseline = process.env.SSH_HEAVEN_BASELINE_EXECUTABLE
if (!baseline || !(await stat(baseline).catch(() => null))?.isFile()) throw new Error('Set SSH_HEAVEN_BASELINE_EXECUTABLE to the preserved packaged SSH Heaven 0.10.0 executable. Run only after publishing the new stable release.')
const version = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
assert.equal(version, '0.11.0', 'This manual check verifies the real 0.10.0 updater downloading the published 0.11.0 release')
const installer = path.join(root, 'release', `SSH Heaven Setup ${version}.exe`)
const installerMetadata = await stat(installer).catch(() => null)
if (!installerMetadata?.isFile()) throw new Error('Build the current Windows installer before checking its public download.')
async function sha256(filename: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}
const expected = { version, size: installerMetadata.size, sha256: await sha256(installer) }
const endpoint = 'https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest'
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-live-release-download-'))
const directory = path.join(temporary, 'settings'), cache = path.join(directory, 'updates')
await mkdir(directory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
interface DownloadProbe {
  version: string
  packaged: boolean
  downloadAuthorized: boolean
  requests: { kind: 'metadata' | 'installer'; host: string; bytes: number; status?: number; complete?: boolean }[]
  metadataTag?: string
  assetUrl?: string
  assetSize?: number
  assetDigest?: string
  installerAttempts: number
  browserAttempts: number
  visibility: string[]
  violations: string[]
}
let app: ElectronApplication | undefined, page: Page | undefined
const errors: string[] = []
let popups = 0
async function probe(): Promise<DownloadProbe> { return app!.evaluate(() => structuredClone((globalThis as unknown as { releaseDownloadProbe: DownloadProbe }).releaseDownloadProbe)) }
async function hidden(): Promise<void> {
  const result = await app!.evaluate(({ BrowserWindow }) => ({ windows: BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })), events: (globalThis as unknown as { releaseDownloadProbe: DownloadProbe }).releaseDownloadProbe.visibility }))
  assert.ok(result.windows.length > 0 && result.windows.every((window) => !window.visible && !window.focused && window.offscreen), 'Live release QA must stay hidden, unfocused, and offscreen')
  assert.deepEqual(result.events, [])
}
async function cacheFiles(): Promise<string[]> {
  const result: string[] = []
  async function visit(folder: string) {
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const filename = path.join(folder, entry.name)
      if (entry.isDirectory()) await visit(filename)
      else result.push(filename)
    }
  }
  await visit(cache)
  return result
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  app = await _electron.launch({ executablePath: baseline, args: [`--user-data-dir=${directory}`], env, timeout: 30_000 })
  const installed = await app.evaluate(({ app, BrowserWindow, shell }, options) => {
    // tsx emits __name around nested named callbacks. Serialized evaluate
    // bodies run in Electron's main context, not the test module's scope.
    Object.defineProperty(globalThis, '__name', { configurable: true, value: Function('value', 'return value') })
    const https = process.getBuiltinModule('https'), childProcess = process.getBuiltinModule('child_process')
    const originalGet = https.get.bind(https)
    const target = globalThis as unknown as { releaseDownloadProbe: DownloadProbe }
    const result: DownloadProbe = { version: app.getVersion(), packaged: app.isPackaged, downloadAuthorized: false, requests: [], installerAttempts: 0, browserAttempts: 0, visibility: [], violations: [] }
    target.releaseDownloadProbe = result
    for (const window of BrowserWindow.getAllWindows()) { window.on('show', () => result.visibility.push('show')); window.on('focus', () => result.visibility.push('focus')) }
    // This is the sole behavior replacement: neither accidental installation
    // nor browser navigation is permitted, even if the old app regresses.
    const blockedLaunch = () => { result.installerAttempts++; throw new Error('Live download QA prohibits launching child processes or installers') }
    childProcess.spawn = blockedLaunch as typeof childProcess.spawn
    childProcess.execFile = blockedLaunch as unknown as typeof childProcess.execFile
    childProcess.exec = blockedLaunch as unknown as typeof childProcess.exec
    childProcess.fork = blockedLaunch as typeof childProcess.fork
    shell.openExternal = async () => { result.browserAttempts++; throw new Error('Live download QA prohibits opening the browser') }
    const cdn = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'objects-origin.githubusercontent.com', 'github-releases.githubusercontent.com'])
    https.get = ((value: string | URL, request: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const raw = String(value), url = new URL(raw), metadata = raw === options.endpoint
      const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, item]) => [name.toLowerCase(), String(item)]))
      const allowedHeaders = new Set(['accept', 'accept-encoding', 'user-agent', 'x-github-api-version'])
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || request.auth || Object.keys(headers).some((name) => !allowedHeaders.has(name)) || (!metadata && (!result.downloadAuthorized || raw !== result.assetUrl && !cdn.has(url.hostname)))) {
        result.violations.push('An unexpected destination, credential field, or automatic installer request was blocked')
        throw new Error('Live release QA blocked an unexpected HTTPS request')
      }
      const observed: DownloadProbe['requests'][number] = { kind: metadata ? 'metadata' : 'installer', host: url.hostname, bytes: 0 }
      result.requests.push(observed)
      return originalGet(value, request, (response) => {
        observed.status = response.statusCode
        const chunks: Buffer[] = []
        // Never attach a flowing data listener to an installer response: the
        // shipped async iterator must remain its sole consumer. Observe end,
        // then verify actual byte counts and SHA-256 from the native cache.
        if (metadata) response.on('data', (chunk: Buffer) => { observed.bytes += chunk.length; if (observed.bytes <= 64 * 1024) chunks.push(Buffer.from(chunk)) })
        response.once('end', () => { observed.complete = true })
        if (metadata) response.on('end', () => {
          if (observed.status !== 200 || observed.bytes > 64 * 1024) return
          try {
            const release = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tag_name?: string; assets?: { name?: string; size?: number; digest?: string; browser_download_url?: string }[] }
            result.metadataTag = release.tag_name
            const names = new Set([`SSH.Heaven.Setup.${options.version}.exe`, `SSH Heaven Setup ${options.version}.exe`])
            const selected = release.assets?.filter((asset) => names.has(asset.name ?? '')) ?? []
            if (selected.length === 1) { result.assetUrl = selected[0].browser_download_url; result.assetSize = selected[0].size; result.assetDigest = selected[0].digest }
          } catch { /* The shipped native parser reports malformed metadata. */ }
        })
        callback(response)
      })
    }) as typeof https.get
    return { version: result.version, packaged: result.packaged, dataDirectory: app.getPath('userData') }
  }, { endpoint, version })
  assert.equal(installed.version, '0.10.0', 'Use the preserved old updater, not the current build')
  assert.equal(installed.packaged, true)
  assert.equal(path.resolve(installed.dataDirectory), path.resolve(directory), 'The baseline must use isolated settings, never personal app data')
  await hidden()
  page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message)); page.on('popup', () => popups++)
  const initialUrl = page.url()
  await expect.poll(async () => (await page!.evaluate(() => window.sshHeaven.getUpdateState())).status, { timeout: 25_000, message: 'Publish the expected stable release before running the old updater check' }).toBe('available')
  const available = await page.evaluate(() => window.sshHeaven.getUpdateState())
  assert.equal(available.currentVersion, '0.10.0'); assert.equal(available.version, version); assert.equal(available.downloadAvailable, true)
  const before = await probe()
  assert.equal(before.metadataTag, `v${version}`)
  assert.equal(before.assetSize, expected.size)
  assert.equal(before.assetDigest?.toLowerCase(), `sha256:${expected.sha256}`)
  assert.equal(before.requests.length, 1)
  assert.equal(before.requests[0].kind, 'metadata'); assert.equal(before.requests[0].status, 200)
  assert.deepEqual(await cacheFiles(), [], 'Startup metadata discovery must not cache any installer bytes')
  assert.equal(before.installerAttempts, 0); assert.equal(before.browserAttempts, 0); assert.deepEqual(before.violations, [])
  await expect(page.locator('.update-notice')).toContainText(version)
  await app.evaluate(() => { (globalThis as unknown as { releaseDownloadProbe: DownloadProbe }).releaseDownloadProbe.downloadAuthorized = true })
  await page.locator('.update-notice').getByRole('button', { name: 'Download update', exact: true }).click()
  await expect.poll(async () => (await probe()).requests.filter((request) => request.kind === 'installer').length, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect.poll(async () => {
    await hidden()
    return (await page!.evaluate(() => window.sshHeaven.getUpdateState())).status
  }, { timeout: 10 * 60_000 + 15_000, intervals: [100, 250, 500, 1000] }).not.toBe('downloading')
  const downloaded = await page.evaluate(() => window.sshHeaven.getUpdateState())
  assert.equal(downloaded.status, 'downloaded', downloaded.message)
  assert.equal(downloaded.version, version); assert.equal(downloaded.progress, 100)
  assert.equal(downloaded.downloadedBytes, expected.size); assert.equal(downloaded.totalBytes, expected.size)
  await expect(page.locator('.update-notice').getByRole('button', { name: 'Install now', exact: true })).toBeVisible()
  const files = await cacheFiles()
  assert.equal(files.length, 1); assert.ok(files[0].endsWith('.exe'), 'Only the verified ready executable should remain; no .part files')
  assert.equal((await stat(files[0])).size, expected.size)
  assert.equal(await sha256(files[0]), expected.sha256, 'The public installer must match the exact locally built release')
  const after = await probe()
  assert.deepEqual(after.violations, [])
  assert.equal(after.installerAttempts, 0, 'The download check must never execute an installer')
  assert.equal(after.browserAttempts, 0, 'The native downloader must never open a browser')
  assert.equal(after.requests.filter((request) => request.kind === 'metadata').length, 1)
  assert.ok(after.requests.some((request) => request.kind === 'installer' && request.status === 200 && request.complete))
  assert.equal(popups, 0); assert.equal(page.url(), initialUrl); assert.deepEqual(errors, [])
  await hidden()
  await page.screenshot({ path: path.join(root, 'test-results', 'release-download-0.10.0.png') })
  // Deliberately never click Install now. The verified executable is removed
  // only after the old application closes, with its own temporary user data.
  console.log(`Live previous-release download passed: packaged 0.10.0 discovered v${version}, fetched metadata only before the explicit Download click, then downloaded ${expected.size} verified bytes via real GitHub HTTPS. SHA-256 matches the local release; zero installer executions or browser opens; no visible/focused native window.`)
} catch (error) {
  if (page && app) {
    await page.screenshot({ path: path.join(root, 'test-results', 'release-download-failure.png') }).catch(() => {})
    const current = await page.evaluate(() => window.sshHeaven.getUpdateState()).catch(() => null)
    if (current) console.error('Live release download state:', JSON.stringify(current))
  }
  throw error
} finally {
  try { if (app) await hidden() }
  finally { try { await app?.close() } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) } }
}
