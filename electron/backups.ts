import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scrypt } from 'node:crypto'
import { lstat, mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { BackupExportRequest, BackupExportResult, BackupPreview, BackupRestoreResult } from '../shared/types'
import { AppStore, validateStoredData, type StoredData } from './store'
import { CredentialVault, type PreparedCredential } from './credentials'
import { identifier, record } from './validation'
import { restrictPrivateKey } from './keygen'

const MAGIC = Buffer.from('SSHHEAVEN-BACKUP-v1\n', 'ascii')
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES + TAG_BYTES
export const MAX_BACKUP_BYTES = 32 * 1024 * 1024
const MAX_PLAINTEXT_BYTES = 24 * 1024 * 1024

function password(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 8192) throw new Error('Use a backup passphrase between 12 and 8192 characters.')
  return value
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(passphrase, salt, 32, {
    N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024,
  }, (error, key) => error ? reject(error) : resolve(key)))
}

/** Main-process only. The encrypted envelope contains no unencrypted metadata. */
export async function encryptBackup(payload: object, passphrase: unknown): Promise<Buffer> {
  const secret = password(passphrase)
  let plain: Buffer
  try { plain = Buffer.from(JSON.stringify(payload), 'utf8') } catch { throw new Error('The backup data could not be serialized.') }
  if (plain.length > MAX_PLAINTEXT_BYTES) { plain.fill(0); throw new Error('The backup contents exceed the 24 MiB limit.') }
  const salt = randomBytes(SALT_BYTES)
  const iv = randomBytes(IV_BYTES)
  const key = await deriveKey(secret, salt)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    cipher.setAAD(MAGIC)
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
    return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), ciphertext])
  } finally { key.fill(0); plain.fill(0) }
}

/** Authentication is checked before JSON is parsed or any restored file is written. */
export async function decryptBackup(contents: Uint8Array, passphrase: unknown): Promise<unknown> {
  const secret = password(passphrase)
  if (contents.byteLength <= HEADER_BYTES || contents.byteLength > MAX_BACKUP_BYTES) throw new Error('Choose a valid SSH Heaven backup under 32 MiB.')
  const bytes = Buffer.from(contents)
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('This file is not a supported SSH Heaven backup.')
  let offset = MAGIC.length
  const salt = bytes.subarray(offset, offset += SALT_BYTES)
  const iv = bytes.subarray(offset, offset += IV_BYTES)
  const tag = bytes.subarray(offset, offset += TAG_BYTES)
  const key = await deriveKey(secret, salt)
  let plain: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES })
    decipher.setAAD(MAGIC)
    decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(bytes.subarray(offset)), decipher.final()])
    if (plain.length > MAX_PLAINTEXT_BYTES) throw new Error('Too large')
    return JSON.parse(plain.toString('utf8')) as unknown
  } catch { throw new Error('The backup passphrase is incorrect or the file is damaged.') }
  finally { key.fill(0); plain?.fill(0) }
}

export const BACKUP_PREFERENCE_KEYS = ['ssh-heaven:theme', 'ssh-heaven:terminal-font-size', 'ssh-heaven-files-width'] as const
function preferences(value: unknown): Record<string, string> {
  const input = record(value ?? {}, 'backup preferences')
  const result: Record<string, string> = {}
  for (const key of BACKUP_PREFERENCE_KEYS) {
    const item = input[key]
    if (item === undefined) continue
    if (typeof item !== 'string' || item.length > 100) throw new Error('Invalid backup preferences.')
    if (key === 'ssh-heaven:theme' && !['graphite', 'midnight', 'ocean', 'forest', 'amethyst', 'ember', 'pink', 'daylight'].includes(item)) continue
    if (key === 'ssh-heaven:terminal-font-size' && (!Number.isInteger(Number(item)) || Number(item) < 10 || Number(item) > 24)) continue
    if (key === 'ssh-heaven-files-width' && (!Number.isFinite(Number(item)) || Number(item) < 320 || Number(item) > 740)) continue
    result[key] = item
  }
  return result
}
interface BackupPayload { version: 1; createdAt: number; settings: StoredData; passwords: Record<string, string>; privateKeys: { path: string; contents: string }[]; preferences: Record<string, string> }
interface PendingRestore { payload: BackupPayload; expires: number; filename: string }

