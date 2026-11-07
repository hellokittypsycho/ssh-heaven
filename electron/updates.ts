import { readFile } from 'node:fs/promises'
import https from 'node:https'
import type { UpdateState } from '../shared/types'
import { errorMessage, record } from './validation'

export interface ReleaseConfig { enabled: boolean; manifestUrl: string; downloadUrl: string }
function secureUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Configure a fixed HTTPS release URL.')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Release URLs must use HTTPS without credentials, query parameters, or fragments.')
  return url.href
}
export function validateReleaseConfig(value: unknown): ReleaseConfig {
  const input = record(value, 'release configuration')
  if (input.enabled !== true) return { enabled: false, manifestUrl: '', downloadUrl: '' }
  return { enabled: true, manifestUrl: secureUrl(input.manifestUrl), downloadUrl: secureUrl(input.downloadUrl) }
}
export function newerVersion(candidate: unknown, current: string): candidate is string {
  const parse = (value: unknown) => typeof value === 'string' && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(value) ? value.split('.').map(Number) : null
  const next = parse(candidate); const installed = parse(current)
  if (!next || !installed) throw new Error('The release manifest must contain a stable version such as 0.5.1.')
  for (let i = 0; i < 3; i++) { if (next[i] !== installed[i]) return next[i] > installed[i] }
  return false
}
async function fetchManifest(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', 'User-Agent': 'SSH-Heaven-Update-Check' } }, (response) => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`The release server returned HTTP ${response.statusCode}.`)); return }
      let size = 0; const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 16 * 1024) { response.destroy(new Error('The release manifest is too large.')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('The release server returned an invalid version manifest.')) } })
    })
    request.on('error', reject)
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
    } catch (error) { this.set({ status: 'error', message: errorMessage(error) }) }
  }
  async check(): Promise<UpdateState> {
    if (!this.config.enabled || this.busy) return this.getState()
    this.busy = true; this.set({ status: 'checking' })
    try {
      const manifest = record(await this.fetch(this.config.manifestUrl), 'release manifest')
      const newer = newerVersion(manifest.version, this.currentVersion)
      this.set({ status: newer ? 'available' : 'not-available', ...(newer ? { version: manifest.version as string, message: `SSH Heaven ${manifest.version} is available. Download and install it when you are ready.` } : { message: 'You are using the latest stable version.' }) })
    } catch (error) { this.set({ status: 'error', message: errorMessage(error) }) }
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
