import { readFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import type { UpdateState } from '../shared/types'
import { errorMessage, record } from './validation'
import { downloadInstaller, removeDownloadedInstaller, selectUpdateAsset, UpdateDownloadError, verifyInstaller, type DownloadedInstaller, type UpdateAsset } from './update-download'

export interface ReleaseConfig { enabled: boolean; provider?: 'github' | 'manifest'; manifestUrl: string; downloadUrl: string }
function secureUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Configure a fixed HTTPS release URL.')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Release URLs must use HTTPS without credentials, query parameters, or fragments.')
  return url.href
}
export function validateReleaseConfig(value: unknown): ReleaseConfig {
  const input = record(value, 'release configuration')
  if (input.enabled !== true) return { enabled: false, manifestUrl: '', downloadUrl: '' }
  const provider = input.provider ?? 'manifest'
  if (provider !== 'github' && provider !== 'manifest') throw new Error('Choose a supported release provider: github or manifest.')
  const manifestUrl = secureUrl(input.manifestUrl), downloadUrl = secureUrl(input.downloadUrl)
  if (provider === 'github') {
    const api = new URL(manifestUrl), page = new URL(downloadUrl)
    const repository = /^\/repos\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})\/releases\/latest$/.exec(api.pathname)
    if (api.hostname !== 'api.github.com' || api.port || !repository || page.hostname !== 'github.com' || page.port || page.pathname.toLowerCase() !== `/${repository[1]}/${repository[2]}/releases/latest`.toLowerCase()) throw new Error('GitHub update URLs must use the official latest-release API and matching repository release page.')
  }
  return { enabled: true, provider, manifestUrl, downloadUrl }
}
export function newerVersion(candidate: unknown, current: string): candidate is string {
  const parse = (value: unknown) => typeof value === 'string' && value === value.trim() && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(value) ? value.split('.').map(Number) : null
  const next = parse(candidate); const installed = parse(current)
  if (!next || !installed) throw new Error('The release manifest must contain a stable version such as 0.5.1.')
  for (let i = 0; i < 3; i++) { if (next[i] !== installed[i]) return next[i] > installed[i] }
  return false
}
async function fetchManifest(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const github = new URL(url).hostname === 'api.github.com'
    const signal = AbortSignal.timeout(8000)
    const request = https.get(url, { signal, headers: { Accept: github ? 'application/vnd.github+json' : 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'SSH-Heaven-Update-Check', ...(github ? { 'X-GitHub-Api-Version': '2026-03-10' } : {}) } }, (response) => {
      // A response can fail even while draining an error/redirect body.
      response.on('error', reject)
      if (response.statusCode !== 200) {
        response.resume()
        if (github && (response.statusCode === 429 || response.statusCode === 403 && (response.headers['x-ratelimit-remaining'] === '0' || response.headers['retry-after'] !== undefined))) reject(new Error('GitHub temporarily rate-limited update checks. Try Check for updates again later.'))
        else if (github && response.statusCode === 404) reject(new Error('No published stable GitHub release is available yet. Try checking again later.'))
        else reject(new Error(`The release server returned HTTP ${response.statusCode}. Try checking again later.`))
        return
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.resume(); reject(new Error('The release server returned an unsupported compressed response. Try checking again later.')); return }
      let size = 0; const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 64 * 1024) { response.destroy(new Error('The release response exceeds the 64 KiB update-check limit.')); return }
        chunks.push(chunk)
      })
      response.on('aborted', () => reject(new Error('The update check was interrupted. Try checking again.')))
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('The release server returned an invalid version manifest.')) } })
    })
    request.on('error', (error) => reject(signal.aborted ? new Error('The update check timed out. Try checking again.') : error))
  })
}

export interface UpdateOptions {
  directory: string
  platform?: NodeJS.Platform
  arch?: string
  launchInstaller?: (filename: string) => Promise<void>
  beforeInstall?: () => Promise<void>
}
interface DownloadTask { asset: UpdateAsset; controller: AbortController; promise: Promise<UpdateState> }

/** Startup checks metadata only. Installer bytes and execution each require a
 * separate explicit native API action. Paths and asset URLs stay native. */
