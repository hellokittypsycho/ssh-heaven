import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-input-latency-'))
const dataDirectory = path.join(temporary, 'settings')
const results = path.join(root, 'test-results')
await mkdir(dataDirectory); await mkdir(results, { recursive: true })
const fixture = await startFixture()
const baseline = process.env.SSH_HEAVEN_LATENCY_BASELINE === '1'
const background = process.env.SSH_HEAVEN_BACKGROUND_TEST === '1'
const errors: string[] = []
let app: ElectronApplication | undefined
let page: Page | undefined
let phase = 'preparing fixtures'
function progress(value: string): void { phase = value; console.log(`[input-latency] ${value}`) }
const watchdog = setTimeout(() => {
  console.error(`[input-latency] 90-second test deadline exceeded during: ${phase}`)
  // Only this isolated test's own Electron process is terminated.
  app?.process().kill()
}, 90_000)
watchdog.unref()

interface Sample { key: string; suffix: string; before: string; started?: number; echoed?: number; rendered?: number; trusted?: boolean; offset: number }
interface Probe {
  output: string
  sessionId: string
  samples: Sample[]
  pending?: Sample
  burst?: { output: string; events: number; expected: string; started: number; finished?: number }
  row: () => string
}
type ProbeWindow = Window & { latencyProbe: Probe }
function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], maximum: sorted.at(-1)!, samples: values }
}
async function clearPrompt(current: Page): Promise<void> {
  const offset = await current.evaluate(() => (window as unknown as ProbeWindow).latencyProbe.output.length)
  await current.locator('.session-workspace:not(.hidden-workspace) .xterm-helper-textarea').focus()
  await current.keyboard.press('Control+c')
  await current.waitForFunction((after) => {
    const output = (window as unknown as ProbeWindow).latencyProbe.output.slice(after)
    return output.includes('^C\r\n') && output.endsWith('$ ')
  }, offset)
}
async function measureKeys(current: Page, keys: string): Promise<Sample[]> {
  let suffix = ''
  const measured: Sample[] = []
  for (const key of keys) {
    suffix += key
    await current.evaluate(({ key, suffix }) => {
      const probe = (window as unknown as ProbeWindow).latencyProbe
      probe.pending = { key, suffix, offset: probe.output.length, before: probe.row() }
    }, { key, suffix })
    // Playwright's real CDP keyboard path produces trusted keydown/input events.
    await current.keyboard.press(key)
    await current.waitForFunction(() => {
      const sample = (window as unknown as ProbeWindow).latencyProbe.pending
      return sample?.started !== undefined && sample.echoed !== undefined && sample.rendered !== undefined
    }, undefined, { timeout: 5000 })
    measured.push(await current.evaluate(() => {
      const probe = (window as unknown as ProbeWindow).latencyProbe
      const sample = { ...probe.pending! }
      probe.samples.push(sample)
      probe.pending = undefined
      return sample
    }))
  }
  return measured
}

