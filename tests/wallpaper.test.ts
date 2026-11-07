import assert from 'node:assert/strict'
import { mkdtemp, mkdir, open, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import { DEFAULT_WALLPAPER, WallpaperService, validateWallpaperPreferences } from '../electron/wallpaper'
import { createGifPoster, encodeWallpaperPng, inspectWallpaper, MAX_WALLPAPER_BYTES, pngCrc } from '../electron/wallpaper-images'

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
// Red then blue, looping indefinitely. The poster must remain opaque red;
// animation bytes, timing, palette, and second frame must remain unchanged.
const ANIMATED_GIF = Buffer.from('47494638396101000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f904000a0000002c000000000100010000020244010021f904000a0000002c00000000010001000002024c01003b', 'hex')
const WEBP = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-wallpaper-'))
  const managed = path.join(directory, 'managed')
  const png = await encodeWallpaperPng(2, 1, Uint8Array.from([255, 0, 127, 255, 0, 255, 0, 255]))
  const image = path.join(directory, 'custom.png')
  const gif = path.join(directory, 'animation.gif')
  await writeFile(image, png); await writeFile(gif, ANIMATED_GIF)
  return { directory, managed, png, image, gif, async close() { await rm(directory, { recursive: true, force: true }) } }
}
function request(url: string, method = 'GET'): Request { return { url, method } as Request }
async function responseBytes(service: WallpaperService, url: string): Promise<Buffer> {
  const response = await service.handleRequest(request(url))
  assert.equal(response.status, 200)
  return Buffer.from(await response.arrayBuffer())
}
function pngPixels(bytes: Buffer): Buffer {
  const compressed: Buffer[] = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(bytes.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  return inflateSync(Buffer.concat(compressed))
}

test('wallpaper magic/dimension validation rejects unsupported, corrupt, oversized, and image-bomb headers before decoding', async () => {
  const h = await fixture()
  try {
    assert.deepEqual(inspectWallpaper(h.png), { format: 'png', mime: 'image/png', width: 2, height: 1, animated: false })
    assert.equal(inspectWallpaper(GIF).format, 'gif')
    assert.equal(inspectWallpaper(ANIMATED_GIF).animated, true)
    assert.equal(inspectWallpaper(WEBP).format, 'webp')
    assert.throws(() => inspectWallpaper(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), /valid PNG|SVG/)
    assert.throws(() => inspectWallpaper(Buffer.from('<html>not an image</html>')), /valid PNG/)
    assert.throws(() => inspectWallpaper(Buffer.concat([h.png, Buffer.from('extra data')])), /valid PNG/)
    const corrupted = Buffer.from(h.png); corrupted[40] ^= 1
    assert.throws(() => inspectWallpaper(corrupted), /valid PNG/)
    const bomb = Buffer.from(h.png); bomb.writeUInt32BE(100000, 16); bomb.writeUInt32BE(pngCrc(bomb.subarray(12, 29)), 29)
    assert.throws(() => inspectWallpaper(bomb), /megapixel|dimensions/)
    const gifBomb = Buffer.from(GIF); gifBomb.writeUInt16LE(65535, 6); gifBomb.writeUInt16LE(65535, 8)
    assert.throws(() => inspectWallpaper(gifBomb), /8 megapixel/)
    assert.throws(() => inspectWallpaper(GIF.subarray(0, GIF.length - 2)), /valid PNG/)
    const frameOutsideCanvas = Buffer.from(GIF); frameOutsideCanvas.writeUInt16LE(2, 28)
    assert.throws(() => inspectWallpaper(frameOutsideCanvas), /valid PNG/)
    const service = new WallpaperService(h.managed)
    await service.load()
    const huge = path.join(h.directory, 'too-large.gif')
    const handle = await open(huge, 'wx')
    try { await handle.truncate(MAX_WALLPAPER_BYTES + 1) } finally { await handle.close() }
    await assert.rejects(service.select(huge), /20 MiB/)
    assert.equal(service.get().assetUrl, undefined)
  } finally { await h.close() }
})

test('managed wallpaper copies survive source deletion and restart with preferences and GIF bytes intact; paused posters contain one static first frame', async () => {
  const h = await fixture()
  try {
    const service = new WallpaperService(h.managed)
    assert.deepEqual(await service.load(), DEFAULT_WALLPAPER)
    const image = await service.select(h.gif)
    assert.equal(image.kind, 'gif')
    assert.equal(image.enabled, true)
    assert.equal(image.name, 'animation.gif')
    assert.match(image.assetUrl!, /^ssh-heaven-wallpaper:\/\/asset\/[a-f0-9-]+\/image$/)
    assert.equal(JSON.stringify(image).includes(h.directory), false)
    assert.deepEqual(await responseBytes(service, image.assetUrl!), ANIMATED_GIF)
    const posterResponse = await service.handleRequest(request(image.posterUrl!))
    assert.equal(posterResponse.headers.get('content-type'), 'image/png')
    const poster = Buffer.from(await posterResponse.arrayBuffer())
    assert.equal(inspectWallpaper(poster).animated, false)
    assert.deepEqual(pngPixels(poster), Buffer.from([0, 255, 0, 0, 255])) // filter byte + first-frame red RGBA
    await service.update({ opacity: 0.35, blur: 9, fit: 'contain', animate: false })
    await unlink(h.gif)
    const reloaded = new WallpaperService(h.managed)
    const state = await reloaded.load()
    assert.equal(state.error, undefined)
    assert.equal(state.opacity, 0.35); assert.equal(state.blur, 9); assert.equal(state.fit, 'contain'); assert.equal(state.animate, false)
    assert.equal(state.assetUrl, image.assetUrl)
    assert.deepEqual(await responseBytes(reloaded, state.assetUrl!), ANIMATED_GIF)
    assert.deepEqual(await responseBytes(reloaded, state.posterUrl!), poster)
    const persisted = await readFile(path.join(h.managed, 'wallpaper.json'), 'utf8')
    assert.equal(persisted.includes(h.directory.replace(/\\/g, '\\\\')), false)
    assert.equal(persisted.includes('animation.gif'), true)
  } finally { await h.close() }
})

test('wallpaper protocol serves only exact current asset routes, correct image headers, and GET/HEAD without exposing local paths', async () => {
  const h = await fixture()
  try {
    const service = new WallpaperService(h.managed)
    await service.load()
    const state = await service.select(h.image)
    const url = state.assetUrl!
    const response = await service.handleRequest(request(url))
    assert.equal(response.headers.get('content-type'), 'image/png')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(Number(response.headers.get('content-length')), h.png.length)
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    const head = await service.handleRequest(request(url, 'HEAD'))
    assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0)
    for (const value of [url + '?path=C:/Windows/win.ini', url + '#image', url.replace('://asset/', '://wrong/'), url.replace('://asset/', '://user:pass@asset/'), url.replace('/image', '/../../wallpaper.json'), url.replace('/image', '/%2f..%2fwallpaper.json'), url.replace('/image', '/..%5cwallpaper.json'), url.replace('ssh-heaven-wallpaper:', 'file:'), 'ssh-heaven-wallpaper://asset/C:/Windows/win.ini']) {
      assert.equal((await service.handleRequest(request(value))).status, 404, value)
    }
    assert.equal((await service.handleRequest(request(url, 'POST'))).status, 405)
    await assert.rejects(service.select('https://example.com/wallpaper.gif'), /local image/)
    await assert.rejects(service.select('relative.png'), /local image/)
    const next = await service.select(h.gif)
    assert.notEqual(next.assetUrl, url)
    assert.equal((await service.handleRequest(request(url))).status, 404)
    assert.equal((await readdir(h.managed)).some((name) => name.endsWith('.png') && !name.endsWith('.poster.png')), false)
    await service.clear()
    assert.equal((await service.handleRequest(request(next.assetUrl!))).status, 404)
    assert.deepEqual(await readdir(h.managed), ['wallpaper.json'])
  } finally { await h.close() }
})