export class UpdateService {
  private state: UpdateState
  private config: ReleaseConfig = { enabled: false, manifestUrl: '', downloadUrl: '' }
  private busy = false
  private readonly options?: Readonly<UpdateOptions>
  private asset?: UpdateAsset
  private installer?: DownloadedInstaller
  private downloadTask?: DownloadTask
  private installTask?: Promise<void>
  private installing = false
  private launched = false
  private disposed = false
  constructor(private readonly currentVersion: string, private readonly notify: (state: UpdateState) => void, private readonly openUrl: (url: string) => Promise<void>, private readonly fetch: (url: string) => Promise<unknown> = fetchManifest, options?: UpdateOptions) {
    this.options = options ? Object.freeze({ ...options, directory: path.resolve(options.directory) }) : undefined
    this.state = { status: 'unconfigured', currentVersion, message: 'Update checks are not configured for this build.' }
  }
  getState(): UpdateState { return { ...this.state } }
  private set(next: Omit<UpdateState, 'currentVersion'>): void { this.state = { ...next, currentVersion: this.currentVersion }; this.notify(this.getState()) }
  async initialize(configPath: string): Promise<void> {
    if (this.disposed) return
    if (this.installing || this.launched) throw new Error('Cannot change update configuration while an installer is starting.')
    await this.cancelDownload()
    const previous = this.installer
    this.installer = undefined; this.asset = undefined
    if (previous) await removeDownloadedInstaller(previous)
    try {
      this.config = validateReleaseConfig(JSON.parse(await readFile(configPath, 'utf8')))
      if (this.disposed) return
      if (this.config.enabled) this.set({ status: 'idle', message: 'Checks find new versions. Download and install only when you choose.' })
      else this.set({ status: 'unconfigured', message: 'Update checks are not configured for this build.' })
    } catch (error) { this.config = { enabled: false, manifestUrl: '', downloadUrl: '' }; this.set({ status: 'error', message: errorMessage(error) }) }
  }
  async check(): Promise<UpdateState> {
    if (this.disposed || !this.config.enabled || this.busy || this.downloadTask || this.installing || this.installer) return this.getState()
    const config = this.config
    this.busy = true; this.asset = undefined; this.set({ status: 'checking' })
    try {
      const manifest = record(await this.fetch(config.manifestUrl), 'release metadata')
      if (this.disposed || this.config !== config) return this.getState()
      let version = manifest.version
      if (config.provider === 'github') {
        if (manifest.draft !== false || manifest.prerelease !== false || typeof manifest.tag_name !== 'string') throw new Error('GitHub returned an unpublished, prerelease, or invalid stable release.')
        version = manifest.tag_name.replace(/^v/, '')
      }
      const newer = newerVersion(version, this.currentVersion)
      if (newer && config.provider === 'github' && this.options?.launchInstaller) this.asset = selectUpdateAsset(manifest, config.manifestUrl, version as string, this.options.platform ?? process.platform, this.options.arch ?? process.arch)
      this.set({ status: newer ? 'available' : 'not-available', downloadAvailable: !!this.asset, ...(newer ? { version: version as string, message: `SSH Heaven ${version} is available. Download and install it when you are ready.` } : { message: 'No newer stable release is available.' }) })
    } catch (error) { if (!this.disposed && this.config === config) this.set({ status: 'error', message: errorMessage(error) }) }
    finally { this.busy = false }
    return this.getState()
  }
  async openDownload(): Promise<void> {
    if (this.disposed || !this.config.enabled || this.state.status !== 'available') throw new Error('Check for a newer release first.')
    // The destination is fixed in the release build, never supplied by a feed
    // response or renderer input. It opens a page, not an executable file.
    await this.openUrl(this.config.downloadUrl)
  }

  download(): Promise<UpdateState> {
    if (this.downloadTask) return this.downloadTask.promise
    if (this.installing || this.installer) return Promise.resolve(this.getState())
    if (this.disposed || this.busy || !this.options || !this.asset || !this.state.downloadAvailable || this.state.status !== 'available') return Promise.reject(new Error('No verified Windows x64 installer is available. Check for a newer release or open its release page.'))
    const task: DownloadTask = { asset: this.asset, controller: new AbortController(), promise: Promise.resolve(this.getState()) }
    this.downloadTask = task
    task.promise = this.performDownload(task)
    return task.promise
  }

