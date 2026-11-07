import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { _electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { startFixture } from './fixture'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-wallpaper-e2e-'))
const dataDirectory = path.join(temporary, 'settings')
const imagePath = path.join(temporary, 'Rose horizon.png')
const gifPath = path.join(temporary, 'Rose animation.gif')
const invalidPath = path.join(temporary, 'unsupported.svg')
const brokenPath = path.join(temporary, 'Undecodable.webp')
await mkdir(dataDirectory)
await mkdir(path.join(root, 'test-results'), { recursive: true })
const fixture = await startFixture()
let app: ElectronApplication | undefined
let page: Page | undefined
const rendererErrors: string[] = []

// Deterministic local fixtures: a real PNG gradient and a two-frame GIF. These
// test files never leave the test-owned temporary directory.
function crc(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}
function chunk(name: string, body: Buffer): Buffer {
  const bytes = Buffer.alloc(body.length + 12)
  bytes.writeUInt32BE(body.length); bytes.write(name, 4, 'ascii'); body.copy(bytes, 8)
  bytes.writeUInt32BE(crc(bytes.subarray(4, -4)), bytes.length - 4)
  return bytes
}
function gradient(): Buffer {
  const width = 640, height = 360
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * (width * 4 + 1) + 1 + x * 4
    const glow = Math.exp(-((x / width - .72) ** 2 + (y / height - .38) ** 2) * 8)
    const wave = Math.sin(x / 93 + y / 47) * 13
    pixels[at] = Math.round(55 + 145 * glow + wave)
    pixels[at + 1] = Math.round(22 + 51 * glow)
    pixels[at + 2] = Math.round(79 + 86 * glow + wave)
    pixels[at + 3] = 255
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const png = gradient()
const gif = Buffer.from('47494638396101000100800000f17abaffc1d921ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b', 'hex')
const brokenWebp = Buffer.alloc(26)
brokenWebp.write('RIFF'); brokenWebp.writeUInt32LE(18, 4); brokenWebp.write('WEBPVP8L', 8); brokenWebp.writeUInt32LE(5, 16); brokenWebp[20] = 0x2f; brokenWebp.writeUInt32LE(0xe0000000, 21)
await writeFile(imagePath, png); await writeFile(gifPath, gif)
await writeFile(invalidPath, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
await writeFile(brokenPath, brokenWebp)

async function launch(): Promise<Page> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const executable = process.env.SSH_HEAVEN_EXECUTABLE
  app = await _electron.launch({ executablePath: executable || require('electron') as string, args: [...(executable ? [] : [root]), `--user-data-dir=${dataDirectory}`], env, timeout: 30_000 })
  const current = await app.firstWindow()
  current.on('pageerror', (error) => rendererErrors.push(error.message))
  await current.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(current.getByRole('tab', { name: 'Home', exact: true })).toBeVisible()
  await current.evaluate(() => {
    const target = window as unknown as { wallpaperOutput: string }
    target.wallpaperOutput = ''
    window.sshHeaven.onData(({ data }) => { target.wallpaperOutput += new TextDecoder().decode(data) })
  })
  page = current
  return current
}
async function appearance(current: Page): Promise<Locator> {
  await current.getByRole('button', { name: 'Appearance', exact: true }).click()
  const dialog = current.getByRole('dialog', { name: 'Appearance', exact: true })
  await expect(dialog).toBeVisible()
  return dialog
}
async function picker(filename: string | null) {
  await app!.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = (async () => ({ canceled: selected === null, filePaths: selected ? [selected] : [] })) as typeof dialog.showOpenDialog }, filename)
}
async function imageLoaded(current: Page) {
  await expect.poll(() => current.locator('.wallpaper-layer>img').evaluate((node) => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0)).toBe(true)
}
async function source(current: Page) { return current.locator('.wallpaper-layer>img').getAttribute('src') }

