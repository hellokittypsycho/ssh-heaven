import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { HostProfile, RecentHost, LibraryState, LibraryKind, LibraryItem } from '../shared/types'
import { identifier, integer, optionalText, record, textValue } from './validation'

export function validateProfile(value: unknown): HostProfile {
  const input = record(value, 'host profile')
  const authType = input.authType
  if (authType !== 'password' && authType !== 'privateKey') throw new Error('Choose password or private key authentication.')
  const host = textValue(input.host, 'hostname', 253).trim()
  const username = textValue(input.username, 'username', 256).trim()
  const name = textValue(input.name, 'host name', 100).trim()
  if (!host || !username || !name || /\s|[\x00-\x1f]/.test(host)) throw new Error('Enter a valid hostname, username, and name.')
  if (input.favorite !== undefined && typeof input.favorite !== 'boolean') throw new Error('Invalid favorite preference.')
  if (input.autoReconnect !== undefined && typeof input.autoReconnect !== 'boolean') throw new Error('Invalid reconnect preference.')
  const jumpHostId = input.jumpHostId ? identifier(input.jumpHostId, 'jump host identifier') : undefined
  if (jumpHostId === input.id) throw new Error('A host cannot use itself as a jump host.')
  const tmuxSession = input.tmuxSession ? textValue(input.tmuxSession, 'tmux session', 64) : undefined
  if (tmuxSession && !/^[a-zA-Z0-9_-]+$/.test(tmuxSession)) throw new Error('Use letters, numbers, underscores, or dashes for the tmux session.')
  return {
    id: identifier(input.id, 'profile identifier'), name, host,
    port: integer(input.port, 'port', 1, 65535), username, authType,
    ...(authType === 'privateKey' ? { privateKeyPath: optionalText(input.privateKeyPath, 'private key path', 32768) } : {}),
    ...(input.group ? { group: optionalText(input.group, 'group', 100) } : {}),
    ...(input.favorite !== undefined ? { favorite: input.favorite as boolean } : {}),
    ...(jumpHostId ? { jumpHostId } : {}), ...(tmuxSession ? { tmuxSession } : {}),
    ...(input.autoReconnect !== undefined ? { autoReconnect: input.autoReconnect as boolean } : {})
  }
}

export interface StoredData {
  version: 1
  profiles: HostProfile[]
  knownHosts: Record<string, string>
  recentHosts: RecentHost[]
  library: LibraryState
}

const libraryFields = { runbook: 'runbooks', key: 'keys', group: 'groupDefaults', workspace: 'workspaces', tunnel: 'tunnelRules' } as const
export function emptyLibrary(): LibraryState { return { runbooks: [], keys: [], groupDefaults: [], workspaces: [], tunnelRules: [] } }
export function validateLibraryItem(kind: LibraryKind, value: unknown): LibraryItem {
  if (!Object.hasOwn(libraryFields, kind)) throw new Error('Choose a valid library item type.')
  const input = record(value, 'library item')
  const id = identifier(input.id, 'library identifier')
  const name = () => { const value = textValue(input.name, 'name', 100).trim(); if (!value) throw new Error('Enter a name.'); return value }
  if (kind === 'runbook') return { id, name: name(), command: textValue(input.command, 'runbook command', 32768), ...(input.description ? { description: textValue(input.description, 'description', 2000) } : {}), ...(input.group ? { group: textValue(input.group, 'group', 100).trim() } : {}) }
  if (kind === 'key') {
    const filename = textValue(input.path, 'private key path', 32768)
    if (!path.isAbsolute(filename)) throw new Error('Choose an absolute private key path.')
    return { id, name: name(), path: filename }
  }
  if (kind === 'group') {
    const group = textValue(input.group, 'group', 100).trim()
    const username = textValue(input.username, 'default username', 256).trim()
    if (!group || !username) throw new Error('Enter a group and default username.')
    return { id, group, username, port: integer(input.port, 'default port', 1, 65535), ...(input.keyId ? { keyId: identifier(input.keyId, 'key identifier') } : {}) }
  }
  if (kind === 'workspace') {
    if (!Array.isArray(input.profileIds) || input.profileIds.length < 1 || input.profileIds.length > 20 || !['tabs', 'split', 'grid'].includes(String(input.layout))) throw new Error('Choose 1 to 20 hosts and a valid workspace layout.')
    return { id, name: name(), profileIds: [...new Set(input.profileIds.map((item) => identifier(item, 'workspace host')))], layout: input.layout as 'tabs' | 'split' | 'grid' }
  }
  if (input.direction !== 'local' && input.direction !== 'remote') throw new Error('Choose local or remote forwarding.')
  const targetHost = textValue(input.targetHost, 'tunnel target', 253)
  if (/\s|[\x00-\x1f]/.test(targetHost)) throw new Error('Enter a valid tunnel target.')
  return { id, name: name(), direction: input.direction, bindPort: integer(input.bindPort, 'bind port', 0, 65535), targetHost, targetPort: integer(input.targetPort, 'target port', 1, 65535), ...(input.profileId ? { profileId: identifier(input.profileId, 'tunnel host') } : {}) }
}

