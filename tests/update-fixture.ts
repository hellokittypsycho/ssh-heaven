import { createHash } from 'node:crypto'
import type { ElectronApplication } from '@playwright/test'

export const GITHUB_LATEST_API = 'https://api.github.com/repos/hellokittypsycho/ssh-heaven/releases/latest'
export const GITHUB_DOWNLOAD_PAGE = 'https://github.com/hellokittypsycho/ssh-heaven/releases/latest'
const fixtureText = 'SSH Heaven inert installer download fixture; never executable.\n'
const fixtureRepeats = 32768
export const installerFixture = () => Buffer.from(fixtureText.repeat(fixtureRepeats))
export interface UpdateReply { body?: unknown; error?: string; statusCode?: number }
export interface UpdateRequest { url: string; headers: Record<string, string>; at: number }
export interface UpdateProbe { version: string; packaged: boolean; installedAt: number; requests: UpdateRequest[]; opened: string[]; installs: { filename: string; args: string[]; hidden: boolean }[] }
interface NativeFixture extends UpdateProbe { reply: UpdateReply; installerMode: 'normal' | 'corrupt' | 'slow' }

export function release(version: string): Record<string, unknown> {
  const payload = installerFixture(), name = `SSH.Heaven.Setup.${version}.exe`
  return {
    id: 1234, name: `SSH Heaven ${version}`, tag_name: `v${version}`, draft: false, prerelease: false,
    html_url: 'https://untrusted.example/releases/redirect', downloadUrl: 'https://untrusted.example/installer.exe',
    assets: [{ id: 12345, name, state: 'uploaded', size: payload.length, digest: `sha256:${createHash('sha256').update(payload).digest('hex')}`, browser_download_url: `https://github.com/hellokittypsycho/ssh-heaven/releases/download/v${version}/${name}` }],
  }
}

/** Native HTTPS and process interception keeps every automated fixture inside
 * its isolated process. No request reaches a network and no installer can run. */
export async function installUpdateFixture(app: ElectronApplication, reply?: UpdateReply): Promise<UpdateProbe> {
  return app.evaluate(({ app, shell }, options) => {
    // tsx names nested callbacks through this identity helper; evaluate runs
    // them in the isolated Electron context rather than the test's module.
    Object.defineProperty(globalThis, '__name', { configurable: true, value: Function('value', 'return value') })
    const https = process.getBuiltinModule('https')
    const childProcess = process.getBuiltinModule('child_process')
    const { EventEmitter } = process.getBuiltinModule('events')
    const { PassThrough } = process.getBuiltinModule('stream')
    const target = globalThis as unknown as { sshHeavenUpdateFixture: NativeFixture }
    const fixture: NativeFixture = {
      version: app.getVersion(), packaged: app.isPackaged, installedAt: Date.now(), requests: [], opened: [], installs: [], installerMode: 'normal',
      reply: options.reply ?? { body: { tag_name: `v${app.getVersion()}`, draft: false, prerelease: false } },
    }
    target.sshHeavenUpdateFixture = fixture
    childProcess.spawn = ((filename: string, args: string[], opts: { windowsHide?: boolean }) => {
      fixture.installs.push({ filename, args: [...args], hidden: opts.windowsHide === true })
      throw new Error('Installer launch intercepted by background test')
    }) as unknown as typeof childProcess.spawn
    https.get = ((url: string | URL, requestOptions: { headers?: Record<string, string>; signal?: AbortSignal }, callback: (response: unknown) => void) => {
      const requestedUrl = String(url)
      fixture.requests.push({ url: requestedUrl, headers: Object.fromEntries(Object.entries(requestOptions?.headers || {}).map(([name, value]) => [name.toLowerCase(), String(value)])), at: Date.now() })
      const request = new EventEmitter() as InstanceType<typeof EventEmitter> & { destroy: (error?: Error) => void }
      let incoming: InstanceType<typeof PassThrough> | undefined
      request.destroy = (error) => { incoming?.destroy(error); if (error) request.emit('error', error) }
      const abort = () => request.destroy(new Error('Fixture request canceled'))
      requestOptions.signal?.addEventListener('abort', abort, { once: true })
      const response = structuredClone(fixture.reply), mode = fixture.installerMode
      process.nextTick(() => {
        if (requestOptions.signal?.aborted) { abort(); return }
        incoming = new PassThrough()
        incoming.once('close', () => requestOptions.signal?.removeEventListener('abort', abort))
        if (requestedUrl === options.endpoint) {
          if (response.error) { request.emit('error', new Error(response.error)); return }
          Object.assign(incoming, { statusCode: response.statusCode ?? 200, headers: { 'content-type': 'application/json' } })
          callback(incoming); incoming.end(JSON.stringify(response.body)); return
        }
        if (!/^https:\/\/github\.com\/hellokittypsycho\/ssh-heaven\/releases\/download\/v\d+\.\d+\.\d+\/SSH\.Heaven\.Setup\.\d+\.\d+\.\d+\.exe$/.test(requestedUrl)) {
          request.emit('error', new Error('Unexpected HTTPS URL in update test')); return
        }
        const payload = Buffer.from(options.fixtureText.repeat(options.fixtureRepeats))
        if (mode === 'corrupt') payload[0] ^= 1
        Object.assign(incoming, { statusCode: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(payload.length) } })
        callback(incoming)
        let offset = 0
        const pump = () => {
          if (!incoming || incoming.destroyed) return
          if (offset >= payload.length) { incoming.end(); return }
          const end = Math.min(payload.length, offset + 64 * 1024)
          incoming.write(payload.subarray(offset, end)); offset = end
          setTimeout(pump, mode === 'slow' ? 80 : 10)
        }
        pump()
      })
      return request
    }) as typeof https.get
    shell.openExternal = async (url) => { fixture.opened.push(url) }
    return { version: fixture.version, packaged: fixture.packaged, installedAt: fixture.installedAt, requests: [], opened: [], installs: [] }
  }, { endpoint: GITHUB_LATEST_API, reply, fixtureText, fixtureRepeats })
}

export async function setUpdateReply(app: ElectronApplication, reply: UpdateReply): Promise<void> {
  await app.evaluate((_electron, reply) => { (globalThis as unknown as { sshHeavenUpdateFixture: NativeFixture }).sshHeavenUpdateFixture.reply = reply }, reply)
}
export async function setInstallerMode(app: ElectronApplication, mode: NativeFixture['installerMode']): Promise<void> {
  await app.evaluate((_electron, mode) => { (globalThis as unknown as { sshHeavenUpdateFixture: NativeFixture }).sshHeavenUpdateFixture.installerMode = mode }, mode)
}
export function updateProbe(app: ElectronApplication): Promise<UpdateProbe> {
  return app.evaluate(() => {
    const fixture = (globalThis as unknown as { sshHeavenUpdateFixture: NativeFixture }).sshHeavenUpdateFixture
    return { version: fixture.version, packaged: fixture.packaged, installedAt: fixture.installedAt, requests: fixture.requests, opened: fixture.opened, installs: fixture.installs }
  })
}
