import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { WallpaperPreferences, WallpaperState } from '../shared/types'
import { createGifPoster, inspectWallpaper, inspectWallpaperPoster, MAX_WALLPAPER_BYTES, type WallpaperImage } from './wallpaper-images'

export const WALLPAPER_SCHEME = 'ssh-heaven-wallpaper'
export const DEFAULT_WALLPAPER: Readonly<WallpaperPreferences> = { enabled: false, opacity: 0.2, blur: 0, fit: 'cover', animate: true }
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const ID = new RegExp(`^${UUID}$`)
const MANAGED = new RegExp(`^${UUID}\\.(?:png|jpeg|webp|gif|poster\\.png)$`)
const TEMPORARY = new RegExp(`^\\.wallpaper-state-\\d+-${UUID}\\.tmp$`)
const HASH = /^[a-f0-9]{64}$/
interface Asset extends WallpaperImage { id: string; name: string; bytes: number; hash: string; posterHash?: string }
interface Stored { version: 1; preferences: WallpaperPreferences; asset?: Asset }
export interface WallpaperOptions {
  /** Optional extra decoding verification; called after bounded header checks. */
  inspectImage?(bytes: Buffer, image: WallpaperImage): void | Promise<void>
  createPoster?(bytes: Buffer): Buffer | Promise<Buffer>
  onChange?(state: WallpaperState): void
}

function hash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid wallpaper settings.')
  return value as Record<string, unknown>
}
export function validateWallpaperPreferences(value: unknown, base: WallpaperPreferences = { ...DEFAULT_WALLPAPER }): WallpaperPreferences {
  const input = object(value)
  if (Object.keys(input).some((key) => !Object.hasOwn(DEFAULT_WALLPAPER, key))) throw new Error('Invalid wallpaper setting.')
  const next = { ...base, ...input }
  if (typeof next.enabled !== 'boolean' || typeof next.animate !== 'boolean' || typeof next.opacity !== 'number' || !Number.isFinite(next.opacity) || next.opacity < 0 || next.opacity > 1 || typeof next.blur !== 'number' || !Number.isFinite(next.blur) || next.blur < 0 || next.blur > 20 || !['cover', 'contain'].includes(next.fit)) throw new Error('Choose a valid wallpaper opacity (0–1), blur (0–20), and fit.')
  return next
}
function validateStored(value: unknown): Stored {
  const input = object(value)
  if (input.version !== 1) throw new Error('Unsupported wallpaper settings.')
  const preferences = validateWallpaperPreferences(input.preferences)
  if (input.asset === undefined) return { version: 1, preferences }
  const item = object(input.asset)
  if (typeof item.id !== 'string' || !ID.test(item.id) || typeof item.name !== 'string' || !item.name || item.name.length > 255 || /[\0\r\n\\/]/.test(item.name) || typeof item.hash !== 'string' || !HASH.test(item.hash) || typeof item.bytes !== 'number' || !Number.isInteger(item.bytes) || item.bytes < 1 || item.bytes > MAX_WALLPAPER_BYTES || !['png', 'jpeg', 'webp', 'gif'].includes(String(item.format)) || typeof item.width !== 'number' || typeof item.height !== 'number' || !Number.isSafeInteger(item.width) || !Number.isSafeInteger(item.height) || item.width < 1 || item.height < 1 || typeof item.animated !== 'boolean') throw new Error('Invalid saved wallpaper image.')
  const format = item.format as Asset['format']
  const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[format]
  if (item.mime !== mime || (format === 'gif' && (typeof item.posterHash !== 'string' || !HASH.test(item.posterHash)))) throw new Error('Invalid saved wallpaper image.')
  return { version: 1, preferences, asset: { id: item.id, name: item.name, format, mime, width: item.width, height: item.height, bytes: item.bytes, animated: item.animated, hash: item.hash, ...(format === 'gif' ? { posterHash: item.posterHash as string } : {}) } }
}