test('wallpaper preference validation and decoder failures preserve the current asset and persisted configuration', async () => {
  const h = await fixture()
  try {
    let rejectImage = false
    const service = new WallpaperService(h.managed, { inspectImage() { if (rejectImage) throw new Error('Native image decoding failed.') } })
    await service.load()
    await service.select(h.image)
    const before = service.get()
    const settings = await readFile(path.join(h.managed, 'wallpaper.json'), 'utf8')
    for (const update of [{ opacity: NaN }, { opacity: 2 }, { blur: -1 }, { blur: 21 }, { blur: Infinity }, { fit: 'stretch' }, { animate: 'yes' }, { enabled: 1 }, { assetUrl: 'file:///secret' }, null]) {
      await assert.rejects(service.update(update), /valid|Invalid/)
      assert.deepEqual(service.get(), before)
    }
    assert.deepEqual(validateWallpaperPreferences({ opacity: 0.5 }), { ...DEFAULT_WALLPAPER, opacity: 0.5 })
    rejectImage = true
    await assert.rejects(service.select(h.image), /decoding failed/)
    assert.deepEqual(service.get(), before)
    assert.equal(await readFile(path.join(h.managed, 'wallpaper.json'), 'utf8'), settings)
    assert.deepEqual(await responseBytes(service, before.assetUrl!), h.png)
    await service.clear()
    await assert.rejects(service.update({ enabled: true }), /Choose a wallpaper/)
  } finally { await h.close() }
})

