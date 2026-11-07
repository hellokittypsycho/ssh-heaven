import type { ElectronApplication } from '@playwright/test'

export const GITHUB_LATEST_API = 'https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest'
export const GITHUB_DOWNLOAD_PAGE = 'https://github.com/hellokittypsycho/ssh-heaven/releases/latest'
export interface UpdateReply { body?: unknown; error?: string; statusCode?: number }
export interface UpdateRequest { url: string; headers: Record<string, string>; at: number }
export interface UpdateProbe { version: string; packaged: boolean; installedAt: number; requests: UpdateRequest[]; opened: string[] }
interface NativeFixture extends UpdateProbe { reply: UpdateReply }

export function release(version: string): Record<string, unknown> {
  return {
    id: 1234, name: `SSH Heaven ${version}`, tag_name: `v${version}`, draft: false, prerelease: false,
    html_url: 'https://untrusted.example/releases/redirect',
    downloadUrl: 'https://untrusted.example/installer.exe',
    assets: [{ name: 'Untrusted Setup.exe', browser_download_url: 'https://untrusted.example/installer.exe' }],
  }
}

/** Patches the actual Node HTTPS module used by the packaged main bundle.
 * No request is delegated to the network; only explicit browser-open calls are
 * recorded, so startup checks cannot open the user's browser or fetch an exe. */
export async function installUpdateFixture(app: ElectronApplication, reply?: UpdateReply): Promise<UpdateProbe> {
  return app.evaluate(({ app, shell }, options) => {
    const https = process.getBuiltinModule('https')
    const { EventEmitter } = process.getBuiltinModule('events')
    const { PassThrough } = process.getBuiltinModule('stream')
    const target = globalThis as unknown as { sshHeavenUpdateFixture: NativeFixture }
    target.sshHeavenUpdateFixture = {
      version: app.getVersion(), packaged: app.isPackaged, installedAt: Date.now(), requests: [], opened: [],
      reply: options.reply ?? { body: { tag_name: `v${app.getVersion()}`, draft: false, prerelease: false } },
    }
    https.get = ((url: string | URL, requestOptions: { headers?: Record<string, string> }, callback: (response: unknown) => void) => {
      const fixture = target.sshHeavenUpdateFixture
      const requestedUrl = String(url)
      fixture.requests.push({ url: requestedUrl, headers: Object.fromEntries(Object.entries(requestOptions?.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)])), at: Date.now() })
      const request = new EventEmitter()
      const response = structuredClone(fixture.reply)
      process.nextTick(() => {
        if (requestedUrl !== options.endpoint) { request.emit('error', new Error('Unexpected HTTPS URL in update test')); return }
        if (response.error) { request.emit('error', new Error(response.error)); return }
        const incoming = new PassThrough()
        Object.assign(incoming, { statusCode: response.statusCode ?? 200, headers: { 'content-type': 'application/json' } })
        callback(incoming)
        incoming.end(JSON.stringify(response.body))
      })
      return request
    }) as typeof https.get
    shell.openExternal = async (url) => { target.sshHeavenUpdateFixture.opened.push(url) }
    return { ...target.sshHeavenUpdateFixture, reply: undefined }
  }, { endpoint: GITHUB_LATEST_API, reply })
}

export async function setUpdateReply(app: ElectronApplication, reply: UpdateReply): Promise<void> {
  await app.evaluate((_electron, reply) => { (globalThis as unknown as { sshHeavenUpdateFixture: NativeFixture }).sshHeavenUpdateFixture.reply = reply }, reply)
}
export function updateProbe(app: ElectronApplication): Promise<UpdateProbe> {
  return app.evaluate(() => {
    const fixture = (globalThis as unknown as { sshHeavenUpdateFixture: NativeFixture }).sshHeavenUpdateFixture
    return { version: fixture.version, packaged: fixture.packaged, installedAt: fixture.installedAt, requests: fixture.requests, opened: fixture.opened }
  })
}