/** All decrypted passwords and private-key contents remain in the main process. */
export class BackupService {
  private readonly pending = new Map<string, PendingRestore>()
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly store: AppStore, private readonly vault: CredentialVault, private readonly keyDirectory: string, private readonly keyAllowed: (filename: string) => boolean = () => true) {
    if (!path.isAbsolute(keyDirectory)) throw new Error('The managed key directory must be absolute.')
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.catch(() => {}).then(action)
    this.queue = task
    return task
  }
  export(filename: string, request: BackupExportRequest): Promise<BackupExportResult> {
    return this.serial(async () => {
      password(request.password)
      if (!path.isAbsolute(filename) || typeof request.includePasswords !== 'boolean' || typeof request.includePrivateKeys !== 'boolean') throw new Error('Invalid backup export request.')
      const settings = this.store.exportData()
      const payload: BackupPayload = { version: 1, createdAt: Date.now(), settings, passwords: Object.create(null), privateKeys: [], preferences: preferences(request.preferences) }
      if (request.includePasswords) for (const profile of settings.profiles) {
        if (profile.authType !== 'password') continue
        const saved = await this.vault.get(profile)
        if (saved !== undefined) payload.passwords[profile.id] = saved
      }
      if (request.includePrivateKeys) {
        const filenames = new Set([...settings.library.keys.map((key) => key.path), ...settings.profiles.flatMap((profile) => profile.authType === 'privateKey' && profile.privateKeyPath ? [profile.privateKeyPath] : [])])
        for (const keyPath of filenames) {
          if (!path.isAbsolute(keyPath) || !this.keyAllowed(keyPath)) throw new Error('A backup key has not been approved for file access. Choose it in the key library first.')
          const metadata = await stat(keyPath)
          if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('A private key is missing, invalid, or larger than 1 MiB.')
          const contents = await readFile(keyPath)
          if (contents.length > 1024 * 1024) throw new Error('A private key exceeds the 1 MiB limit.')
          payload.privateKeys.push({ path: keyPath, contents: contents.toString('base64') })
          contents.fill(0)
        }
      }
      const encrypted = await encryptBackup(payload, request.password)
      const handle = await open(filename, 'wx', 0o600)
      try { await handle.writeFile(encrypted); await handle.sync() } catch (error) { await handle.close(); await unlink(filename).catch(() => {}); throw error }
      await handle.close()
      return { canceled: false, hosts: settings.profiles.length, keys: payload.privateKeys.length, path: filename }
    })
  }
  preview(filename: string, passphrase: string): Promise<BackupPreview> {
    return this.serial(async () => {
      if (!path.isAbsolute(filename)) throw new Error('Choose an absolute backup path.')
      const metadata = await stat(filename)
      if (!metadata.isFile() || metadata.size > MAX_BACKUP_BYTES) throw new Error('Choose a backup file under 32 MiB.')
      const payload = this.validatePayload(await decryptBackup(await readFile(filename), passphrase))
      const existing = new Set(this.store.listProfiles().map((profile) => JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username])))
      const newHosts = payload.settings.profiles.filter((profile) => !existing.has(JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username]))).length
      for (const [id, item] of this.pending) if (item.expires < Date.now()) this.pending.delete(id)
      while (this.pending.size >= 3) this.pending.delete(this.pending.keys().next().value!)
      const token = randomUUID()
      this.pending.set(token, { payload, filename, expires: Date.now() + 10 * 60_000 })
      return { token, filename: path.basename(filename), hosts: payload.settings.profiles.length, newHosts, skippedHosts: payload.settings.profiles.length - newHosts, keys: payload.privateKeys.length, passwords: Object.keys(payload.passwords).length, runbooks: payload.settings.library.runbooks.length, workspaces: payload.settings.library.workspaces.length }
    })
  }
  restore(value: unknown): Promise<BackupRestoreResult> {
    return this.serial(async () => {
      const token = identifier(value, 'restore token')
      const pending = this.pending.get(token)
      if (!pending || pending.expires < Date.now()) { this.pending.delete(token); throw new Error('This restore preview expired. Open the backup again.') }
      const payload = structuredClone(pending.payload)
      const created: string[] = []
      const credentialIds: string[] = []
      let credentialsCommitted = false
      try {
        const paths = new Map<string, string>()
        if (payload.privateKeys.length) await mkdir(this.keyDirectory, { recursive: true, mode: 0o700 })
        for (const key of payload.privateKeys) {
          const bytes = Buffer.from(key.contents, 'base64')
          const metadata = payload.settings.library.keys.find((item) => item.path === key.path)
          let reusable: string | undefined
          if (metadata) for (const existing of this.store.getLibrary().keys.filter((item) => item.id === metadata.id || item.name === metadata.name)) {
            if (!this.keyAllowed(existing.path)) continue
            try {
              const info = await lstat(existing.path)
              if (info.isFile() && !info.isSymbolicLink() && info.size === bytes.length && (await readFile(existing.path)).equals(bytes)) { reusable = existing.path; break }
            } catch { /* A missing existing key can be replaced by a managed copy. */ }
          }
          if (reusable) { paths.set(key.path, reusable); bytes.fill(0); continue }
          const destination = path.join(this.keyDirectory, `restored-${createHash('sha256').update(bytes).digest('hex')}`)
          try {
            let exists = false
            try {
              const info = await lstat(destination)
              if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length || !(await readFile(destination)).equals(bytes)) throw new Error('A managed key destination conflicts with this backup.')
              exists = true
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
            if (!exists) {
              const handle = await open(destination, 'wx', 0o600)
              created.push(destination)
              try { await restrictPrivateKey(destination); await handle.writeFile(bytes); await handle.sync() }
              finally { await handle.close() }
            }
          } finally { bytes.fill(0) }
          paths.set(key.path, destination)
        }
        for (const key of payload.settings.library.keys) key.path = paths.get(key.path) ?? key.path
        for (const profile of payload.settings.profiles) if (profile.privateKeyPath) profile.privateKeyPath = paths.get(profile.privateKeyPath) ?? profile.privateKeyPath
        const merged = await this.store.mergeData(payload.settings, async (result) => {
          const added = new Set(result.addedProfiles.map((profile) => profile.id))
          const included = new Set<string>()
          const values = Object.entries(payload.passwords).flatMap(([oldId, secret]) => {
            const id = result.profileIds[oldId]
            const profile = result.addedProfiles.find((item) => item.id === id)
            if (!profile || !added.has(id) || included.has(id) || profile.authType !== 'password') return []
            included.add(id)
            return [{ profile, password: secret }]
          })
          const prepared: PreparedCredential[] = []
          for (let index = 0; index < values.length; index += 200) prepared.push(...await this.vault.prepare(values.slice(index, index + 200)))
          credentialIds.push(...prepared.map((item) => item.profileId))
          if (prepared.length) { await this.vault.commitPrepared(prepared, true, false); credentialsCommitted = true }
        })
        this.pending.delete(token)
        return { hosts: merged.hosts, keys: created.length, skippedHosts: merged.skippedHosts, preferences: payload.preferences }
      } catch (error) {
        if (credentialsCommitted && credentialIds.length) await this.vault.forgetMany(credentialIds).catch(() => {})
        await Promise.all(created.map((filename) => unlink(filename).catch(() => {})))
        throw error
      } finally { this.vault.releasePrepared(credentialIds) }
    })
  }
  dispose(): void { this.pending.clear() }

  private validatePayload(value: unknown): BackupPayload {
    const input = record(value, 'backup contents')
    if (input.version !== 1 || typeof input.createdAt !== 'number' || !Number.isFinite(input.createdAt)) throw new Error('Unsupported backup contents.')
    const settings = structuredClone(record(input.settings, 'backup settings'))
    const privateKeys: BackupPayload['privateKeys'] = []
    const paths = new Map<string, string>()
    if (!Array.isArray(input.privateKeys) || input.privateKeys.length > 1000) throw new Error('Invalid backup keys.')
    for (const raw of input.privateKeys) {
      const key = record(raw, 'backup key')
      if (typeof key.path !== 'string' || !key.path || key.path.length > 32768 || key.path.includes('\0') || typeof key.contents !== 'string' || key.contents.length > 1_400_000 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(key.contents) || Buffer.from(key.contents, 'base64').length > 1024 * 1024 || paths.has(key.path)) throw new Error('Invalid private key in backup.')
      const normalized = path.join(this.keyDirectory, `pending-${privateKeys.length}`)
      paths.set(key.path, normalized)
      privateKeys.push({ path: normalized, contents: key.contents })
    }
    const library = record(settings.library ?? {}, 'backup library')
    if (Array.isArray(library.keys)) library.keys = library.keys.map((value, index) => {
      const key = record(value, 'backup key metadata')
      if (typeof key.path !== 'string') throw new Error('Invalid key path in backup.')
      return { ...key, path: paths.get(key.path) ?? (path.isAbsolute(key.path) ? key.path : path.join(this.keyDirectory, `missing-key-${index}`)) }
    })
    settings.library = library
    if (Array.isArray(settings.profiles)) settings.profiles = settings.profiles.map((value) => {
      const profile = record(value, 'backup profile')
      return { ...profile, ...(typeof profile.privateKeyPath === 'string' ? { privateKeyPath: paths.get(profile.privateKeyPath) ?? (path.isAbsolute(profile.privateKeyPath) ? profile.privateKeyPath : path.join(this.keyDirectory, `missing-profile-${identifier(profile.id)}`)) } : {}) }
    })
    const validated = validateStoredData(settings)
    const secrets = record(input.passwords ?? {}, 'backup credentials')
    const passwords: Record<string, string> = Object.create(null)
    for (const [id, secret] of Object.entries(secrets)) {
      identifier(id)
      if (typeof secret !== 'string' || secret.length > 8192 || !validated.profiles.some((profile) => profile.id === id && profile.authType === 'password')) throw new Error('Invalid backup credentials.')
      passwords[id] = secret
    }
    return { version: 1, createdAt: input.createdAt, settings: validated, passwords, privateKeys, preferences: preferences(input.preferences) }
  }
}
