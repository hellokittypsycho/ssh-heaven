import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rename, rmdir, unlink, type FileHandle } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import path from 'node:path'

export const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024
const CDN_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'objects-origin.githubusercontent.com', 'github-releases.githubusercontent.com'])
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0

/** Only these trusted messages may be shown in the renderer; native paths and
 * signed CDN query strings never become update status messages. */
export class UpdateDownloadError extends Error {}
export interface UpdateAsset { readonly version: string; readonly tag: string; readonly name: string; readonly id: number; readonly size: number; readonly sha256: string; readonly url: string }
interface Identity { dev: number; ino: number }
export interface DownloadedInstaller {
  readonly root: string
  readonly directory: string
  readonly filename: string
  readonly directoryIdentity: Identity
  readonly rootIdentity: Identity
  readonly fileIdentity: Identity
  readonly asset: UpdateAsset
}

/** Metadata is not a filename or URL capability until every field agrees with
 * the build's repository, stable version and supported installer naming. */
export function selectUpdateAsset(metadata: Record<string, unknown>, manifestUrl: string, version: string, platform: NodeJS.Platform, arch: string): UpdateAsset | undefined {
  if (platform !== 'win32' || arch !== 'x64' || metadata.draft !== false || metadata.prerelease !== false || typeof metadata.tag_name !== 'string' || !/^v?(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(metadata.tag_name) || metadata.tag_name.replace(/^v/, '') !== version || !Array.isArray(metadata.assets)) return
  const names = new Set([`SSH.Heaven.Setup.${version}.exe`, `SSH Heaven Setup ${version}.exe`])
  const candidates = metadata.assets.filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value) && names.has((value as Record<string, unknown>).name as string))
  // Ambiguous matching assets must not make ordering choose an executable.
  if (candidates.length !== 1) return
  const asset = candidates[0]
  if (!Number.isSafeInteger(asset.id) || (asset.id as number) <= 0 || !Number.isSafeInteger(asset.size) || (asset.size as number) <= 0 || (asset.size as number) > MAX_INSTALLER_BYTES || asset.state !== 'uploaded' || typeof asset.digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest) || typeof asset.browser_download_url !== 'string' || asset.browser_download_url.length > 2048) return
  try {
    const api = new URL(manifestUrl), url = new URL(asset.browser_download_url)
    const repository = /^\/repos\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/releases\/latest$/.exec(api.pathname)
    if (api.protocol !== 'https:' || api.hostname !== 'api.github.com' || api.port || api.username || api.password || api.search || api.hash || !repository || url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return
    const segments = url.pathname.split('/')
    if (segments.length !== 7 || segments[1].toLowerCase() !== repository[1].toLowerCase() || segments[2].toLowerCase() !== repository[2].toLowerCase() || segments[3] !== 'releases' || segments[4] !== 'download' || segments[5] !== encodeURIComponent(metadata.tag_name) || segments[6] !== encodeURIComponent(asset.name as string)) return
    return Object.freeze({ version, tag: metadata.tag_name, name: asset.name as string, id: asset.id as number, size: asset.size as number, sha256: asset.digest.slice(7).toLowerCase(), url: url.href })
  } catch { return }
}

export function validateDownloadRedirect(value: string, previous: string, asset: UpdateAsset): string {
  if (value.length > 16 * 1024) throw new UpdateDownloadError('The installer server returned an invalid redirect.')
  let next: URL
  try { next = new URL(value, previous) } catch { throw new UpdateDownloadError('The installer server returned an invalid redirect.') }
  if (next.protocol !== 'https:' || next.username || next.password || next.port || next.hash || (!CDN_HOSTS.has(next.hostname) && next.href !== asset.url)) throw new UpdateDownloadError('The installer download redirected outside GitHub’s approved release servers.')
  return next.href
}

