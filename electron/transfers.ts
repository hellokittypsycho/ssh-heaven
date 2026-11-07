import { dialog, type BrowserWindow } from 'electron'
import type { TransferResult } from '../shared/types'
import type { SshService } from './ssh-service'
import type { TransferManager } from './transfer-manager'
import { remotePath } from './validation'

export async function confirmReplace(window: BrowserWindow, filename: string, signal: AbortSignal): Promise<boolean> {
  const result = await dialog.showMessageBox(window, {
    type: 'warning', title: 'Replace existing file?', message: 'A file with this name already exists.',
    detail: filename, buttons: ['Replace', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true, signal
  })
  return result.response === 0
}

export async function uploadFolder(window: BrowserWindow, service: SshService, transfers: TransferManager, sessionId: unknown, value: unknown): Promise<TransferResult> {
  const directory = remotePath(value)
  const ownerId = window.webContents.id
  await service.getSftp(ownerId, sessionId)
  const selection = await dialog.showOpenDialog(window, { title: 'Upload folder', buttonLabel: 'Upload folder', properties: ['openDirectory'] })
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true, files: [] }
  await service.getSftp(ownerId, sessionId)
  return transfers.upload(ownerId, sessionId, selection.filePaths, directory, (filename, signal) => confirmReplace(window, filename, signal))
}

export async function uploadDropped(window: BrowserWindow, service: SshService, transfers: TransferManager, sessionId: unknown, directoryValue: unknown, paths: unknown): Promise<TransferResult> {
  const directory = remotePath(directoryValue)
  const ownerId = window.webContents.id
  await service.getSftp(ownerId, sessionId)
  return transfers.upload(ownerId, sessionId, paths, directory, (filename, signal) => confirmReplace(window, filename, signal))
}

export async function uploadFiles(window: BrowserWindow, service: SshService, transfers: TransferManager, sessionId: unknown, value: unknown): Promise<TransferResult> {
  const directory = remotePath(value)
  const ownerId = window.webContents.id
  await service.getSftp(ownerId, sessionId)
  const selection = await dialog.showOpenDialog(window, { title: 'Upload files', buttonLabel: 'Upload', properties: ['openFile', 'multiSelections'] })
  if (selection.canceled) return { canceled: true, files: [] }
  await service.getSftp(ownerId, sessionId)
  return transfers.upload(ownerId, sessionId, selection.filePaths, directory, (filename, signal) => confirmReplace(window, filename, signal))
}

export async function downloadFiles(window: BrowserWindow, service: SshService, transfers: TransferManager, sessionId: unknown, value: unknown): Promise<TransferResult> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 200) throw new Error('Select between 1 and 200 remote files to download.')
  const sources = value.map(remotePath)
  const ownerId = window.webContents.id
  await service.getSftp(ownerId, sessionId)
  const selection = await dialog.showOpenDialog(window, { title: 'Choose download folder', buttonLabel: 'Download here', properties: ['openDirectory', 'createDirectory'] })
  if (selection.canceled || !selection.filePaths[0]) return { canceled: true, files: [] }
  await service.getSftp(ownerId, sessionId)
  return transfers.download(ownerId, sessionId, sources, selection.filePaths[0], (filename, signal) => confirmReplace(window, filename, signal))
}

export function downloadFile(window: BrowserWindow, service: SshService, transfers: TransferManager, sessionId: unknown, value: unknown): Promise<TransferResult> {
  return downloadFiles(window, service, transfers, sessionId, [remotePath(value)])
}