/** Reads a fixed local file, never an unbounded stream or a symlinked asset. */
async function boundedFile(filename: string, maximum: number, managed: boolean): Promise<Buffer> {
  const before = managed ? await lstat(filename) : undefined
  if (before && (!before.isFile() || before.isSymbolicLink())) throw new Error('The managed wallpaper file is not a regular file.')
  const handle = await open(filename, constants.O_RDONLY | (managed && process.platform !== 'win32' ? constants.O_NOFOLLOW : 0))
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || (before && (metadata.dev !== before.dev || metadata.ino !== before.ino))) throw new Error('The wallpaper file changed. Choose it again.')
    if (metadata.size < 1 || metadata.size > maximum) throw new Error(maximum === MAX_WALLPAPER_BYTES ? 'Choose an image no larger than 20 MiB.' : 'The wallpaper data exceeds its size limit.')
    const buffer = Buffer.allocUnsafe(metadata.size + 1)
    let count = 0
    while (count < buffer.length) {
      const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count)
      if (!bytesRead) break
      count += bytesRead
    }
    if (count !== metadata.size) throw new Error('The wallpaper file changed while it was being read. Choose it again.')
    return buffer.subarray(0, count)
  } finally { await handle.close() }
}

export class WallpaperService {
  private preferences: WallpaperPreferences = { ...DEFAULT_WALLPAPER }
  private asset?: Asset
  private error?: string
  private queue: Promise<unknown> = Promise.resolve()
  private readonly directory: string
  private readonly settings: string

  constructor(directory: string, private readonly options: WallpaperOptions = {}) {
    if (!path.isAbsolute(directory)) throw new Error('The wallpaper directory must be absolute.')
    this.directory = path.resolve(directory)
    this.settings = path.join(this.directory, 'wallpaper.json')
  }

  get(): WallpaperState {
    const asset = this.asset
    const usable = asset && !this.error
    const assetUrl = usable ? `${WALLPAPER_SCHEME}://asset/${asset.id}/image` : undefined
    return { ...this.preferences, enabled: !!usable && this.preferences.enabled, ...(asset ? { name: asset.name, kind: asset.format === 'gif' ? 'gif' : 'image' } : {}), ...(assetUrl ? { assetUrl, posterUrl: asset?.format === 'gif' ? `${WALLPAPER_SCHEME}://asset/${asset.id}/poster` : assetUrl } : {}), ...(this.error ? { error: this.error } : {}) }
  }