  private async performDownload(task: DownloadTask): Promise<UpdateState> {
    const asset = task.asset
    this.set({ status: 'downloading', version: asset.version, downloadAvailable: true, downloadedBytes: 0, totalBytes: asset.size, progress: 0, message: 'Downloading the installer…' })
    try {
      const installer = await downloadInstaller(asset, this.options!.directory, task.controller.signal, (bytes) => {
        if (!this.disposed && this.downloadTask === task) this.set({ status: 'downloading', version: asset.version, downloadAvailable: true, downloadedBytes: bytes, totalBytes: asset.size, progress: Math.floor(bytes / asset.size * 100), message: 'Downloading and verifying the installer…' })
      })
      if (this.disposed || task.controller.signal.aborted || this.asset !== asset) { await removeDownloadedInstaller(installer); return this.getState() }
      this.installer = installer
      this.set({ status: 'downloaded', version: asset.version, downloadAvailable: true, downloadedBytes: asset.size, totalBytes: asset.size, progress: 100, message: 'Installer verified and ready. Install now will close active connections and restart SSH Heaven.' })
    } catch (error) {
      if (!this.disposed && this.asset === asset) this.set({ status: 'available', version: asset.version, downloadAvailable: true, message: task.controller.signal.aborted ? 'The installer download was canceled. You can download it again.' : error instanceof UpdateDownloadError ? error.message : 'The installer could not be downloaded. Try again.' })
    } finally { if (this.downloadTask === task) this.downloadTask = undefined }
    return this.getState()
  }

  async cancelDownload(): Promise<UpdateState> {
    const task = this.downloadTask
    if (task) { task.controller.abort(); await task.promise }
    return this.getState()
  }

  install(): Promise<void> {
    if (this.installTask) return this.installTask
    if (this.launched) return Promise.resolve()
    const installer = this.installer
    if (this.disposed || this.busy || this.downloadTask || !installer || this.asset !== installer.asset || this.state.status !== 'downloaded' || !this.options?.launchInstaller || !newerVersion(installer.asset.version, this.currentVersion)) return Promise.reject(new Error('Download and verify the newer installer before choosing Install now.'))
    this.installing = true
    const pending = this.performInstall(installer)
    this.installTask = pending
    void pending.then(() => { if (this.installTask === pending) this.installTask = undefined }, () => { if (this.installTask === pending) this.installTask = undefined })
    return pending
  }

  private async performInstall(installer: DownloadedInstaller): Promise<void> {
    let stage: 'verify' | 'cleanup' | 'launch' = 'verify'
    this.set({ status: 'installing', version: installer.asset.version, downloadAvailable: true, progress: 100, downloadedBytes: installer.asset.size, totalBytes: installer.asset.size, message: 'Checking the installer and closing active connections…' })
    try {
      await verifyInstaller(installer)
      if (this.disposed || this.installer !== installer || this.asset !== installer.asset) throw new Error('The update operation ended.')
      stage = 'cleanup'
      await this.options!.beforeInstall?.()
      if (this.disposed || this.installer !== installer || this.asset !== installer.asset) throw new Error('The update operation ended.')
      stage = 'verify'
      // Cleanup can await native work; never trust a hash from before that gap.
      await verifyInstaller(installer)
      if (this.disposed || this.installer !== installer || this.asset !== installer.asset) throw new Error('The update operation ended.')
      stage = 'launch'
      await this.options!.launchInstaller!(installer.filename)
      this.launched = true
    } catch (error) {
      if (this.disposed) throw new Error('The update operation ended before the installer could start.')
      if (stage === 'verify') {
        this.installer = undefined
        await removeDownloadedInstaller(installer)
        const message = error instanceof UpdateDownloadError ? error.message : 'The downloaded installer could not be verified. Download it again.'
        this.set({ status: 'available', version: installer.asset.version, downloadAvailable: true, message })
        throw new Error(message)
      }
      const message = stage === 'cleanup' ? 'Active work could not be closed. Try Install now again after closing connections and transfers.' : 'The installer could not start. Try Install now again.'
      this.set({ status: 'downloaded', version: installer.asset.version, downloadAvailable: true, progress: 100, downloadedBytes: installer.asset.size, totalBytes: installer.asset.size, message })
      throw new Error(message)
    } finally { this.installing = false }
  }

  /** Quit aborts partial transfers. A verified executable is deliberately kept:
   * the explicitly launched installer may still need to read its own file. */
  dispose(): void { this.disposed = true; this.downloadTask?.controller.abort() }
}