try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  progress('launching isolated Electron')
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(12_000)
  page.setDefaultNavigationTimeout(15_000)
  progress('checking renderer and background frame scheduling')
  console.log('[input-latency] native rendering state', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({ visible: window.isVisible(), focused: window.isFocused(), offscreen: window.webContents.isOffscreen(), painting: window.webContents.isOffscreen() ? window.webContents.isPainting() : null, frameRate: window.webContents.isOffscreen() ? window.webContents.getFrameRate() : null, throttling: window.webContents.getBackgroundThrottling() }))))
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.getByRole('button', { name: 'Open home', exact: true })).toBeVisible()
  const frameProbe = await page.evaluate(async () => {
    const started = performance.now()
    let deadline: ReturnType<typeof setTimeout> | undefined
    const frames = await Promise.race([
      new Promise<number[]>((resolve) => requestAnimationFrame((one) => requestAnimationFrame((two) => requestAnimationFrame((three) => resolve([one - started, two - one, three - two]))))),
      new Promise<null>((resolve) => { deadline = setTimeout(() => resolve(null), 1800) })
    ])
    if (deadline) clearTimeout(deadline)
    return { frames, visibility: document.visibilityState, focused: document.hasFocus(), readyState: document.readyState }
  })
  console.log('[input-latency] renderer frame heartbeat', frameProbe)
  assert.ok(frameProbe.frames && frameProbe.frames.slice(1).every((delay) => delay < 250), 'the test renderer is not producing interactive frames; configure offscreen background rendering before benchmarking')
  await page.evaluate(() => {
    const probe: Probe = { output: '', sessionId: '', samples: [], row: String }
    ;(window as unknown as ProbeWindow).latencyProbe = probe
    const decoder = new TextDecoder()
    window.sshHeaven.onStatus((event) => { if (event.status === 'connected') probe.sessionId = event.sessionId })
    window.sshHeaven.onData(({ sessionId, data }) => {
      if (probe.sessionId && probe.sessionId !== sessionId) return
      const text = decoder.decode(data, { stream: true })
      const now = performance.now()
      probe.output += text
      if (probe.pending?.started !== undefined && probe.pending.echoed === undefined && probe.output.slice(probe.pending.offset).includes(probe.pending.key)) probe.pending.echoed = now
      if (probe.burst) {
        probe.burst.events++
        probe.burst.output += text
        if (probe.burst.output === probe.burst.expected) probe.burst.finished = now
      }
    })
    window.addEventListener('keydown', (event) => {
      const sample = probe.pending
      if (!sample || sample.started !== undefined || event.key !== sample.key || event.ctrlKey || event.altKey || event.metaKey) return
      if (!(event.target instanceof HTMLTextAreaElement) || !event.target.classList.contains('xterm-helper-textarea')) return
      sample.started = performance.now()
      sample.trusted = event.isTrusted
    }, true)
  })
  await page.getByRole('navigation', { name: 'Workspace navigation', exact: true }).getByRole('button', { name: 'New connection', exact: true }).click()
  progress('connecting local SSH fixture')
  await page.getByLabel(/^Nickname/).fill('Latency fixture')
  await page.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
  await page.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
  await page.getByLabel('Username', { exact: true }).fill(fixture.username)
  await page.getByLabel('Password', { exact: true }).fill(fixture.password)
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(page.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  const terminal = page.locator('.session-workspace:not(.hidden-workspace) .xterm-helper-textarea')
  await terminal.focus()
  await expect(page.locator('.session-workspace:not(.hidden-workspace) .xterm-rows')).toBeVisible()
  await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).latencyProbe
    const rows = document.querySelector('.session-workspace:not(.hidden-workspace) .xterm-rows')!
    probe.row = () => Array.from(rows.children).map((node) => node.textContent?.replace(/\u00a0/g, ' ').trimEnd() ?? '').filter(Boolean).at(-1) ?? ''
    new MutationObserver(() => {
      const sample = probe.pending
      if (sample?.started === undefined || sample.rendered !== undefined) return
      const current = probe.row()
      if (current !== sample.before && current.endsWith(sample.suffix)) sample.rendered = performance.now()
    }).observe(rows, { subtree: true, childList: true, characterData: true })
  })
  // Warm up xterm/font rendering and keep measured timestamps inside renderer,
  // excluding Playwright command transport/polling overhead.
  await measureKeys(page, 'warmup')
  await clearPrompt(page)
  progress('measuring trusted keyboard input before burst')
  const before = await measureKeys(page, 'abcdefghijklmnopqrstuvwx')
  await clearPrompt(page)
  progress('measuring 2000-byte output burst')
  const burst = 'aBcDeF0123456789'.repeat(134).slice(0, 2000)
  await page.evaluate((expected) => {
    const probe = (window as unknown as ProbeWindow).latencyProbe
    probe.burst = { output: '', events: 0, expected, started: performance.now() }
    window.sshHeaven.write(probe.sessionId, expected)
  }, burst)
  await page.waitForFunction(() => (window as unknown as ProbeWindow).latencyProbe.burst?.finished !== undefined, undefined, { timeout: 10_000 })
  const burstResult = await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).latencyProbe
    const result = { ...probe.burst! }
    probe.burst = undefined
    return result
  })
  assert.equal(burstResult.output, burst, 'small packet coalescing must retain every byte in order')
  await clearPrompt(page)
  progress('measuring trusted keyboard input after burst')
  const after = await measureKeys(page, 'zyxwvutsrqponmlkjihgfedc')
  const all = [...before, ...after]
  assert.ok(all.every((sample) => sample.trusted), 'all measurements must start with trusted keyboard input')
  assert.ok(all.every((sample) => sample.echoed! >= sample.started!), 'the remote echo must follow the real key event')
  assert.ok(all.every((sample) => sample.rendered! >= sample.started!), 'the visible terminal update must follow the real key event')
  const summary = {
    version: await app.evaluate(({ app }) => app.getVersion()), baseline, background, frameProbe,
    echo: statistics(all.map((sample) => sample.echoed! - sample.started!)),
    rendered: statistics(all.map((sample) => sample.rendered! - sample.started!)),
    afterBurstRendered: statistics(after.map((sample) => sample.rendered! - sample.started!)),
    burst: { bytes: burst.length, callbacks: burstResult.events, elapsedMs: burstResult.finished! - burstResult.started }
  }
  await writeFile(path.join(results, baseline ? 'input-latency.baseline.json' : 'input-latency.json'), JSON.stringify(summary, null, 2))
  console.log(`Input latency diagnostics: echo median ${summary.echo.median.toFixed(2)}ms / p95 ${summary.echo.p95.toFixed(2)}ms; rendered median ${summary.rendered.median.toFixed(2)}ms / p95 ${summary.rendered.p95.toFixed(2)}ms; 2000-byte burst ${summary.burst.callbacks} callbacks in ${summary.burst.elapsedMs.toFixed(2)}ms; after-burst render p95 ${summary.afterBurstRendered.p95.toFixed(2)}ms.`)
  // Broad enough for compositor/CI scheduling, strict enough to catch input
  // debounce, per-keystroke 100ms timers, or a persistently blocked renderer.
  assert.ok(summary.echo.median < 75 && summary.echo.p95 < 200, `remote echo latency is excessive: ${JSON.stringify(summary.echo)}`)
  assert.ok(summary.rendered.median < 100 && summary.rendered.p95 < 250, `terminal render latency is excessive: ${JSON.stringify(summary.rendered)}`)
  assert.ok(summary.afterBurstRendered.p95 < 250, 'real keyboard input remained slow after server output burst')
  if (!baseline) assert.ok(burstResult.events < 100, `2,000 echoed bytes generated ${burstResult.events} renderer callbacks`)
  assert.deepEqual(errors, [], errors.join('\n'))
  if (!background) await page.screenshot({ path: path.join(results, baseline ? 'input-latency-baseline.png' : 'input-latency.png'), timeout: 5000 })
  console.log(`Input latency E2E ${baseline ? 'baseline ' : ''}passed: echo median ${summary.echo.median.toFixed(2)}ms / p95 ${summary.echo.p95.toFixed(2)}ms; rendered median ${summary.rendered.median.toFixed(2)}ms / p95 ${summary.rendered.p95.toFixed(2)}ms; 2000-byte output burst ${summary.burst.callbacks} callbacks; after-burst render p95 ${summary.afterBurstRendered.p95.toFixed(2)}ms.`)
} catch (error) {
  console.error(`[input-latency] failed during ${phase}:`, error)
  if (!background) await page?.screenshot({ path: path.join(results, 'input-latency-failure.png'), timeout: 1500 }).catch(() => {})
  throw error
} finally {
  progress('closing isolated test resources')
  await app?.close().catch(() => {})
  await fixture.close()
  await rm(temporary, { recursive: true, force: true })
  clearTimeout(watchdog)
}