  load(): Promise<WallpaperState> {
    return this.mutate(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      try {
        const stored = validateStored(JSON.parse((await boundedFile(this.settings, 64 * 1024, true)).toString('utf8')))
        this.preferences = stored.preferences
        this.asset = stored.asset
        this.error = undefined
        if (this.asset) await this.verifyAsset(this.asset)
      } catch (error) {
        const missingSettings = (error as NodeJS.ErrnoException).code === 'ENOENT' && !this.asset
        if (!missingSettings) this.error = 'The saved wallpaper is missing or damaged. Choose an image again.'
        if (!this.asset) this.preferences = { ...DEFAULT_WALLPAPER }
      }
      await this.cleanOrphans()
      return this.get()
    })
  }

  select(value: unknown): Promise<WallpaperState> {
    return this.mutate(async () => {
      if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw new Error('Choose a local image with the file picker.')
      const bytes = await boundedFile(value, MAX_WALLPAPER_BYTES, false)
      const image = inspectWallpaper(bytes)
      await this.options.inspectImage?.(bytes, image)
      const poster = image.format === 'gif' ? await (this.options.createPoster?.(bytes) ?? createGifPoster(bytes)) : undefined
      if (poster) {
        const inspected = inspectWallpaperPoster(poster)
        if (inspected.width !== image.width || inspected.height !== image.height) throw new Error('The GIF poster dimensions do not match its image.')
      }
      const asset: Asset = { ...image, id: randomUUID(), name: path.basename(value).replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 255) || 'Wallpaper', bytes: bytes.length, hash: hash(bytes), ...(poster ? { posterHash: hash(poster) } : {}) }
      const preferences = { ...this.preferences, enabled: true }
      const owned: string[] = []
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 })
        await this.writeAsset(this.assetPath(asset), bytes, owned)
        if (poster) await this.writeAsset(this.posterPath(asset), poster, owned)
        await this.persist({ version: 1, preferences, asset })
      } catch (error) { await Promise.all(owned.map((filename) => unlink(filename).catch(() => {}))); throw error }
      this.asset = asset; this.preferences = preferences; this.error = undefined
      await this.cleanOrphans()
      this.notify()
      return this.get()
    })
  }

  update(value: unknown): Promise<WallpaperState> {
    return this.mutate(async () => {
      const preferences = validateWallpaperPreferences(value, this.preferences)
      if (preferences.enabled && (!this.asset || this.error)) throw new Error('Choose a wallpaper image before enabling it.')
      await this.persist({ version: 1, preferences, ...(this.asset ? { asset: this.asset } : {}) })
      this.preferences = preferences
      this.notify()
      return this.get()
    })
  }

  clear(): Promise<WallpaperState> {
    return this.mutate(async () => {
      const preferences = { ...this.preferences, enabled: false }
      await this.persist({ version: 1, preferences })
      this.asset = undefined; this.preferences = preferences; this.error = undefined
      await this.cleanOrphans()
      this.notify()
      return this.get()
    })
  }

  async handleRequest(request: Request): Promise<Response> {
    let url: URL
    try { url = new URL(request.url) } catch { return new Response(null, { status: 400 }) }
    const asset = this.asset
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 })
    if (!asset || this.error || url.protocol !== `${WALLPAPER_SCHEME}:` || url.host !== 'asset' || url.username || url.password || url.search || url.hash || ![`/${asset.id}/image`, `/${asset.id}/poster`].includes(url.pathname)) return new Response(null, { status: 404 })
    const poster = url.pathname.endsWith('/poster') && asset.format === 'gif'
    try {
      const bytes = await boundedFile(poster ? this.posterPath(asset) : this.assetPath(asset), poster ? 40 * 1024 * 1024 : MAX_WALLPAPER_BYTES, true)
      if (hash(bytes) !== (poster ? asset.posterHash : asset.hash)) throw new Error('The wallpaper file changed.')
      if (this.asset !== asset || this.error) return new Response(null, { status: 404 })
      return new Response(request.method === 'HEAD' ? null : Uint8Array.from(bytes), { headers: { 'Content-Type': poster ? 'image/png' : asset.mime, 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } })
    } catch {
      if (this.asset === asset) { this.error = 'The wallpaper file is missing or damaged. Choose an image again.'; this.notify() }
      return new Response(null, { status: 404 })
    }
  }

  private notify(): void { this.options.onChange?.(this.get()) }
  private assetPath(asset: Asset): string { return path.join(this.directory, `${asset.id}.${asset.format}`) }
  private posterPath(asset: Asset): string { return path.join(this.directory, `${asset.id}.poster.png`) }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => {}).then(operation)
    this.queue = task
    return task
  }
  private async writeAsset(filename: string, bytes: Buffer, owned: string[]): Promise<void> {
    const handle = await open(filename, 'wx', 0o600)
    owned.push(filename)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  }
  private async persist(state: Stored): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(this.directory, `.wallpaper-state-${process.pid}-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try { await handle.writeFile(JSON.stringify(state), 'utf8'); await handle.sync() } finally { await handle.close() }
      await rename(temporary, this.settings)
    } finally { await unlink(temporary).catch(() => {}) }
  }
  private async verifyAsset(asset: Asset): Promise<void> {
    const bytes = await boundedFile(this.assetPath(asset), MAX_WALLPAPER_BYTES, true)
    const image = inspectWallpaper(bytes)
    if (bytes.length !== asset.bytes || hash(bytes) !== asset.hash || image.format !== asset.format || image.width !== asset.width || image.height !== asset.height || image.animated !== asset.animated) throw new Error('The saved wallpaper changed.')
    await this.options.inspectImage?.(bytes, image)
    if (asset.format === 'gif') {
      const poster = await boundedFile(this.posterPath(asset), 40 * 1024 * 1024, true)
      const inspected = inspectWallpaperPoster(poster)
      if (hash(poster) !== asset.posterHash || inspected.width !== image.width || inspected.height !== image.height) throw new Error('The GIF poster changed.')
    }
  }
  private async cleanOrphans(): Promise<void> {
    const keep = new Set(this.asset ? [path.basename(this.assetPath(this.asset)), ...(this.asset.format === 'gif' ? [path.basename(this.posterPath(this.asset))] : [])] : [])
    const entries = await readdir(this.directory, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && !keep.has(entry.name) && (MANAGED.test(entry.name) || TEMPORARY.test(entry.name))).map((entry) => unlink(path.join(this.directory, entry.name)).catch(() => {})))
  }
}
