import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import { lstat, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { HostProfile, SavedKey, VaultSnapshot, VaultState } from '../shared/types'
import { credentialBinding, type CredentialCipher, type CredentialVault } from './credentials'
import { restrictPrivateKey } from './keygen'
import { validateLibraryItem, type AppStore } from './store'
import { identifier } from './validation'

interface PinRecord { version: 1; enabled: boolean; salt?: string; hash?: string; failures: number; lockouts: number; lockedUntil: number }
interface Grant { expires: number; timer: ReturnType<typeof setTimeout> }
interface Options {
  store: AppStore
  vault: CredentialVault
  cipher: CredentialCipher
  clipboard: { readText(): string | Promise<string>; writeText(value: string): void | Promise<void> }
  keyAllowed(filename: string): boolean | Promise<boolean>
  onState(ownerId: number, state: VaultState): void
  clock?: () => number
  unlockTimeoutMs?: number
  clipboardTimeoutMs?: number
}
const empty = (): PinRecord => ({ version: 1, enabled: false, failures: 0, lockouts: 0, lockedUntil: 0 })
const PIN = /^[0-9]{5}$/
function validatePin(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 5 || !PIN.test(value)) throw new Error('Enter exactly five digits for the vault PIN.')
  return value
}
function derive(pin: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pin, Buffer.from(salt, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)))
}
function parseRecord(value: unknown): PinRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid encrypted PIN settings.')
  const item = value as PinRecord
  if (item.version !== 1 || typeof item.enabled !== 'boolean' || !Number.isSafeInteger(item.failures) || item.failures < 0 || item.failures > 4 || !Number.isSafeInteger(item.lockouts) || item.lockouts < 0 || item.lockouts > 32 || !Number.isSafeInteger(item.lockedUntil) || item.lockedUntil < 0 || item.lockedUntil > 8_640_000_000_000_000 || (item.enabled && (typeof item.salt !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(item.salt) || typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/.test(item.hash)))) throw new Error('Invalid encrypted PIN settings.')
  return { version: 1, enabled: item.enabled, failures: item.failures, lockouts: item.lockouts, lockedUntil: item.lockedUntil, ...(item.enabled ? { salt: item.salt, hash: item.hash } : {}) }
}

/** PIN gates explicit management only. SSH authentication keeps using the OS vault directly. */
export class VaultManager {
  private record = empty()
  private available = false
  private blocked = false
  private error?: string
  private disposed = false
  private queue: Promise<unknown> = Promise.resolve()
  private readonly owners = new Set<number>()
  private readonly grants = new Map<number, Grant>()
  private readonly epochs = new Map<number, number>()
  private globalEpoch = 0
  private copied?: { ownerId: number; value: string; timer: ReturnType<typeof setTimeout> }
  private clipboardCleanup: Promise<void> = Promise.resolve()

