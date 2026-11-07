import { readFile } from 'node:fs/promises'
import https from 'node:https'
import type { UpdateState } from '../shared/types'
import { errorMessage, record } from './validation'

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
        if (github && (response.statusCode === 429 || response.statusCode === 403 && (response.headers['x-ratelimit-remaining'] === '0' || response.headers['retry-after'] !== undefined))) reject(new Error('GitHub temporarily rate-limited update checks. Try Check for updates again later. Downloads and installation remain manual.'))
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

/** Checks version metadata only. Download and installation always stay manual. */
export class UpdateService {
  private state: UpdateState
  private config: ReleaseConfig = { enabled: false, manifestUrl: '', downloadUrl: '' }
  private busy = false
  constructor(private readonly currentVersion: string, private readonly notify: (state: UpdateState) => void, private readonly openUrl: (url: string) => Promise<void>, private readonly fetch: (url: string) => Promise<unknown> = fetchManifest) {
    this.state = { status: 'unconfigured', currentVersion, message: 'Update notifications are not configured for this build. Downloads and installation are always manual.' }
  }
  getState(): UpdateState { return { ...this.state } }
  private set(next: Omit<UpdateState, 'currentVersion'>): void { this.state = { ...next, currentVersion: this.currentVersion }; this.notify(this.getState()) }
  async initialize(configPath: string): Promise<void> {
    try {
      this.config = validateReleaseConfig(JSON.parse(await readFile(configPath, 'utf8')))
      if (this.config.enabled) this.set({ status: 'idle', message: 'Checks notify you about new versions. Downloads and installation stay manual.' })
      else this.set({ status: 'unconfigured', message: 'Update notifications are not configured for this build. Downloads and installation are always manual.' })
    } catch (error) { this.config = { enabled: false, manifestUrl: '', downloadUrl: '' }; this.set({ status: 'error', message: errorMessage(error) }) }
  }
  async check(): Promise<UpdateState> {
    if (!this.config.enabled || this.busy) return this.getState()
    const config = this.config
    this.busy = true; this.set({ status: 'checking' })
    try {
      const manifest = record(await this.fetch(config.manifestUrl), 'release metadata')
      if (this.config !== config) return this.getState()
      let version = manifest.version
      if (config.provider === 'github') {
        if (manifest.draft !== false || manifest.prerelease !== false || typeof manifest.tag_name !== 'string') throw new Error('GitHub returned an unpublished, prerelease, or invalid stable release.')
        version = manifest.tag_name.replace(/^v/, '')
      }
      const newer = newerVersion(version, this.currentVersion)
      this.set({ status: newer ? 'available' : 'not-available', ...(newer ? { version: version as string, message: `SSH Heaven ${version} is available. Download and install it when you are ready.` } : { message: 'No newer stable release is available.' }) })
    } catch (error) { if (this.config === config) this.set({ status: 'error', message: errorMessage(error) }) }
    finally { this.busy = false }
    return this.getState()
  }
  async openDownload(): Promise<void> {
    if (!this.config.enabled || this.state.status !== 'available') throw new Error('Check for a newer release first.')
    // The destination is fixed in the release build, never supplied by a feed
    // response or renderer input. It opens a page, not an executable file.
    await this.openUrl(this.config.downloadUrl)
  }
}
