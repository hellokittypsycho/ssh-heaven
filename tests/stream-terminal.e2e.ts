import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { channels } from '../electron/channels'
import { findIPRanges } from '../shared/ip-redaction'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-stream-terminal-'))
const dataDirectory = path.join(temporary, 'settings')
await mkdir(dataDirectory); await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture()
let app: ElectronApplication | undefined
let page: Page | undefined
const errors: string[] = []
const ips = ['127.0.0.1', '192.0.2.88', '198.51.100.42', '203.0.113.57', '198.51.100.73', '203.0.113.19', '2001:db8::1234', '198.51.100.121', '2001:db8::abcd']
type Probe = { output: string; statuses: { sessionId: string; status: string }[]; leaks: string[] }
type NativeProbe = { writes: { id: string; data: string }[]; clipboard: string; copies: string[] }
const terminal = () => page!.locator('.ssh-terminal-host .xterm')
const textarea = () => terminal().locator('.xterm-helper-textarea')
const visibleText = () => terminal().locator('.xterm-rows').innerText()
async function rawOutput() { return page!.evaluate(() => (window as unknown as { streamProbe: Probe }).streamProbe.output) }
async function writes() { return app!.evaluate(() => (globalThis as unknown as { streamNative: NativeProbe }).streamNative.writes) }
async function resetWrites(text = '') {
  await app!.evaluate((_electron, value) => { const target = (globalThis as unknown as { streamNative: NativeProbe }).streamNative; target.writes = []; target.clipboard = value }, text)
}
async function command(text: string) {
  await textarea().focus(); await page!.keyboard.type(text); await page!.keyboard.press('Enter')
}
async function pasteShortcut(text: string) {
  await resetWrites(text); await textarea().focus()
  // Model the browser's native default paste if keydown was not canceled. This
  // proves the shortcut cancels that second path without touching OS clipboard.
  await textarea().evaluate((node, value) => {
    const listener: EventListenerObject = { handleEvent(eventValue) {
      const event = eventValue as KeyboardEvent
      if (!event.ctrlKey || !event.shiftKey || event.code !== 'KeyV') return
      node.removeEventListener('keydown', listener, true)
      queueMicrotask(() => {
        if (event.defaultPrevented) return
        const data = new DataTransfer(); data.setData('text/plain', value)
        node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
    } }
    node.addEventListener('keydown', listener, true)
  }, text)
  await page!.keyboard.press('Control+Shift+V')
  await expect.poll(async () => (await writes()).length).toBe(1)
  assert.equal((await writes())[0].data, text)
  await expect.poll(() => rawOutput()).toContain(text)
  await page!.keyboard.press('Enter')
}
async function pasteNative(text: string) {
  await resetWrites(); await textarea().focus()
  await textarea().evaluate((node, value) => {
    const data = new DataTransfer(); data.setData('text/plain', value)
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
  await expect.poll(async () => (await writes()).length).toBe(1)
  assert.equal((await writes())[0].data, text)
  await page!.keyboard.press('Enter')
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  await app.evaluate(({ ipcMain, clipboard }, channel) => {
    const probe: NativeProbe = { writes: [], clipboard: '', copies: [] }
    ;(globalThis as unknown as { streamNative: NativeProbe }).streamNative = probe
    ipcMain.on(channel, (_event, id, data) => probe.writes.push({ id, data }))
    clipboard.readText = async () => probe.clipboard
    clipboard.writeText = async (text) => { probe.copies.push(text); probe.clipboard = text }
  }, channels.write)
  await page.evaluate((addresses) => {
    const probe: Probe = { output: '', statuses: [], leaks: [] }
    ;(window as unknown as { streamProbe: Probe }).streamProbe = probe
    window.sshHeaven.onData(({ data }) => { probe.output += new TextDecoder().decode(data) })
    window.sshHeaven.onStatus((status) => probe.statuses.push(status))
    new MutationObserver(() => {
      if (document.documentElement.dataset.streamMode !== 'true') return
      for (const row of document.querySelectorAll('.ssh-terminal-host .xterm-rows')) {
        if (getComputedStyle(row).visibility === 'hidden') continue
        for (const address of addresses) if (row.textContent?.includes(address)) probe.leaks.push(address)
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
  }, ips)
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  await page.getByLabel(/^Nickname/).fill('Privacy 198.51.100.42')
  await page.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
  await page.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Verify server identity', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click({ force: true })
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  const originalTerminal = await terminal().elementHandle()
  await pasteShortcut('echo PASTE-NORMAL-ONCE')
  await pasteNative('echo NATIVE-NORMAL-ONCE')
  await command('echo 198.51.100.42 2001:db8::1234')
  await expect.poll(() => visibleText()).toContain('198.51.100.42')
  await page.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-stream-mode', 'true')
  await expect(page.locator('.ssh-terminal-host')).toHaveAttribute('data-stream-ready', 'true')
  assert.equal(await originalTerminal!.evaluate((node) => node.isConnected), false, 'The raw DOM must be detached while the masked terminal is visible')
  await expect.poll(() => visibleText()).not.toContain('198.51.100.42')
  assert.deepEqual(findIPRanges(await page.locator('body').innerText()), [], 'Visible application metadata must also mask IP addresses')
  await pasteShortcut('echo PASTE-PRIVATE-ONCE 203.0.113.57')
  await pasteNative('echo NATIVE-PRIVATE-ONCE 198.51.100.42')
  await command('stream-privacy-fixture')
  await expect.poll(() => rawOutput()).toContain('PRIVACY-END')
  await expect.poll(() => visibleText()).toContain('PRIVACY-END')
  assert.deepEqual(findIPRanges(await visibleText()), [])
  await expect(terminal().locator('.xterm-rows')).toContainText('CJK 中文')
  await command('stream-privacy-alt')
  await expect.poll(() => visibleText(), { intervals: [10, 20, 30, 40] }).toContain('ALTERNATE')
  assert.deepEqual(findIPRanges(await visibleText()), [])
  await expect.poll(() => rawOutput()).toContain('PRIVACY-ALT-END')
  await expect.poll(() => visibleText()).toContain('PRIVACY-ALT-END')

  const row = terminal().locator('.xterm-rows>div').filter({ hasText: 'CJK 中文' }).first()
  const rect = await row.boundingBox(); assert.ok(rect)
  await page.mouse.move(rect.x + 1, rect.y + rect.height / 2); await page.mouse.down()
  await page.mouse.move(Math.min(rect.x + 330, rect.x + rect.width - 2), rect.y + rect.height / 2, { steps: 8 }); await page.mouse.up()
  await page.keyboard.press('Control+Shift+C')
  await expect.poll(() => app!.evaluate(() => (globalThis as unknown as { streamNative: NativeProbe }).streamNative.copies.length)).toBe(1)
  const copied = await app.evaluate(() => (globalThis as unknown as { streamNative: NativeProbe }).streamNative.copies[0])
  assert.ok(copied.includes('•')); assert.deepEqual(findIPRanges(copied), [])
  const nativeCopy = await textarea().evaluate((node) => {
    const data = new DataTransfer()
    node.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
    return data.getData('text/plain')
  })
  assert.deepEqual(findIPRanges(nativeCopy), []); assert.ok(nativeCopy.includes('•'))
  await page.getByRole('button', { name: 'Search terminal', exact: true }).click()
  await page.getByLabel('Find in terminal', { exact: true }).fill('192.0.2.88')
  await expect(page.getByLabel('Find in terminal', { exact: true })).toHaveAttribute('type', 'password')
  await expect(page.getByLabel('Terminal search results', { exact: true })).toHaveText('No matches')
  await page.getByLabel('Find in terminal', { exact: true }).fill('•'.repeat('192.0.2.88'.length))
  await expect(page.getByLabel('Terminal search results', { exact: true })).not.toHaveText('No matches')
  await page.getByRole('button', { name: 'Close terminal search', exact: true }).click()
  await terminal().locator('.xterm-viewport').evaluate((node) => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')) })
  await expect.poll(() => visibleText()).toContain('PRIVACY-BEGIN')
  assert.deepEqual(findIPRanges(await visibleText()), [])
  await page.getByRole('button', { name: 'Jump to latest output', exact: true }).click()
  await page.screenshot({ path: path.join(root, 'test-results', 'stream-private-terminal.png') })
  assert.deepEqual(await page.evaluate(() => (window as unknown as { streamProbe: Probe }).streamProbe.leaks), [], 'No visible raw-IP frame may occur during output, cursor edits, alternate screen or toggle')
  await page.getByRole('button', { name: 'Stream mode', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-stream-mode', 'false')
  assert.equal(await originalTerminal!.evaluate((node) => node.isConnected), true, 'Disabling stream mode restores the original canonical terminal')
  await expect.poll(() => visibleText()).toContain('198.51.100.42')
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  assert.equal(await page.evaluate(() => (window as unknown as { streamProbe: Probe }).streamProbe.statuses.filter((status) => status.status === 'connected').length), 1)
  assert.deepEqual(errors, [])
  console.log('Stream terminal E2E passed: display-only IPv4/IPv6 masking across existing/history/live/chunked/styled/wrapped/cursor-edited/alternate output, CJK, sanitized search/copy/native copy, raw input/history preservation, immediate toggle without reconnect, no visible IP flash, and exactly-once custom/native paste in both modes.')
} catch (error) {
  if (page && app) {
    await page.screenshot({ path: path.join(root, 'test-results', 'stream-terminal-failure.png') }).catch(() => {})
    console.error((await page.locator('body').innerText().catch(() => '')).replaceAll(fixture.password, '[REDACTED]').slice(0, 7500))
  }
  throw error
} finally {
  try { await app?.close() }
  finally { try { await fixture.close() } finally { await rm(temporary, { recursive: true, force: true }) } }
}
