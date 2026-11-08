/** Per-host folder metadata only. Remote file contents never enter this store. */
export interface RemoteBookmark { name: string; path: string }
export interface RemoteFolders { lastFolder?: string; bookmarks: RemoteBookmark[] }
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const REMOTE_FOLDERS_KEY = 'ssh-heaven:remote-folders:v1'
const MAX_PROFILES = 500
const MAX_BOOKMARKS = 30
const validPath = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000\r\n]/.test(value)
function clean(value: unknown): RemoteFolders {
  if (!value || typeof value !== 'object') return { bookmarks: [] }
  const source = value as Partial<RemoteFolders>
  const seen = new Set<string>()
  const bookmarks: RemoteBookmark[] = []
  if (Array.isArray(source.bookmarks)) for (const item of source.bookmarks) {
    if (!item || !validPath(item.path) || typeof item.name !== 'string' || !item.name.trim() || seen.has(item.path)) continue
    seen.add(item.path)
    bookmarks.push({ path: item.path, name: item.name.trim().slice(0, 100) })
    if (bookmarks.length === MAX_BOOKMARKS) break
  }
  return { ...(validPath(source.lastFolder) ? { lastFolder: source.lastFolder } : {}), bookmarks }
}
function readAll(storage: StorageLike): Record<string, RemoteFolders> {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(REMOTE_FOLDERS_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).slice(-MAX_PROFILES).map(([id, value]) => [id, clean(value)]))
  } catch { return {} }
}
export function getRemoteFolders(profileId: string | undefined, storage: StorageLike = localStorage): RemoteFolders {
  return profileId ? clean(readAll(storage)[profileId]) : { bookmarks: [] }
}
export function saveRemoteFolders(profileId: string | undefined, value: RemoteFolders, storage: StorageLike = localStorage): RemoteFolders {
  const next = clean(value)
  if (!profileId) return next
  try {
    const all = readAll(storage)
    delete all[profileId]
    const entries = [...Object.entries(all).slice(-(MAX_PROFILES - 1)), [profileId, next]]
    storage.setItem(REMOTE_FOLDERS_KEY, JSON.stringify(Object.fromEntries(entries)))
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('ssh-heaven:remote-folders-change'))
  } catch { /* Browsing remains available when local preference storage is full. */ }
  return next
}
