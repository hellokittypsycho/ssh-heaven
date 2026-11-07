import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { parseBulkHosts } from '../shared/import'
import type { BulkImportResult, HostProfile } from '../shared/types'
import { CredentialVault } from './credentials'
import { AppStore, validateProfile } from './store'
import { record } from './validation'

function endpoint(profile: Pick<HostProfile, 'host' | 'port' | 'username'>): string {
  return JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username])
}

export class BulkImportService {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly store: AppStore, private readonly vault: CredentialVault, private readonly keyAllowed: (filename: string) => boolean) {}

  import(value: unknown): Promise<BulkImportResult> {
    const task = this.queue.catch(() => {}).then(() => this.perform(value))
    this.queue = task
    return task
  }

  private async perform(value: unknown): Promise<BulkImportResult> {
    const preview = parseBulkHosts(value)
    if (preview.errors.length) throw new Error(`Fix the import errors before importing. Line ${preview.errors[0].line}: ${preview.errors[0].message}`)
    if (!preview.entries.length) throw new Error('Add at least one valid host before importing.')
    const request = record(value, 'host import request')
    const authType = request.authType as HostProfile['authType']
    const group = typeof request.group === 'string' && request.group.trim() ? request.group.trim() : undefined
    let privateKeyPath: string | undefined
    if (authType === 'privateKey') {
      if (typeof request.privateKeyPath !== 'string' || !path.isAbsolute(request.privateKeyPath) || !this.keyAllowed(request.privateKeyPath)) throw new Error('Choose the shared SSH private key using the file picker.')
      const metadata = await stat(request.privateKeyPath)
      if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('Choose a regular SSH private key file under 1 MB.')
      privateKeyPath = request.privateKeyPath
    }
    const existing = new Set(this.store.listProfiles().map(endpoint))
    const candidates: { profile: HostProfile; password?: string }[] = []
    let skipped = preview.duplicates
    for (const entry of preview.entries) {
      const profile = validateProfile({ id: randomUUID(), name: entry.host.slice(0, 100), host: entry.host, port: request.port, username: entry.username, authType, ...(group ? { group } : {}), ...(privateKeyPath ? { privateKeyPath } : {}) })
      if (existing.has(endpoint(profile))) { skipped++; continue }
      existing.add(endpoint(profile))
      candidates.push({ profile, password: entry.password })
    }
    if (!candidates.length) return { imported: 0, skipped }
    if (this.store.listProfiles().length + candidates.length > 1000) throw new Error('Importing these hosts would exceed the 1000 saved-host limit.')
    // Encrypt every password first; no metadata is committed if any encryption
    // fails. Key-mode rows never preserve their unused password fields.
    const prepared = authType === 'password' ? await this.vault.prepare(candidates.map((candidate) => ({ profile: candidate.profile, password: candidate.password! }))) : []
    const credentialIds = prepared.map((entry) => entry.profileId)
    try {
      if (prepared.length) await this.vault.commitPrepared(prepared, true, false)
      const added = await this.store.importProfiles(candidates.map((candidate) => candidate.profile))
      const accepted = new Set(added.map((profile) => profile.id))
      const ignoredCredentials = credentialIds.filter((id) => !accepted.has(id))
      if (ignoredCredentials.length) await this.vault.forgetMany(ignoredCredentials).catch(() => {})
      return { imported: added.length, skipped: skipped + candidates.length - added.length }
    } catch (error) {
      if (credentialIds.length) await this.vault.forgetMany(credentialIds).catch(() => {})
      throw error
    } finally { this.vault.releasePrepared(credentialIds) }
  }
}
