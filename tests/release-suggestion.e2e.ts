import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import type { IncomingMessage, RequestOptions } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'

// Manual release verification only. Run after publishing the new stable tag;
// this deliberately uses the old application and the real public GitHub API.
// It is not part of the packaged regression runner and never runs an installer.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const executable = process.env.SSH_HEAVEN_BASELINE_EXECUTABLE
if (!executable || !(await stat(executable).catch(() => null))?.isFile()) throw new Error('Set SSH_HEAVEN_BASELINE_EXECUTABLE to the preserved packaged SSH Heaven 0.8.1 executable. Run this manual check only after publishing the new release.')
const expectedVersion = (JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
assert.equal(expectedVersion, '0.9.0', 'This release check verifies the published 0.9.0 suggestion in the preserved 0.8.1 app')
const endpoint = 'https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest'
const downloadPage = 'https://github.com/hellokittypsycho/ssh-heaven/releases/latest'
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-release-suggestion-'))
const directory = path.join(temporary, 'settings')
await mkdir(directory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
interface ReleaseProbe {
  version: string
  packaged: boolean
  requests: { url: string; headers: Record<string, string>; at: number }[]
  responses: { status: number; bytes: number; tag?: string; draft?: boolean; prerelease?: boolean }[]
  opened: string[]
  violations: string[]
  visibility: string[]
}
let app: ElectronApplication | undefined
let page: Page | undefined
const rendererErrors: string[] = []
let popupCount = 0
async function probe(): Promise<ReleaseProbe> {
  return app!.evaluate(() => structuredClone((globalThis as unknown as { releaseSuggestionProbe: ReleaseProbe }).releaseSuggestionProbe))
}
async function hidden(): Promise<void> {
  const state = await app!.evaluate(({ BrowserWindow }) => ({
    windows: BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen() })),
    events: (globalThis as unknown as { releaseSuggestionProbe: ReleaseProbe }).releaseSuggestionProbe.visibility,
  }))
  assert.ok(state.windows.length > 0 && state.windows.every((window) => !window.visible && !window.focused && window.offscreen), 'Release QA must stay hidden, unfocused, and offscreen')
  assert.deepEqual(state.events, [], 'Release QA must never show or focus a native window')
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  env.SSH_HEAVEN_BACKGROUND_TEST = '1'
  const launchedAt = Date.now()
  app = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${directory}`], env, timeout: 30_000 })
  // Install ahead of the shipped five-second timer. The original HTTPS method,
  // live response bytes, native parser, and packaged release configuration all
  // remain real. Only the user-triggered browser open is intercepted.
  const installed = await app.evaluate(({ app, BrowserWindow, shell }, allowedEndpoint) => {
    const https = process.getBuiltinModule('https')
    const originalGet = https.get.bind(https)
    const target = globalThis as unknown as { releaseSuggestionProbe: ReleaseProbe }
    const result: ReleaseProbe = { version: app.getVersion(), packaged: app.isPackaged, requests: [], responses: [], opened: [], violations: [], visibility: [] }
    target.releaseSuggestionProbe = result
    for (const window of BrowserWindow.getAllWindows()) {
      window.on('show', () => result.visibility.push('show'))
      window.on('focus', () => result.visibility.push('focus'))
    }
    https.get = ((url: string | URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      const requestedUrl = String(url)
      const headers = Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]))
      const allowedHeaders = new Set(['accept', 'accept-encoding', 'user-agent', 'x-github-api-version'])
      if (requestedUrl !== allowedEndpoint || options.auth || Object.keys(headers).some((name) => !allowedHeaders.has(name))) {
        result.violations.push('A request attempted an unexpected destination or credential/header field')
        throw new Error('Release QA blocked an unexpected network request')
      }
      result.requests.push({ url: requestedUrl, headers, at: Date.now() })
      return originalGet(url, options, (response) => {
        const observed: ReleaseProbe['responses'][number] = { status: response.statusCode ?? 0, bytes: 0 }
        const chunks: Buffer[] = []
        result.responses.push(observed)
        response.on('data', (chunk: Buffer) => {
          observed.bytes += chunk.length
          if (observed.bytes <= 64 * 1024) chunks.push(Buffer.from(chunk))
        })
        response.on('end', () => {
          if (observed.bytes > 64 * 1024) return
          try {
            const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown }
            if (typeof metadata.tag_name === 'string' && /^v?\d+\.\d+\.\d+$/.test(metadata.tag_name)) observed.tag = metadata.tag_name
            if (typeof metadata.draft === 'boolean') observed.draft = metadata.draft
            if (typeof metadata.prerelease === 'boolean') observed.prerelease = metadata.prerelease
          } catch { /* The real native parser reports malformed responses. */ }
        })
        callback(response)
      })
    }) as typeof https.get
    shell.openExternal = async (url) => { result.opened.push(url) }
    return { version: result.version, packaged: result.packaged }
  }, endpoint)
  assert.equal(installed.version, '0.8.1', 'The baseline must be the old published app, not the current development or packaged build')
  assert.equal(installed.packaged, true)
  await hidden()
  page = await app.firstWindow()
  page.on('pageerror', (error) => rendererErrors.push(error.message))
  page.on('popup', () => popupCount++)
  const rendererUrl = page.url()
  await expect.poll(async () => {
    await hidden()
    return (await page!.evaluate(() => window.sshHeaven.getUpdateState())).status
  }, { timeout: 25_000, message: 'The old app must discover the newly published stable release through its real startup check' }).toBe('available')
  const state = await page.evaluate(() => window.sshHeaven.getUpdateState())
  assert.equal(state.currentVersion, '0.8.1')
  assert.equal(state.version, expectedVersion, 'Publish and mark the expected stable release latest before running this check')
  const before = await probe()
  assert.deepEqual(before.violations, [])
  assert.equal(before.requests.length, 1, 'Only the real delayed startup metadata check should run')
  assert.equal(before.requests[0].url, endpoint)
  assert.ok(before.requests[0].at - launchedAt >= 4500, 'The shipped five-second startup delay must remain active')
  assert.deepEqual(before.requests[0].headers, { accept: 'application/vnd.github+json', 'accept-encoding': 'identity', 'user-agent': 'SSH-Heaven-Update-Check', 'x-github-api-version': '2026-03-10' })
  assert.equal(before.responses.length, 1)
  assert.equal(before.responses[0].status, 200)
  assert.ok(before.responses[0].bytes > 0 && before.responses[0].bytes <= 64 * 1024)
  assert.equal(before.responses[0].tag, `v${expectedVersion}`)
  assert.equal(before.responses[0].draft, false)
  assert.equal(before.responses[0].prerelease, false)
  assert.deepEqual(before.opened, [], 'Discovering a release must not open a browser or download an installer')
  const notice = page.locator('.update-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText(`SSH Heaven ${expectedVersion} is available.`)
  const bounds = await notice.boundingBox()
  assert.ok(bounds && bounds.width > 100 && bounds.height >= 20, 'The old app must show a readable update banner')
  await page.screenshot({ path: path.join(root, 'test-results', 'release-suggestion-0.8.1.png') })
  await notice.getByRole('button', { name: 'Update available', exact: true }).click()
  assert.deepEqual((await probe()).opened, [downloadPage], 'Only an explicit click may request the fixed GitHub release page; the test intercepts it')
  assert.equal((await probe()).requests.length, 1, 'Clicking the suggestion must not fetch an installer or issue another API check')
  assert.equal(page.url(), rendererUrl)
  assert.equal(popupCount, 0)
  assert.deepEqual(rendererErrors, [])
  await hidden()
  console.log(`Published release suggestion passed: preserved packaged 0.8.1 discovered v${expectedVersion} from the real public GitHub startup response; one metadata request, no credentials, no automatic browser/download/install, fixed page recorded only after a renderer click, and no visible/focused native window.`)
} catch (error) {
  if (app && page) {
    await page.screenshot({ path: path.join(root, 'test-results', 'release-suggestion-failure.png') }).catch(() => {})
    const state = await page.evaluate(() => window.sshHeaven.getUpdateState()).catch(() => null)
    if (state) console.error('Release suggestion state:', JSON.stringify(state))
  }
  throw error
} finally {
  try { if (app) await hidden() }
  finally { try { await app?.close() } finally { await rm(temporary, { recursive: true, force: true }) } }
}