export function validateLibrary(value: unknown): LibraryState {
  const input = value === undefined ? {} : record(value, 'library')
  const library = emptyLibrary()
  for (const [kind, field] of Object.entries(libraryFields) as [LibraryKind, keyof LibraryState][]) {
    const values = input[field] ?? []
    if (!Array.isArray(values) || values.length > 1000) throw new Error('The library contains too many items.')
    const items = values.map((item) => validateLibraryItem(kind, item))
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('The library contains duplicate identifiers.')
    ;(library[field] as LibraryItem[]) = items
  }
  return library
}

export interface MergeResult { hosts: number; keys: number; skippedHosts: number; addedProfiles: HostProfile[]; profileIds: Record<string, string> }

export function validateStoredData(value: unknown): StoredData {
  const parsed = record(value, 'settings file')
  if (parsed.version !== 1 || !Array.isArray(parsed.profiles) || parsed.profiles.length > 1000) throw new Error('Unsupported settings file format.')
  const knownHosts = record(parsed.knownHosts, 'known hosts')
  for (const fingerprint of Object.values(knownHosts)) if (typeof fingerprint !== 'string' || !/^SHA256:[a-zA-Z0-9+/]+$/.test(fingerprint)) throw new Error('Invalid saved host fingerprint.')
  if (Object.keys(knownHosts).length > 10000) throw new Error('Too many known hosts.')
  const profiles = parsed.profiles.map(validateProfile)
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) throw new Error('Duplicate saved host identifiers.')
  if (parsed.recentHosts !== undefined && !Array.isArray(parsed.recentHosts)) throw new Error('Invalid recent connection history.')
  const seen = new Set<string>()
  const recentHosts = ((parsed.recentHosts ?? []) as unknown[]).map(validateRecent).sort((a, b) => b.lastConnectedAt - a.lastConnectedAt).filter((recent) => {
    const key = endpoint(recent.profile)
    if (seen.has(key)) return false
    seen.add(key); return true
  }).slice(0, 20)
  return { version: 1, profiles, knownHosts: { ...knownHosts } as Record<string, string>, recentHosts, library: validateLibrary(parsed.library) }
}

function endpoint(profile: HostProfile): string {
  return JSON.stringify([profile.host.toLowerCase(), profile.port, profile.username])
}

function validateRecent(value: unknown): RecentHost {
  const input = record(value, 'recent connection')
  return { profile: validateProfile(input.profile), lastConnectedAt: integer(input.lastConnectedAt, 'connection time', 0, 8_640_000_000_000_000) }
}