try {
  let current = await launch()
  const initial = await current.evaluate(() => window.sshHeaven.getWallpaperState())
  assert.equal(initial.enabled, false); assert.equal(initial.opacity, .2); assert.equal(initial.blur, 0)
  await expect(current.locator('html')).toHaveAttribute('data-wallpaper', 'false')
  let dialog = await appearance(current)
  await dialog.getByRole('radio', { name: 'Pink', exact: true }).check()
  await expect(current.locator('html')).toHaveAttribute('data-theme', 'pink')
  await expect(current.getByLabel('Current theme: Pink', { exact: true })).toBeVisible()
  assert.equal(await app!.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark')
  await picker(imagePath)
  await dialog.getByRole('button', { name: 'Choose wallpaper', exact: true }).click()
  await imageLoaded(current)
  await expect(dialog.getByText(path.basename(imagePath), { exact: true })).toBeVisible()
  assert.equal((await dialog.innerText()).includes(temporary), false, 'Appearance must show only the selected filename')
  let state = await current.evaluate(() => window.sshHeaven.getWallpaperState())
  assert.match(state.assetUrl!, /^ssh-heaven-wallpaper:\/\/asset\/[a-f0-9-]+\/image$/)
  assert.equal(state.opacity, .2)
  await dialog.getByRole('slider', { name: 'Wallpaper opacity', exact: true }).focus()
  for (let step = 0; step < 10; step++) await current.keyboard.press('ArrowRight')
  await dialog.getByRole('slider', { name: 'Wallpaper blur', exact: true }).focus()
  for (let step = 0; step < 3; step++) await current.keyboard.press('ArrowRight')
  await dialog.getByLabel('Wallpaper fit', { exact: true }).selectOption('contain')
  await expect(current.locator('.wallpaper-layer>img')).toHaveCSS('object-fit', 'contain')
  await dialog.getByLabel('Wallpaper fit', { exact: true }).selectOption('cover')
  await expect.poll(async () => {
    const saved = await current.evaluate(() => window.sshHeaven.getWallpaperState())
    return [saved.opacity, saved.blur, saved.fit]
  }).toEqual([.3, 3, 'cover'])
  await expect(current.locator('.wallpaper-layer>img')).toHaveCSS('opacity', '0.3')
  await expect(current.locator('.wallpaper-layer>img')).toHaveCSS('filter', 'blur(3px)')
  await dialog.getByRole('checkbox', { name: 'Enable wallpaper', exact: true }).uncheck()
  await expect(current.locator('.wallpaper-layer')).toHaveCount(0)
  await dialog.getByRole('checkbox', { name: 'Enable wallpaper', exact: true }).check()
  await imageLoaded(current)
  await picker(null)
  const beforeCancel = await current.evaluate(() => window.sshHeaven.getWallpaperState())
  await dialog.getByRole('button', { name: 'Choose wallpaper', exact: true }).click()
  assert.deepEqual(await current.evaluate(() => window.sshHeaven.getWallpaperState()), beforeCancel)
  await dialog.getByRole('slider', { name: 'Wallpaper opacity', exact: true }).scrollIntoViewIfNeeded()
  await current.screenshot({ path: path.join(root, 'test-results', 'wallpaper-appearance.png') })
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await current.screenshot({ path: path.join(root, 'test-results', 'wallpaper-pink-home.png') })

  await current.getByRole('tab', { name: 'New connection', exact: true }).click()
  await current.getByLabel(/^Nickname/).fill('Wallpaper fixture')
  await current.getByLabel('Hostname or IP address', { exact: true }).fill(fixture.host)
  await current.getByLabel('SSH port', { exact: true }).fill(String(fixture.port))
  await current.getByLabel('Username', { exact: true }).fill(fixture.username)
  await current.getByLabel('Password', { exact: true }).fill(fixture.password)
  await current.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(current.getByRole('dialog', { name: 'Verify server identity', exact: true })).toBeVisible()
  await current.getByRole('button', { name: 'Trust & connect', exact: true }).click()
  await expect(current.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()
  const terminal = await current.locator('.xterm').elementHandle()
  await current.locator('.xterm-helper-textarea').focus()
  await current.keyboard.type('echo wallpaper-live-terminal-marker'); await current.keyboard.press('Enter')
  await expect.poll(() => current.evaluate(() => (window as unknown as { wallpaperOutput: string }).wallpaperOutput)).toContain('wallpaper-live-terminal-marker')
  await expect(current.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(current.locator('.session-workspace')).toHaveCSS('opacity', '1')
  await current.screenshot({ path: path.join(root, 'test-results', 'wallpaper-pink-terminal.png') })
  dialog = await appearance(current)
  await dialog.getByRole('radio', { name: 'Daylight', exact: true }).check()
  await expect(current.locator('html')).toHaveAttribute('data-theme', 'daylight')
  await dialog.getByRole('radio', { name: 'Pink', exact: true }).check()
  await dialog.getByRole('checkbox', { name: 'Enable wallpaper', exact: true }).uncheck()
  await expect(current.locator('.xterm-viewport')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await dialog.getByRole('checkbox', { name: 'Enable wallpaper', exact: true }).check()
  await expect(current.locator('.xterm-viewport')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  assert.equal(await terminal!.evaluate((node) => node.isConnected), true, 'Wallpaper and theme changes must preserve the existing terminal')
  await expect(current.locator('.terminal-footer').getByText('Connected', { exact: true })).toBeVisible()

  await picker(gifPath)
  await dialog.getByRole('button', { name: 'Choose wallpaper', exact: true }).click()
  await expect(dialog.getByText(path.basename(gifPath), { exact: true })).toBeVisible()
  await imageLoaded(current)
  state = await current.evaluate(() => window.sshHeaven.getWallpaperState())
  assert.equal(state.kind, 'gif'); assert.ok(state.posterUrl && state.posterUrl !== state.assetUrl)
  await expect(current.locator('.wallpaper-layer')).toHaveAttribute('data-animated', 'true')
  await expect(dialog.getByRole('checkbox', { name: 'Animate GIF', exact: true })).toBeChecked()
  await dialog.getByRole('checkbox', { name: 'Animate GIF', exact: true }).uncheck()
  await expect.poll(() => source(current)).toBe(state.posterUrl)
  await expect(current.locator('.wallpaper-layer')).toHaveAttribute('data-animated', 'false')
  await dialog.getByRole('checkbox', { name: 'Animate GIF', exact: true }).check()
  await expect.poll(() => source(current)).toBe(state.assetUrl)
  await current.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => source(current)).toBe(state.posterUrl)
  await expect(dialog.getByRole('checkbox', { name: 'Animate GIF', exact: true })).toBeDisabled()
  assert.equal((await current.evaluate(() => window.sshHeaven.getWallpaperState())).animate, true, 'System motion preference must not overwrite the user animation setting')
  await current.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => source(current)).toBe(state.assetUrl)
  await expect(dialog.getByRole('checkbox', { name: 'Animate GIF', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Done', exact: true }).click()
  await app!.close(); app = undefined
  await rm(imagePath); await rm(gifPath)

  // The managed copy and still poster survive after both original files vanish.
  current = await launch()
  await current.emulateMedia({ reducedMotion: 'reduce' })
  await imageLoaded(current)
  state = await current.evaluate(() => window.sshHeaven.getWallpaperState())
  assert.equal(state.name, path.basename(gifPath)); assert.equal(state.enabled, true)
  assert.deepEqual([state.opacity, state.blur, state.fit, state.animate], [.3, 3, 'cover', true])
  await expect(current.locator('html')).toHaveAttribute('data-theme', 'pink')
  await expect.poll(() => source(current)).toBe(state.posterUrl)
  const settingsText = await readFile(path.join(dataDirectory, 'wallpaper', 'wallpaper.json'), 'utf8')
  assert.equal(settingsText.includes(temporary), false, 'Persisted settings must contain managed IDs, not the original file path')
  dialog = await appearance(current)
  await picker(invalidPath)
  await dialog.getByRole('button', { name: 'Choose wallpaper', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText(/PNG|JPEG|GIF|SVG/)
  assert.equal((await current.evaluate(() => window.sshHeaven.getWallpaperState())).assetUrl, state.assetUrl, 'A rejected image must keep the previous wallpaper')
  await picker(brokenPath)
  await dialog.getByRole('button', { name: 'Choose wallpaper', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('could not be displayed')
  await expect(current.locator('.wallpaper-layer')).toHaveCount(0)
  await expect(current.locator('html')).toHaveAttribute('data-wallpaper', 'false')
  await expect(dialog.getByText(path.basename(brokenPath), { exact: true })).toBeVisible()
  await expect.poll(async () => (await current.evaluate(() => window.sshHeaven.getWallpaperState())).enabled).toBe(false)
  await dialog.getByRole('button', { name: 'Remove wallpaper', exact: true }).click()
  await expect(dialog.getByText('No wallpaper selected', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Enable wallpaper', exact: true })).toBeDisabled()
  assert.equal((await current.evaluate(() => window.sshHeaven.getWallpaperState())).assetUrl, undefined)
  assert.deepEqual((await readdir(path.join(dataDirectory, 'wallpaper'))).filter((name) => name !== 'wallpaper.json'), [])
  assert.deepEqual(rendererErrors, [])
  console.log('Wallpaper E2E passed: Pink/native theme, image selection and managed copy, instant opacity/blur/fit/enable controls, canceled picker, live terminal preservation/transparency, GIF animation/poster and reduced-motion override, restart persistence without original files, safe rejection/decode failure, and remove cleanup.')
} catch (error) {
  if (page && app) {
    await page.screenshot({ path: path.join(root, 'test-results', 'wallpaper-failure.png') }).catch(() => {})
    console.error((await page.locator('body').innerText().catch(() => '')).replaceAll(fixture.password, '[REDACTED]').slice(0, 7000))
  }
  throw error
} finally {
  try { await app?.close() }
  finally {
    try { await fixture.close() }
    finally { await rm(temporary, { recursive: true, force: true }) }
  }
}
