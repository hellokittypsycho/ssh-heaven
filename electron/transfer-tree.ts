import { lstat, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { SFTPWrapper, Stats } from 'ssh2'
import { localDownloadName, remoteFilename } from './validation'

export interface TreeEntry { relative: string; directory: boolean; size: number }
const MAX_ENTRIES = 10_000
const MAX_DEPTH = 32
function check(entries: TreeEntry[], depth: number, signal: AbortSignal): void {
  signal.throwIfAborted()
  if (entries.length >= MAX_ENTRIES || depth > MAX_DEPTH) throw new Error('Folder transfers support up to 10,000 entries and 32 nested levels.')
}
export function sftpCall<T>(invoke: (callback: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The SFTP server did not respond in time.')), 15_000)
    try { invoke((error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value) }) }
    catch (error) { clearTimeout(timer); reject(error) }
  })
}
export async function scanLocalTree(source: string, signal: AbortSignal): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = []
  async function walk(filename: string, relative: string, depth: number): Promise<void> {
    check(entries, depth, signal)
    const metadata = await lstat(filename)
    if (metadata.isSymbolicLink()) throw new Error('Folder transfers do not follow symbolic links. Remove the link from the selected folder and retry.')
    if (!metadata.isDirectory() && !metadata.isFile()) throw new Error('Folder transfers accept only regular files and directories.')
    entries.push({ relative, directory: metadata.isDirectory(), size: metadata.isFile() ? metadata.size : 0 })
    if (metadata.isDirectory()) for (const name of (await readdir(filename)).sort()) {
      remoteFilename(name)
      await walk(path.join(filename, name), relative ? `${relative}/${name}` : name, depth + 1)
    }
  }
  await walk(source, '', 0)
  return entries
}
export async function scanRemoteTree(sftp: SFTPWrapper, source: string, signal: AbortSignal): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = []
  async function walk(filename: string, relative: string, depth: number): Promise<void> {
    check(entries, depth, signal)
    const metadata = await sftpCall<Stats>((callback) => sftp.lstat(filename, callback))
    if (metadata.isSymbolicLink()) throw new Error('Folder downloads do not follow symbolic links. Select the target file or directory directly instead.')
    if (!metadata.isDirectory() && !metadata.isFile()) throw new Error('Folder downloads accept only regular files and directories.')
    entries.push({ relative, directory: metadata.isDirectory(), size: metadata.isFile() ? metadata.size : 0 })
    if (metadata.isDirectory()) {
      const children = await sftpCall<import('ssh2').FileEntryWithStats[]>((callback) => sftp.readdir(filename, callback))
      const names = new Set<string>()
      for (const child of children.sort((a, b) => a.filename.localeCompare(b.filename))) {
        if (child.filename === '.' || child.filename === '..') continue
        const name = localDownloadName(child.filename)
        const key = process.platform === 'win32' ? name.toLowerCase() : name
        if (names.has(key)) throw new Error('The remote folder contains filenames that collide on this computer.')
        names.add(key)
        await walk(path.posix.join(filename, name), relative ? `${relative}/${name}` : name, depth + 1)
      }
    }
  }
  await walk(source, '', 0)
  return entries
}
export async function ensureLocalDirectory(filename: string): Promise<void> {
  let metadata
  try { metadata = await lstat(filename) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error('A download folder conflicts with a file or symbolic link.')
  if (!metadata) await mkdir(filename)
}
export async function ensureRemoteDirectory(sftp: SFTPWrapper, filename: string): Promise<void> {
  let metadata: Stats | undefined
  try { metadata = await sftpCall<Stats>((callback) => sftp.lstat(filename, callback)) }
  catch (error) { if ((error as Error & { code?: number }).code !== 2) throw error }
  if (metadata && (!metadata.isDirectory() || metadata.isSymbolicLink())) throw new Error('An upload folder conflicts with a file or symbolic link.')
  if (!metadata) await sftpCall<void>((callback) => sftp.mkdir(filename, callback))
}