/** Stores metadata only. Passwords and key passphrases are never written to disk. */
export class AppStore {
  private data: StoredData = { version: 1, profiles: [], knownHosts: {}, recentHosts: [], library: emptyLibrary() }
  private mutationQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly filename: string) {}

  async load(): Promise<void> {
    let source: string
    try {
      source = await readFile(this.filename, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (source.length > 4 * 1024 * 1024) throw new Error('The settings file is too large.')
    this.data = validateStoredData(JSON.parse(source))
  }

  getLibrary(): LibraryState { return structuredClone(this.data.library) }
  exportData(): StoredData { return structuredClone(this.data) }
  async saveLibraryItem(kind: LibraryKind, value: unknown): Promise<LibraryState> {
    const item = validateLibraryItem(kind, value)
    return this.mutate(() => {
      const list = this.data.library[libraryFields[kind]] as LibraryItem[]
      const index = list.findIndex((existing) => existing.id === item.id || (kind === 'group' && 'group' in existing && 'group' in item && existing.group === item.group))
      if (index >= 0 && kind === 'group') item.id = list[index].id
      if (index < 0) { if (list.length >= 1000) throw new Error('The library is full.'); list.push(item) } else list[index] = item
      return this.getLibrary()
    })
  }
  async deleteLibraryItem(kind: LibraryKind, value: unknown): Promise<LibraryState> {
    if (!Object.hasOwn(libraryFields, kind)) throw new Error('Choose a valid library item type.')
    const id = identifier(value, 'library identifier')
    return this.mutate(() => {
      const field = libraryFields[kind]
      ;(this.data.library[field] as LibraryItem[]) = (this.data.library[field] as LibraryItem[]).filter((item) => item.id !== id)
      if (kind === 'key') this.data.library.groupDefaults = this.data.library.groupDefaults.map((group) => group.keyId === id ? { ...group, keyId: undefined } : group)
      return this.getLibrary()
    })
  }
  async mergeData(value: unknown, beforeCommit?: (result: MergeResult) => Promise<void>): Promise<MergeResult> {
    const incoming = validateStoredData(value)
    return this.mutate(async () => {
      const profileIds: Record<string, string> = Object.create(null)
      const addedProfiles: HostProfile[] = []
      const ids = new Set(this.data.profiles.map((profile) => profile.id))
      const endpoints = new Map(this.data.profiles.map((profile) => [endpoint(profile), profile]))
      for (const profile of incoming.profiles) {
        const existing = endpoints.get(endpoint(profile))
        if (existing) { profileIds[profile.id] = existing.id; continue }
        let id = profile.id
        while (ids.has(id)) id = randomUUID()
        const added = { ...profile, id }
        ids.add(id); profileIds[profile.id] = id; addedProfiles.push(added); endpoints.set(endpoint(profile), added)
      }
      if (this.data.profiles.length + addedProfiles.length > 1000) throw new Error('Restoring would exceed the 1000 saved-host limit.')
      for (const profile of addedProfiles) if (profile.jumpHostId) {
        profile.jumpHostId = profileIds[profile.jumpHostId]
        if (profile.jumpHostId === profile.id) throw new Error('Restoring would make a host its own jump host.')
      }
      this.data.profiles.push(...addedProfiles)
      const keyIds: Record<string, string> = Object.create(null)
      let addedKeys = 0
      for (const [kind, field] of Object.entries(libraryFields) as [LibraryKind, keyof LibraryState][]) {
        const list = this.data.library[field] as LibraryItem[]
        for (const original of incoming.library[field] as LibraryItem[]) {
          let item = structuredClone(original)
          if (kind === 'group' && 'keyId' in item && item.keyId) item.keyId = keyIds[item.keyId]
          if (kind === 'workspace' && 'profileIds' in item) item.profileIds = [...new Set(item.profileIds.map((id) => profileIds[id]).filter(Boolean))]
          if (kind === 'workspace' && 'profileIds' in item && !item.profileIds.length) continue
          if (kind === 'tunnel' && 'profileId' in item && item.profileId) item.profileId = profileIds[item.profileId]
          const identity = (entry: LibraryItem) => {
            const { id: _id, ...rest } = entry
            return kind === 'key' && 'path' in entry ? entry.path : kind === 'group' && 'group' in entry ? entry.group : JSON.stringify(rest)
          }
          const existing = list.find((entry) => identity(entry) === identity(item))
          if (existing) { if (kind === 'key') keyIds[original.id] = existing.id; continue }
          while (list.some((entry) => entry.id === item.id)) item.id = randomUUID()
          if (list.length >= 1000) throw new Error('Restoring would exceed a library limit.')
          list.push(item)
          if (kind === 'key') { keyIds[original.id] = item.id; addedKeys++ }
        }
      }
      this.data.knownHosts = { ...incoming.knownHosts, ...this.data.knownHosts }
      if (Object.keys(this.data.knownHosts).length > 10000) throw new Error('Restoring would exceed the known-host limit.')
      const result = { hosts: addedProfiles.length, keys: addedKeys, skippedHosts: incoming.profiles.length - addedProfiles.length, addedProfiles: structuredClone(addedProfiles), profileIds }
      await beforeCommit?.(result)
      return result
    })
  }

  listProfiles(): HostProfile[] {
    return this.data.profiles.map((profile) => ({ ...profile }))
  }

  listRecentHosts(): RecentHost[] {
    return this.data.recentHosts.map((recent) => ({ profile: { ...recent.profile }, lastConnectedAt: recent.lastConnectedAt }))
  }

  async recordConnection(value: unknown): Promise<void> {
    const profile = validateProfile(value)
    const key = endpoint(profile)
    await this.mutate(() => { this.data.recentHosts = [{ profile, lastConnectedAt: Date.now() }, ...this.data.recentHosts.filter((recent) => endpoint(recent.profile) !== key)].slice(0, 20) })
  }

  async clearRecentHosts(): Promise<void> {
    await this.mutate(() => { this.data.recentHosts = [] })
  }

  async saveProfile(value: unknown): Promise<HostProfile> {
    const profile = validateProfile(value)
    return this.mutate(() => {
      const index = this.data.profiles.findIndex((item) => item.id === profile.id)
      if (index === -1) {
        if (this.data.profiles.length >= 1000) throw new Error('The saved host limit has been reached.')
        this.data.profiles.push(profile)
      } else this.data.profiles[index] = profile
      this.data.recentHosts = this.data.recentHosts.map((recent) => endpoint(recent.profile) === endpoint(profile) ? {
        ...recent, profile: { ...recent.profile, id: profile.id, name: profile.name, group: profile.group, favorite: profile.favorite }
      } : recent)
      return { ...profile }
    })
  }

  async importProfiles(values: unknown[]): Promise<HostProfile[]> {
    const profiles = values.map(validateProfile)
    return this.mutate(() => {
      const endpoints = new Set(this.data.profiles.map(endpoint))
      const ids = new Set(this.data.profiles.map((profile) => profile.id))
      const added: HostProfile[] = []
      for (const profile of profiles) {
        if (endpoints.has(endpoint(profile))) continue
        if (ids.has(profile.id)) throw new Error('An imported profile identifier already exists.')
        endpoints.add(endpoint(profile)); ids.add(profile.id); added.push(profile)
      }
      if (this.data.profiles.length + added.length > 1000) throw new Error('Importing these hosts would exceed the 1000 saved-host limit.')
      this.data.profiles.push(...added)
      return added.map((profile) => ({ ...profile }))
    })
  }

  async deleteProfile(value: unknown): Promise<void> {
    const id = identifier(value, 'profile identifier')
    await this.mutate(() => {
      this.data.profiles = this.data.profiles.filter((profile) => profile.id !== id)
      this.data.recentHosts = this.data.recentHosts.filter((recent) => recent.profile.id !== id)
      this.data.library.workspaces = this.data.library.workspaces.map((workspace) => ({ ...workspace, profileIds: workspace.profileIds.filter((profileId) => profileId !== id) })).filter((workspace) => workspace.profileIds.length > 0)
    })
  }

  getFingerprint(host: string, port: number): string | undefined {
    return this.data.knownHosts[`${host.toLowerCase()}:${port}`]
  }

  async trustFingerprint(host: string, port: number, fingerprint: string): Promise<void> {
    await this.mutate(() => { this.data.knownHosts[`${host.toLowerCase()}:${port}`] = fingerprint })
  }

  private mutate<T>(change: () => T | Promise<T>): Promise<T> {
    const task = this.mutationQueue.catch(() => {}).then(async () => {
      const previous = this.data
      this.data = structuredClone(previous)
      try {
        const result = change()
        const next = this.data
        this.data = previous
        const resolved = await result
        await this.persist(next)
        this.data = next
        return resolved
      } catch (error) { this.data = previous; throw error }
    })
    this.mutationQueue = task
    return task
  }

  private async persist(next: StoredData): Promise<void> {
    const snapshot = JSON.stringify(next, null, 2)
    if (Buffer.byteLength(snapshot, 'utf8') > 4 * 1024 * 1024) throw new Error('The settings file would exceed the 4 MiB limit.')
    await mkdir(path.dirname(this.filename), { recursive: true })
    const temporary = `${this.filename}.${process.pid}.tmp`
    await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filename)
  }
}