function sameIdentity(left: Identity, right: Identity): boolean { return left.dev === right.dev && left.ino === right.ino }
async function ownedDirectory(file: DownloadedInstaller): Promise<boolean> {
  if (path.dirname(file.directory) !== file.root || !/^download-[A-Za-z0-9]{6}$/.test(path.basename(file.directory)) || path.dirname(file.filename) !== file.directory || !/^installer-[a-f0-9-]{36}\.exe(?:\.part)?$/.test(path.basename(file.filename))) return false
  const root = await lstat(file.root).catch(() => undefined)
  if (!root || !root.isDirectory() || root.isSymbolicLink() || !sameIdentity(root, file.rootIdentity)) return false
  if (await realpath(file.root).catch(() => undefined) !== file.root) return false
  const metadata = await lstat(file.directory).catch(() => undefined)
  return !!metadata && metadata.isDirectory() && !metadata.isSymbolicLink() && sameIdentity(metadata, file.directoryIdentity)
}

/** Delete only the inode and empty private directory created by this operation.
 * Never recurse through a swapped directory or remove unrelated cache files. */
export async function removeDownloadedInstaller(file: DownloadedInstaller): Promise<void> {
  if (!await ownedDirectory(file)) return
  const metadata = await lstat(file.filename).catch(() => undefined)
  if (metadata && metadata.isFile() && !metadata.isSymbolicLink() && sameIdentity(metadata, file.fileIdentity)) await unlink(file.filename).catch(() => {})
  await rmdir(file.directory).catch(() => {})
}

async function responseFor(url: string, signal: AbortSignal): Promise<IncomingMessage> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal, timeout: 30_000, headers: { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity', 'User-Agent': 'SSH-Heaven-Update-Download' } }, (response) => {
      // Cover failures on redirect/error bodies as well as the selected body.
      response.on('error', () => {})
      resolve(response)
    })
    request.on('error', () => reject(new UpdateDownloadError(signal.aborted ? 'The installer download was canceled or timed out.' : 'The installer download failed. Check your connection and try again.')))
    request.on('timeout', () => request.destroy(new UpdateDownloadError('The installer download timed out. Try again.')))
  })
}

async function installerResponse(asset: UpdateAsset, signal: AbortSignal): Promise<IncomingMessage> {
  let url = asset.url
  for (let redirects = 0; ; redirects++) {
    const response = await responseFor(url, signal)
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      const location = response.headers.location
      response.destroy()
      if (redirects >= 5 || typeof location !== 'string') throw new UpdateDownloadError('The installer server returned too many or invalid redirects.')
      url = validateDownloadRedirect(location, url, asset)
      continue
    }
    if (response.statusCode !== 200) { response.destroy(); throw new UpdateDownloadError(`The installer server returned HTTP ${response.statusCode}. Try downloading again later.`) }
    const length = response.headers['content-length']
    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' || length !== undefined && (!/^\d+$/.test(length) || Number(length) !== asset.size)) {
      response.destroy()
      throw new UpdateDownloadError('The installer response size or encoding does not match the published asset.')
    }
    return response
  }
}

async function writeAll(handle: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset)
    if (!result.bytesWritten) throw new UpdateDownloadError('The installer could not be saved. Check free space and try again.')
    offset += result.bytesWritten
  }
}

