import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { _electron, expect, type ElectronApplication } from '@playwright/test'

if (process.env.SSH_HEAVEN_BACKGROUND_TEST === '1') throw new Error('Native drag testing requires a visible window. This interactive test is disabled in background-only mode.')

// Native drag gestures must come from the OS (Computer Use or a human), rather
// than Playwright's renderer-only mouse events. This harness observes actual
// BrowserWindow bounds and never moves the window to satisfy a drag assertion.
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-window-drag-'))
const dataDirectory = path.join(temporary, 'settings')
const results = path.join(root, 'test-results')
const progress = path.join(results, 'window-drag-live.json')
await mkdir(dataDirectory); await mkdir(results, { recursive: true })
let app: ElectronApplication | undefined
const moves: unknown[] = []
const errors: string[] = []
interface Bounds { x: number; y: number; width: number; height: number }
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  const page = await app.firstWindow(); page.on('pageerror', (error) => errors.push(error.message))
  await expect(page.getByRole('tab', { name: 'Home', exact: true })).toBeVisible()
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.unmaximize(); window.setBounds({ x: 120, y: 80, width: 1100, height: 760 }); window.show(); window.focus()
  })
  for (const phase of ['titlebar', 'workspace-header', 'tabbar-gap']) {
    await app.evaluate(({ BrowserWindow }, name) => { BrowserWindow.getAllWindows()[0].setTitle(`SSH Heaven · Native drag QA · ${name}`) }, phase)
    const before: Bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    await writeFile(progress, JSON.stringify({ phase, before, instruction: `Use a real OS drag on the ${phase}. Keep controls untouched.` }, null, 2))
    console.log(`Awaiting native ${phase} drag; before=${JSON.stringify(before)}`)
    await expect.poll(async () => {
      const after = await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
      return Math.abs(after.x - before.x) + Math.abs(after.y - before.y)
    }, { timeout: 180_000, intervals: [250], message: `A real native ${phase} drag must move the window` }).toBeGreaterThan(30)
    const after: Bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds())
    assert.deepEqual([after.width, after.height], [before.width, before.height], 'Dragging must move rather than resize the window')
    moves.push({ phase, before, after })
  }
  await writeFile(progress, JSON.stringify({ phase: 'appearance-control', instruction: 'Click the Appearance palette control in the workspace header.' }, null, 2))
  await expect(page.getByRole('dialog', { name: 'Appearance', exact: true })).toBeVisible({ timeout: 180_000 })
  await writeFile(progress, JSON.stringify({ phase: 'close-appearance', instruction: 'Close Appearance with Escape.' }, null, 2))
  await expect(page.getByRole('dialog', { name: 'Appearance', exact: true })).toHaveCount(0, { timeout: 180_000 })
  await writeFile(progress, JSON.stringify({ phase: 'tab-control', instruction: 'Click the New connection tab.' }, null, 2))
  await expect(page.getByRole('tab', { name: 'New connection', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 180_000 })
  const regions = await page.evaluate(() => ({
    titlebar: getComputedStyle(document.querySelector('.window-titlebar')!).getPropertyValue('-webkit-app-region'),
    header: getComputedStyle(document.querySelector('.topbar')!).getPropertyValue('-webkit-app-region'),
    tabs: getComputedStyle(document.querySelector('.tabbar')!).getPropertyValue('-webkit-app-region'),
    controls: [...document.querySelectorAll('.topbar button,.tabbar button')].map((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')),
  }))
  assert.equal(regions.titlebar, 'drag'); assert.equal(regions.header, 'drag'); assert.equal(regions.tabs, 'drag')
  assert.ok(regions.controls.every((value) => value === 'no-drag'))
  assert.deepEqual(errors, [])
  await page.screenshot({ path: path.join(results, 'window-drag-verified.png') })
  await writeFile(progress, JSON.stringify({ phase: 'complete', moves, regions }, null, 2))
  console.log('Native window drag E2E passed: real titlebar/header/tabbar moves with unchanged size, Appearance and tab controls remain clickable, native caption controls preserved.')
} catch (error) {
  await writeFile(progress, JSON.stringify({ phase: 'failed', error: String(error), moves }, null, 2))
  throw error
} finally {
  try { await app?.close() }
  finally { await rm(temporary, { recursive: true, force: true }) }
}
