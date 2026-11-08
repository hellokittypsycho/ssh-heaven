import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { GroupCommandEvent, HostKeyChallenge, SessionStatus, SshHeavenApi, TerminalData, TransferJob, WindowState, TunnelInfo, UpdateState, McpState, WallpaperState, VaultState } from '../shared/types'
import { channels } from './channels'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Only expose named, narrowly scoped operations. Renderer code never receives raw IPC or Node APIs.
const api: SshHeavenApi = {
  listProfiles: () => ipcRenderer.invoke(channels.listProfiles),
  listRecentHosts: () => ipcRenderer.invoke(channels.listRecentHosts),
  clearRecentHosts: () => ipcRenderer.invoke(channels.clearRecentHosts),
  generateKey: (request) => ipcRenderer.invoke(channels.generateKey, request),
  getCredentialStatus: () => ipcRenderer.invoke(channels.getCredentialStatus),
  forgetCredential: (id) => ipcRenderer.invoke(channels.forgetCredential, id),
  getVaultState: () => ipcRenderer.invoke(channels.getVaultState),
  setupVaultPin: (pin) => ipcRenderer.invoke(channels.setupVaultPin, pin),
  unlockVault: (pin) => ipcRenderer.invoke(channels.unlockVault, pin),
  lockVault: () => ipcRenderer.invoke(channels.lockVault),
  changeVaultPin: (current, next) => ipcRenderer.invoke(channels.changeVaultPin, current, next),
  disableVaultPin: (pin) => ipcRenderer.invoke(channels.disableVaultPin, pin),
  getVaultSnapshot: () => ipcRenderer.invoke(channels.getVaultSnapshot),
  revealVaultPassword: (id) => ipcRenderer.invoke(channels.revealVaultPassword, id),
  copyVaultPassword: (id) => ipcRenderer.invoke(channels.copyVaultPassword, id),
  saveVaultPassword: (id, password) => ipcRenderer.invoke(channels.saveVaultPassword, id, password),
  forgetVaultPassword: (id) => ipcRenderer.invoke(channels.forgetVaultPassword, id),
  saveVaultKey: (key) => ipcRenderer.invoke(channels.saveVaultKey, key),
  deleteVaultKey: (id) => ipcRenderer.invoke(channels.deleteVaultKey, id),
  revealVaultKey: (id, password) => ipcRenderer.invoke(channels.revealVaultKey, id, password),
  onVaultState: (callback) => subscribe<VaultState>(channels.vaultState, callback),
  setNativeTheme: (appearance) => ipcRenderer.invoke(channels.setNativeTheme, appearance),
  setWindowAppearance: (appearance) => ipcRenderer.invoke(channels.setWindowAppearance, appearance),
  getWindowState: () => ipcRenderer.invoke(channels.getWindowState),
  onWindowState: (callback) => subscribe<WindowState>(channels.windowState, callback),
  getWallpaperState: () => ipcRenderer.invoke(channels.getWallpaperState),
  chooseWallpaper: () => ipcRenderer.invoke(channels.chooseWallpaper),
  setWallpaperPreferences: (preferences) => ipcRenderer.invoke(channels.setWallpaperPreferences, preferences),
  clearWallpaper: () => ipcRenderer.invoke(channels.clearWallpaper),
  onWallpaper: (callback) => subscribe<WallpaperState>(channels.wallpaper, callback),
  importHosts: (request) => ipcRenderer.invoke(channels.importHosts, request),
  runGroupCommand: (request) => ipcRenderer.invoke(channels.runGroupCommand, request),
  cancelGroupCommand: (id) => ipcRenderer.invoke(channels.cancelGroupCommand, id),
  onGroupCommand: (callback) => subscribe<GroupCommandEvent>(channels.groupCommand, callback),
  readRemoteFile: (sessionId, path) => ipcRenderer.invoke(channels.readRemoteFile, sessionId, path),
  saveRemoteFile: (sessionId, path, content, version) => ipcRenderer.invoke(channels.saveRemoteFile, sessionId, path, content, version),
  saveProfile: (profile) => ipcRenderer.invoke(channels.saveProfile, profile),
  deleteProfile: (id) => ipcRenderer.invoke(channels.deleteProfile, id),
  pickPrivateKey: () => ipcRenderer.invoke(channels.pickPrivateKey),
  connect: (request) => ipcRenderer.invoke(channels.connect, request),
  disconnect: (sessionId) => ipcRenderer.invoke(channels.disconnect, sessionId),
  write: (sessionId, data) => ipcRenderer.send(channels.write, sessionId, data),
  runTerminalScript: (sessionId, command) => ipcRenderer.invoke(channels.runTerminalScript, sessionId, command),
  resize: (sessionId, cols, rows) => ipcRenderer.send(channels.resize, sessionId, cols, rows),
  readClipboard: () => ipcRenderer.invoke(channels.readClipboard),
  writeClipboard: (text) => ipcRenderer.invoke(channels.writeClipboard, text),
  listDirectory: (sessionId, path) => ipcRenderer.invoke(channels.listDirectory, sessionId, path),
  upload: (sessionId, path) => ipcRenderer.invoke(channels.upload, sessionId, path),
  download: (sessionId, path) => ipcRenderer.invoke(channels.download, sessionId, path),
  downloadFiles: (sessionId, paths) => ipcRenderer.invoke(channels.downloadFiles, sessionId, paths),
  cancelTransfer: (id) => ipcRenderer.invoke(channels.cancelTransfer, id),
  uploadFolder: (id, directory) => ipcRenderer.invoke(channels.uploadFolder, id, directory),
  uploadDropped: (id, directory, files) => {
    if (!Array.isArray(files) || !files.length || files.length > 200) return Promise.reject(new Error('Drop between 1 and 200 files or folders.'))
    const paths = files.map((file) => webUtils.getPathForFile(file))
    if (paths.some((path) => !path)) return Promise.reject(new Error('Drop files or folders from your computer.'))
    return ipcRenderer.invoke(channels.uploadDropped, id, directory, paths)
  },
  retryTransfer: (id) => ipcRenderer.invoke(channels.retryTransfer, id),
  getLibrary: () => ipcRenderer.invoke(channels.getLibrary),
  saveLibraryItem: (kind, value) => ipcRenderer.invoke(channels.saveLibraryItem, kind, value),
  deleteLibraryItem: (kind, id) => ipcRenderer.invoke(channels.deleteLibraryItem, kind, id),
  getServerMetrics: (id) => ipcRenderer.invoke(channels.getServerMetrics, id),
  listTunnels: () => ipcRenderer.invoke(channels.listTunnels),
  startTunnel: (id, rule) => ipcRenderer.invoke(channels.startTunnel, id, rule),
  stopTunnel: (id) => ipcRenderer.invoke(channels.stopTunnel, id),
  onTunnel: (callback) => subscribe<TunnelInfo>(channels.tunnel, callback),
  exportBackup: (request) => ipcRenderer.invoke(channels.exportBackup, request),
  previewBackup: (password) => ipcRenderer.invoke(channels.previewBackup, password),
  restoreBackup: (token) => ipcRenderer.invoke(channels.restoreBackup, token),
  getUpdateState: () => ipcRenderer.invoke(channels.getUpdateState),
  checkForUpdates: () => ipcRenderer.invoke(channels.checkForUpdates),
  openUpdateDownload: () => ipcRenderer.invoke(channels.openUpdateDownload),
  downloadUpdate: () => ipcRenderer.invoke(channels.downloadUpdate),
  cancelUpdateDownload: () => ipcRenderer.invoke(channels.cancelUpdateDownload),
  installUpdate: () => ipcRenderer.invoke(channels.installUpdate),
  onUpdate: (callback) => subscribe<UpdateState>(channels.update, callback),
  getMcpState: () => ipcRenderer.invoke(channels.getMcpState),
  setMcpEnabled: (enabled) => ipcRenderer.invoke(channels.setMcpEnabled, enabled),
  resolveMcpApproval: (id, approved) => ipcRenderer.invoke(channels.resolveMcpApproval, id, approved),
  onMcpState: (callback) => subscribe<McpState>(channels.mcpState, callback),
  mkdir: (sessionId, path) => ipcRenderer.invoke(channels.mkdir, sessionId, path),
  rename: (sessionId, source, destination) => ipcRenderer.invoke(channels.rename, sessionId, source, destination),
  remove: (sessionId, path, type) => ipcRenderer.invoke(channels.remove, sessionId, path, type),
  resolveHostKey: (requestId, trusted) => ipcRenderer.invoke(channels.resolveHostKey, requestId, trusted),
  onData: (callback) => subscribe<TerminalData>(channels.data, callback),
  onStatus: (callback) => subscribe<SessionStatus>(channels.status, callback),
  onHostKey: (callback) => subscribe<HostKeyChallenge>(channels.hostKey, callback),
  onTransfer: (callback) => subscribe<TransferJob>(channels.transfer, callback)
}

contextBridge.exposeInMainWorld('sshHeaven', api)