  constructor(private readonly filename: string, private readonly options: Options) {
    if (!path.isAbsolute(filename)) throw new Error('The vault PIN settings path must be absolute.')
  }
  private now(): number { return (this.options.clock ?? Date.now)() }
  private owner(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid vault window.')
    this.owners.add(value)
  }
  private view(ownerId?: number): VaultState {
    const grant = ownerId === undefined ? undefined : this.grants.get(ownerId)
    const locked = this.record.lockedUntil > this.now()
    return { pinEnabled: this.record.enabled || this.blocked, unlocked: !!grant && grant.expires > this.now() && !locked && !this.blocked && this.available, available: this.available, remainingAttempts: locked ? 0 : 5 - this.record.failures, ...(locked ? { lockedUntil: this.record.lockedUntil } : {}), ...(grant && grant.expires > this.now() ? { unlocksUntil: grant.expires } : {}), ...(this.error ? { error: this.error } : {}) }
  }
  getState(ownerId: number): VaultState {
    this.owner(ownerId)
    const grant = this.grants.get(ownerId)
    if (grant && grant.expires <= this.now()) this.lock(ownerId)
    return this.view(ownerId)
  }
  async load(): Promise<void> {
    try { this.available = await this.options.cipher.available() } catch { this.available = false }
    try {
      const metadata = await lstat(this.filename)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024) throw new Error('Invalid PIN settings file.')
      if (!this.available) throw new Error('Secure storage is unavailable.')
      const envelope = JSON.parse(await readFile(this.filename, 'utf8')) as { version?: number; encrypted?: string }
      if (envelope.version !== 1 || typeof envelope.encrypted !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.encrypted)) throw new Error('Invalid PIN settings file.')
      this.record = parseRecord(JSON.parse(await this.options.cipher.decrypt(Buffer.from(envelope.encrypted, 'base64'))))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.blocked = true; this.error = 'The protected vault PIN settings could not be unlocked. Quick connect is still available.' }
    }
  }
  private notify(ownerId?: number): void {
    for (const id of ownerId === undefined ? this.owners : [ownerId]) this.options.onState(id, this.view(id))
  }
  private async ready(): Promise<void> {
    if (this.disposed) throw new Error('The vault manager is shutting down.')
    try { this.available = await this.options.cipher.available() } catch { this.available = false }
    if (!this.available) { this.lock(); throw new Error('OS-protected credential storage is unavailable on this device.') }
    if (this.blocked) throw new Error(this.error)
  }
  private epoch(ownerId: number): string { return `${this.globalEpoch}:${this.epochs.get(ownerId) ?? 0}` }
  private unchangedEpoch(ownerId: number, epoch: string): void { if (this.disposed || this.epoch(ownerId) !== epoch) throw new Error('The vault was locked while this request was running.') }
  private grant(ownerId: number): Grant {
    this.owner(ownerId)
    const grant = this.grants.get(ownerId)
    if (!grant || grant.expires <= this.now() || !this.record.enabled || this.blocked || !this.available || this.record.lockedUntil > this.now() || this.disposed) { if (grant) this.lock(ownerId); throw new Error('Unlock the vault before managing saved credentials.') }
    return grant
  }
  private sameGrant(ownerId: number, grant: Grant): void { if (this.grant(ownerId) !== grant) throw new Error('The vault was locked while this request was running.') }
  /** Capture this unlock, so locking then unlocking cannot revive a pending request. */
  authorizeRequest(ownerId: number): () => void {
    const grant = this.grant(ownerId)
    return () => this.sameGrant(ownerId, grant)
  }
  private unlockGrant(ownerId: number): VaultState {
    this.lock(ownerId)
    const expires = this.now() + (this.options.unlockTimeoutMs ?? 5 * 60_000)
    const timer = setTimeout(() => this.lock(ownerId), this.options.unlockTimeoutMs ?? 5 * 60_000)
    timer.unref()
    this.grants.set(ownerId, { expires, timer })
    this.notify(ownerId)
    return this.view(ownerId)
  }
  lock(ownerId?: number): VaultState {
    if (ownerId !== undefined) { this.owner(ownerId); this.epochs.set(ownerId, (this.epochs.get(ownerId) ?? 0) + 1) }
    else this.globalEpoch++
    for (const [id, grant] of this.grants) if (ownerId === undefined || ownerId === id) { clearTimeout(grant.timer); this.grants.delete(id) }
    if (this.copied && (ownerId === undefined || ownerId === this.copied.ownerId)) void this.clearClipboard()
    this.notify(ownerId)
    return this.view(ownerId)
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => {}).then(operation)
    this.queue = task
    return task
  }
  private async persist(next: PinRecord, guard?: () => void): Promise<void> {
    const encrypted = await this.options.cipher.encrypt(JSON.stringify(next))
    if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 96 * 1024) throw new Error('The vault PIN settings could not be encrypted.')
    guard?.()
    await mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try { await restrictPrivateKey(temporary); await handle.writeFile(JSON.stringify({ version: 1, encrypted: encrypted.toString('base64') })); await handle.sync() } finally { await handle.close() }
      guard?.()
      await rename(temporary, this.filename)
      this.record = next
    } finally { await unlink(temporary).catch(() => {}) }
  }
  private async newRecord(pin: string): Promise<PinRecord> {
    const salt = randomBytes(16).toString('base64')
    return { ...empty(), enabled: true, salt, hash: (await derive(pin, salt)).toString('hex') }
  }
  private async verify(pin: string): Promise<void> {
    if (!this.record.enabled || !this.record.salt || !this.record.hash) throw new Error('Set up a five-digit PIN before opening the vault manager.')
    if (this.record.lockedUntil > this.now()) throw new Error('Too many incorrect PIN attempts. Wait for the vault lockout to end.')
    const derived = await derive(pin, this.record.salt)
    const expected = Buffer.from(this.record.hash, 'hex')
    const correct = timingSafeEqual(derived, expected)
    derived.fill(0); expected.fill(0)
    if (!correct) {
      const next = { ...this.record, failures: this.record.failures + 1 }
      if (next.failures === 5) { next.failures = 0; next.lockouts = Math.min(32, next.lockouts + 1); next.lockedUntil = this.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(5, next.lockouts - 1)) }
      await this.persist(next)
      if (next.lockedUntil > this.now()) this.lock()
      this.notify()
      throw new Error(next.lockedUntil > this.now() ? 'Too many incorrect PIN attempts. The vault is temporarily locked.' : 'Incorrect vault PIN.')
    }
    if (this.record.failures || this.record.lockouts || this.record.lockedUntil) await this.persist({ ...this.record, failures: 0, lockouts: 0, lockedUntil: 0 })
  }
  setup(ownerId: number, value: unknown): Promise<VaultState> {
    this.owner(ownerId); const pin = validatePin(value), epoch = this.epoch(ownerId)
    return this.mutate(async () => {
      await this.ready()
      if (this.record.enabled) throw new Error('A vault PIN already exists. Unlock it before changing the PIN.')
      const next = await this.newRecord(pin)
      await this.persist(next, () => this.unchangedEpoch(ownerId, epoch))
      this.unchangedEpoch(ownerId, epoch)
      return this.unlockGrant(ownerId)
    })
  }
  unlock(ownerId: number, value: unknown): Promise<VaultState> {
    this.owner(ownerId); const pin = validatePin(value), epoch = this.epoch(ownerId)
    return this.mutate(async () => { await this.ready(); await this.verify(pin); this.unchangedEpoch(ownerId, epoch); return this.unlockGrant(ownerId) })
  }
  changePin(ownerId: number, previous: unknown, nextValue: unknown): Promise<VaultState> {
    this.owner(ownerId); const oldPin = validatePin(previous), pin = validatePin(nextValue)
    return this.mutate(async () => {
      await this.ready(); const grant = this.grant(ownerId)
      await this.verify(oldPin); this.sameGrant(ownerId, grant)
      const next = await this.newRecord(pin)
      await this.persist(next, () => this.sameGrant(ownerId, grant))
      this.sameGrant(ownerId, grant)
      this.lock()
      return this.unlockGrant(ownerId)
    })
  }
  disablePin(ownerId: number, value: unknown): Promise<VaultState> {
    this.owner(ownerId); const pin = validatePin(value)
    return this.mutate(async () => {
      await this.ready(); const grant = this.grant(ownerId)
      await this.verify(pin); this.sameGrant(ownerId, grant)
      await this.persist(empty(), () => this.sameGrant(ownerId, grant))
      return this.lock()
    })
  }
  async snapshot(ownerId: number): Promise<VaultSnapshot> {
    await this.ready(); const grant = this.grant(ownerId)
    const profiles = this.options.store.listProfiles()
    const status = await this.options.vault.status(profiles)
    const keys = await Promise.all(this.options.store.getLibrary().keys.map(async (key) => ({ ...key, available: await stat(key.path).then((item) => item.isFile(), () => false) })))
    this.sameGrant(ownerId, grant)
    return { profiles, passwordProfileIds: status.profileIds, keys }
  }
  private profile(idValue: unknown): HostProfile {
    const id = identifier(idValue, 'password profile identifier')
    const profile = this.options.store.listProfiles().find((item) => item.id === id)
    if (!profile || profile.authType !== 'password') throw new Error('This saved password host no longer exists.')
    return profile
  }
  private sameProfile(profile: HostProfile): void { if (credentialBinding(this.profile(profile.id)) !== credentialBinding(profile)) throw new Error('This saved host changed. Review its connection details before managing its password.') }
  async revealPassword(ownerId: number, id: unknown): Promise<string> {
    await this.ready(); const grant = this.grant(ownerId), profile = this.profile(id)
    const password = await this.options.vault.get(profile)
    this.sameGrant(ownerId, grant); this.sameProfile(profile)
    if (password === undefined) throw new Error('This host has no saved password.')
    return password
  }
  async copyPassword(ownerId: number, id: unknown): Promise<void> {
    const grant = this.grant(ownerId)
    const password = await this.revealPassword(ownerId, id)
    this.sameGrant(ownerId, grant)
    await this.clearClipboard()
    this.sameGrant(ownerId, grant)
    await this.options.clipboard.writeText(password)
    try { this.sameGrant(ownerId, grant) } catch (error) {
      try { if ((await this.options.clipboard.readText()) === password && !this.copied) await this.options.clipboard.writeText('') } catch { /* Clipboard may be unavailable. */ }
      throw error
    }
    const timer = setTimeout(() => { void this.clearClipboard() }, this.options.clipboardTimeoutMs ?? 30_000)
    timer.unref()
    this.copied = { ownerId, value: password, timer }
  }
  private clearClipboard(): Promise<void> {
    const copied = this.copied
    this.copied = undefined
    if (!copied) return this.clipboardCleanup
    clearTimeout(copied.timer)
    this.clipboardCleanup = (async () => {
      try { if ((await this.options.clipboard.readText()) === copied.value && !this.copied) await this.options.clipboard.writeText('') } catch { /* OS clipboard may temporarily be busy. */ }
    })()
    return this.clipboardCleanup
  }
  savePassword(ownerId: number, id: unknown, password: unknown): Promise<void> {
    return this.mutate(async () => {
      await this.ready(); const grant = this.grant(ownerId), profile = this.profile(id)
      if (typeof password !== 'string' || password.length > 8192) throw new Error('Enter a server password of at most 8192 characters.')
      const prepared = await this.options.vault.prepare([{ profile, password }])
      const guard = () => { this.sameGrant(ownerId, grant); this.sameProfile(profile) }
      guard()
      await this.options.vault.commitPrepared(prepared, false, true, guard)
    })
  }
  forgetPassword(ownerId: number, id: unknown): Promise<void> {
    return this.mutate(async () => {
      await this.ready(); const grant = this.grant(ownerId), profile = this.profile(id)
      await this.options.vault.forget(profile.id, () => { this.sameGrant(ownerId, grant); this.sameProfile(profile) })
    })
  }
  saveKey(ownerId: number, value: unknown): Promise<void> {
    return this.mutate(async () => {
      await this.ready(); const grant = this.grant(ownerId)
      const key = validateLibraryItem('key', value) as SavedKey
      if (!(await this.options.keyAllowed(key.path))) throw new Error('Choose this private key with the native file picker before saving it.')
      const metadata = await stat(key.path)
      if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('Choose a valid private key file smaller than 1 MiB.')
      this.sameGrant(ownerId, grant)
      await this.options.store.saveLibraryItem('key', key)
    })
  }
  deleteKey(ownerId: number, id: unknown): Promise<void> {
    return this.mutate(async () => { await this.ready(); this.grant(ownerId); await this.options.store.deleteLibraryItem('key', identifier(id, 'key identifier')) })
  }
  async dispose(): Promise<void> { this.disposed = true; this.lock(); await this.clearClipboard(); await this.queue.catch(() => {}) }
}