function matchesDigest(actual: string, expected: string): boolean { return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')) }

export async function downloadInstaller(asset: UpdateAsset, directory: string, cancel: AbortSignal, progress: (bytes: number) => void): Promise<DownloadedInstaller> {
  const timeout = AbortSignal.timeout(10 * 60_000)
  const signal = AbortSignal.any([cancel, timeout])
  let handle: FileHandle | undefined
  let owned: DownloadedInstaller | undefined
  let response: IncomingMessage | undefined
  let complete = false
  try {
    signal.throwIfAborted()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const root = await realpath(directory)
    const rootIdentity = await lstat(root)
    if ((await lstat(directory)).isSymbolicLink() || !rootIdentity.isDirectory() || rootIdentity.isSymbolicLink()) throw new UpdateDownloadError('The update cache is not a regular directory. Choose a trusted application data location.')
    const child = await mkdtemp(path.join(root, 'download-'))
    const directoryIdentity = await lstat(child)
    const filename = path.join(child, `installer-${randomUUID()}.exe.part`)
    try { handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600) }
    catch (error) { await rmdir(child).catch(() => {}); throw error }
    const fileIdentity = await handle.stat()
    owned = { root, directory: child, filename, directoryIdentity, rootIdentity, fileIdentity, asset }
    if (!await ownedDirectory(owned)) throw new UpdateDownloadError('The update cache changed before the download. Try downloading again.')
    signal.throwIfAborted()
    response = await installerResponse(asset, signal)
    const hash = createHash('sha256')
    let bytes = 0, lastProgress = 0
    progress(0)
    for await (const value of response) {
      signal.throwIfAborted()
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      bytes += chunk.length
      if (bytes > asset.size || bytes > MAX_INSTALLER_BYTES) throw new UpdateDownloadError('The installer response exceeds its published size.')
      hash.update(chunk)
      await writeAll(handle, chunk)
      if (Date.now() - lastProgress >= 100) { lastProgress = Date.now(); progress(bytes) }
    }
    signal.throwIfAborted()
    if (bytes !== asset.size) throw new UpdateDownloadError('The installer download was incomplete. Try downloading again.')
    if (!matchesDigest(hash.digest('hex'), asset.sha256)) throw new UpdateDownloadError('The installer checksum does not match the published SHA-256 digest. Download it again.')
    await handle.sync()
    await handle.close(); handle = undefined
    signal.throwIfAborted()
    if (!await ownedDirectory(owned)) throw new UpdateDownloadError('The update cache changed during the download. Download the installer again.')
    const current = await lstat(owned.filename)
    if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(current, owned.fileIdentity)) throw new UpdateDownloadError('The installer file changed during the download. Download it again.')
    const finalPath = filename.slice(0, -5)
    if (await lstat(finalPath).catch(() => undefined)) throw new UpdateDownloadError('The update cache contains an unexpected installer file. Download it again.')
    await rename(filename, finalPath)
    owned = { ...owned, filename: finalPath }
    signal.throwIfAborted()
    progress(bytes)
    complete = true
    return owned
  } catch (error) {
    if (error instanceof UpdateDownloadError) throw error
    if (signal.aborted) throw new UpdateDownloadError(cancel.aborted ? 'The installer download was canceled.' : 'The installer download timed out. Try again.')
    throw new UpdateDownloadError('The installer could not be downloaded or saved. Check your connection, free space, and permissions, then try again.')
  } finally {
    response?.destroy()
    await handle?.close().catch(() => {})
    if (owned && !complete) await removeDownloadedInstaller(owned)
  }
}

/** Hash the entire current regular file through a native handle. A name, size,
 * prior successful download, or a renderer claim is never launch permission. */
export async function verifyInstaller(file: DownloadedInstaller): Promise<void> {
  let handle: FileHandle | undefined
  try {
    if (!await ownedDirectory(file)) throw new Error('directory')
    const named = await lstat(file.filename)
    if (!named.isFile() || named.isSymbolicLink() || !sameIdentity(named, file.fileIdentity)) throw new Error('identity')
    handle = await open(file.filename, constants.O_RDONLY | NO_FOLLOW)
    const before = await handle.stat()
    if (!before.isFile() || before.size !== file.asset.size || !sameIdentity(before, file.fileIdentity)) throw new Error('size')
    const hash = createHash('sha256'), chunk = Buffer.allocUnsafe(256 * 1024)
    let position = 0
    while (position < file.asset.size) {
      const result = await handle.read(chunk, 0, Math.min(chunk.length, file.asset.size - position), position)
      if (!result.bytesRead) throw new Error('incomplete')
      hash.update(chunk.subarray(0, result.bytesRead)); position += result.bytesRead
    }
    const after = await handle.stat(), stillNamed = await lstat(file.filename)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || !stillNamed.isFile() || stillNamed.isSymbolicLink() || !sameIdentity(stillNamed, after) || !matchesDigest(hash.digest('hex'), file.asset.sha256)) throw new Error('checksum')
  } catch { throw new UpdateDownloadError('The downloaded installer changed or failed verification. Download it again before installing.') }
  finally { await handle?.close().catch(() => {}) }
}
