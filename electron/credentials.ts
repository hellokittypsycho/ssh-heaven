import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CredentialStatus, HostProfile } from '../shared/types'
import { validateProfile } from './store'
import { identifier, record } from './validation'

export interface CredentialCipher {
  available(): boolean | Promise<boolean>
  encrypt(plaintext: string): Buffer | Promise<Buffer>
  decrypt(ciphertext: Buffer): string | Promise<string>
}

interface Entry { binding: string; encrypted: string }
interface VaultData { version: 1; entries: Record<string, Entry> }
export interface PreparedCredential extends Entry { profileId: string }

export function credentialBinding(profile: HostProfile): string {
  return createHash('sha256').update(JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username, profile.authType])).digest('hex')
}

/** SSH APIs expose only availability/IDs; explicit reveals are gated by VaultManager. */
export class CredentialVault {
  private data: VaultData = { version: 1, entries: Object.create(null) as Record<string, Entry> }
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private readonly pendingProfileIds = new Set<string>()

  constructor(private readonly filename: string, private readonly cipher: CredentialCipher) {}

  async load(): Promise<void> {
    let source: string
    try { source = await readFile(this.filename, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (source.length > 16 * 1024 * 1024) throw new Error('The encrypted credential vault is too large.')
    const input = record(JSON.parse(source), 'credential vault')
    if (input.version !== 1) throw new Error('Unsupported credential vault format.')
    const entries = record(input.entries, 'encrypted credentials')
    if (Object.keys(entries).length > 1000) throw new Error('The encrypted credential vault contains too many entries.')
    const validated = Object.create(null) as Record<string, Entry>
    for (const [id, value] of Object.entries(entries)) {
      identifier(id, 'credential profile identifier')
      const entry = record(value, 'encrypted credential')
      if (typeof entry.binding !== 'string' || !/^[a-f0-9]{64}$/.test(entry.binding) || typeof entry.encrypted !== 'string' || entry.encrypted.length > 128 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.encrypted)) throw new Error('Invalid encrypted credential entry.')
      validated[id] = { binding: entry.binding, encrypted: entry.encrypted }
    }
    this.data = { version: 1, entries: validated }
  }

  async status(profiles: HostProfile[]): Promise<CredentialStatus> {
    const available = await this.cipher.available()
    return {
      available,
      profileIds: available ? profiles.filter((profile) => profile.authType === 'password' && this.data.entries[profile.id]?.binding === credentialBinding(profile)).map((profile) => profile.id) : []
    }
  }

  async get(value: unknown): Promise<string | undefined> {
    const profile = validateProfile(value)
    if (!(await this.cipher.available())) throw new Error('Secure password storage is unavailable on this device. Enter your password to connect.')
    const entry = this.data.entries[profile.id]
    if (profile.authType !== 'password' || !entry || entry.binding !== credentialBinding(profile)) return undefined
    try { return await this.cipher.decrypt(Buffer.from(entry.encrypted, 'base64')) } catch {
      throw new Error('This saved password could not be unlocked. Enter your password again or forget the saved password.')
    }
  }

  async save(value: unknown, password: unknown): Promise<void> {
    const profile = validateProfile(value)
    if (typeof password !== 'string' || password.length > 8192) throw new Error('Invalid server password.')
    await this.commitPrepared(await this.prepare([{ profile, password }]))
  }

  async prepare(values: { profile: HostProfile; password: string }[]): Promise<PreparedCredential[]> {
    if (values.length > 200) throw new Error('Too many credentials in one import.')
    const validated = values.map(({ profile: value, password }) => {
      const profile = validateProfile(value)
      if (profile.authType !== 'password') throw new Error('Only server passwords can be remembered. Key passphrases are not saved.')
      if (typeof password !== 'string' || password.length > 8192) throw new Error('Invalid server password.')
      return { profile, password }
    })
    if (!(await this.cipher.available())) throw new Error('Secure password storage is unavailable on this device. The password was not saved.')
    const prepared: PreparedCredential[] = []
    for (const { profile, password } of validated) {
      const encrypted = await this.cipher.encrypt(password)
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0 || encrypted.length > 96 * 1024) throw new Error('The password could not be encrypted.')
      prepared.push({ profileId: profile.id, binding: credentialBinding(profile), encrypted: encrypted.toString('base64') })
    }
    return prepared
  }

  async commitPrepared(values: PreparedCredential[], pending = false, replace = true, guard?: () => void): Promise<void> {
    await this.mutate((entries) => {
      for (const value of values) {
        const id = identifier(value.profileId, 'credential profile identifier')
        if (!/^[a-f0-9]{64}$/.test(value.binding) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.encrypted) || value.encrypted.length > 128 * 1024) throw new Error('Invalid prepared credential.')
        if (!replace && entries[id]) throw new Error('A saved password already exists for an imported host.')
        entries[id] = { binding: value.binding, encrypted: value.encrypted }
        if (pending) this.pendingProfileIds.add(id)
      }
    }, guard)
  }

  releasePrepared(ids: string[]): void {
    for (const id of ids) this.pendingProfileIds.delete(id)
  }

  async forgetMany(ids: string[], guard?: () => void): Promise<void> {
    const validated = ids.map((id) => identifier(id, 'profile identifier'))
    await this.mutate((entries) => { for (const id of validated) delete entries[id] }, guard)
  }

  async forget(value: unknown, guard?: () => void): Promise<void> {
    const id = identifier(value, 'profile identifier')
    await this.forgetMany([id], guard)
  }

  async reconcile(profiles: HostProfile[]): Promise<void> {
    const permitted = new Map(profiles.filter((profile) => profile.authType === 'password').map((profile) => [profile.id, credentialBinding(profile)]))
    // This profile snapshot can be stale by the time the serialized mutation
    // runs. Remove only entries already obsolete at call time, and only if that
    // exact immutable entry has not been replaced by a newer save or import.
    const obsolete = Object.entries(this.data.entries).filter(([id, entry]) => !this.pendingProfileIds.has(id) && permitted.get(id) !== entry.binding)
    if (!obsolete.length) return
    await this.mutate((entries) => {
      for (const [id, snapshot] of obsolete) if (!this.pendingProfileIds.has(id) && entries[id] === snapshot) delete entries[id]
    })
  }

  private mutate(change: (entries: Record<string, Entry>) => void, guard?: () => void): Promise<void> {
    const task = this.mutationQueue.catch(() => {}).then(async () => {
      guard?.()
      const entries = Object.assign(Object.create(null), this.data.entries) as Record<string, Entry>
      change(entries)
      const next: VaultData = { version: 1, entries }
      const snapshot = JSON.stringify(next, null, 2)
      await mkdir(path.dirname(this.filename), { recursive: true })
      const temporary = `${this.filename}.${process.pid}.tmp`
      try {
        await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
        guard?.()
        await rename(temporary, this.filename)
        this.data = next
      } finally { await unlink(temporary).catch(() => {}) }
    })
    this.mutationQueue = task
    return task
  }
}