test('wallpaper persistence failure cleans newly copied files while preserving the active wallpaper; queued changes commit in order', async () => {
  const h = await fixture()
  try {
    const service = new WallpaperService(h.managed)
    await service.load(); await service.select(h.image)
    const before = service.get()
    const settings = path.join(h.managed, 'wallpaper.json'), backup = path.join(h.managed, 'owned-state-backup.json')
    await rename(settings, backup); await mkdir(settings)
    await assert.rejects(service.select(h.gif))
    assert.deepEqual(service.get(), before)
    assert.deepEqual(await responseBytes(service, before.assetUrl!), h.png)
    assert.equal((await readdir(h.managed)).some((name) => name.endsWith('.gif') || name.endsWith('.poster.png') || name.endsWith('.tmp')), false)
    await rmdir(settings); await rename(backup, settings)
    const [chosen] = await Promise.all([service.select(h.gif), service.update({ opacity: 0.72, blur: 4 })])
    assert.equal(chosen.kind, 'gif')
    assert.equal(service.get().opacity, 0.72)
    const reloaded = new WallpaperService(h.managed)
    assert.equal((await reloaded.load()).opacity, 0.72)
  } finally { await h.close() }
})

test('missing, modified, or corrupt managed assets fail closed with usable error state and can be replaced or cleared', async () => {
  const h = await fixture()
  try {
    const changes: string[] = []
    const service = new WallpaperService(h.managed, { onChange: (state) => changes.push(state.error ?? '') })
    await service.load()
    const chosen = await service.select(h.image)
    const imageName = (await readdir(h.managed)).find((name) => name.endsWith('.png'))!
    await writeFile(path.join(h.managed, imageName), 'corrupted managed content')
    assert.equal((await service.handleRequest(request(chosen.assetUrl!))).status, 404)
    assert.equal(service.get().enabled, false)
    assert.match(service.get().error!, /missing or damaged/)
    assert.ok(changes.some((error) => /damaged/.test(error)))
    const reloaded = new WallpaperService(h.managed)
    assert.match((await reloaded.load()).error!, /missing or damaged/)
    const gif = await reloaded.select(h.gif)
    assert.equal(gif.error, undefined)
    const gifName = (await readdir(h.managed)).find((name) => name.endsWith('.gif'))!
    await unlink(path.join(h.managed, gifName))
    const missing = new WallpaperService(h.managed)
    assert.match((await missing.load()).error!, /missing or damaged/)
    await missing.clear()
    assert.equal(missing.get().error, undefined)
    assert.equal(missing.get().enabled, false)
    await writeFile(path.join(h.managed, 'wallpaper.json'), JSON.stringify({ version: 1, preferences: DEFAULT_WALLPAPER, asset: { id: '../../secret', format: 'png' } }))
    const unsafe = new WallpaperService(h.managed)
    assert.match((await unsafe.load()).error!, /missing or damaged/)
    assert.equal(unsafe.get().assetUrl, undefined)
  } finally { await h.close() }
})

test('GIF poster generation rejects wrong formats and is deterministic while leaving animation input unchanged', async () => {
  const h = await fixture()
  try {
    const original = Buffer.from(ANIMATED_GIF)
    const first = await createGifPoster(ANIMATED_GIF)
    const second = await createGifPoster(ANIMATED_GIF)
    assert.deepEqual(first, second)
    assert.deepEqual(original, ANIMATED_GIF)
    assert.deepEqual(inspectWallpaper(first), { format: 'png', mime: 'image/png', width: 1, height: 1, animated: false })
    await assert.rejects(createGifPoster(h.png), /valid PNG/)
  } finally { await h.close() }
})
