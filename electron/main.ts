import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, nativeImage, Notification, protocol, safeStorage, shell, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron'
import { stat, writeFile } from 'node:fs/promises'
import { channels } from './channels'
import { SshService } from './ssh-service'
import { AppStore, validateProfile } from './store'
import { confirmReplace, downloadFile, downloadFiles, uploadFiles, uploadFolder, uploadDropped } from './transfers'
import { TransferManager } from './transfer-manager'
import { errorMessage, record } from './validation'
import { ManagedKeyService } from './managed-keys'
import { CredentialVault, credentialBinding, type CredentialCipher } from './credentials'
import { RemoteEditorService } from './remote-editor'
import { bindWindowChrome, registerWindowChromeIpc, windowChromeOptions } from './window-chrome'
import { BulkImportService } from './bulk-import'
import { GroupCommandManager } from './group-commands'
import { MetricsService } from './metrics'
import { TunnelManager } from './tunnels'
import { BackupService } from './backups'
import { UpdateService } from './updates'
import { McpService } from './mcp-server'
import { WallpaperService } from './wallpaper'
import { VaultManager } from './vault-manager'

let mainWindow: BrowserWindow | null = null
let service: SshService
let store: AppStore
let transfers: TransferManager
let quitting = false
let cleanupFinished = false
let cleanupPromise: Promise<void> | undefined
let generatingKey = false
let vault: CredentialVault
let vaultManager: VaultManager
let editor: RemoteEditorService
let bulkImport: BulkImportService
let groupCommands: GroupCommandManager
let metrics: MetricsService
let tunnels: TunnelManager
let backups: BackupService
let updates: UpdateService
let managedKeys: ManagedKeyService
let mcp: McpService
let wallpaper: WallpaperService
let choosingWallpaper = false
let lastMcpApprovalId: string | undefined
const approvedKeyPaths = new Set<string>()
const restoreOwners = new Map<string, number>()
// Isolated automated QA can render offscreen without taking desktop focus.
const backgroundTest = process.env.SSH_HEAVEN_BACKGROUND_TEST === '1'

protocol.registerSchemesAsPrivileged([{ scheme: 'ssh-heaven-wallpaper', privileges: { standard: true, secure: true } }])

function keyPath(value: string): string { const resolved = path.resolve(value); return process.platform === 'win32' ? resolved.toLowerCase() : resolved }
function keyAllowed(filename: string): boolean {
  const normalized = keyPath(filename)
  return approvedKeyPaths.has(normalized) || store.listProfiles().some((profile) => profile.privateKeyPath && keyPath(profile.privateKeyPath) === normalized) || store.getLibrary().keys.some((key) => keyPath(key.path) === normalized)
}
async function libraryWithKeyStatus() {
  const library = store.getLibrary()
  library.keys = await Promise.all(library.keys.map(async (key) => {
    const available = await stat(key.path).then((metadata) => metadata.isFile() && metadata.size <= 1024 * 1024, () => false)
    return { ...key, available }
  }))
  return library
}

// The standard Chromium switch also isolates application metadata for portable/test runs.
const dataDirectory = app.commandLine.getSwitchValue('user-data-dir')
if (dataDirectory) {
  if (!path.isAbsolute(dataDirectory)) throw new Error('The user data directory must be an absolute path.')
  app.setPath('userData', dataDirectory)
}

function owner(event: IpcMainInvokeEvent | IpcMainEvent): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('This request is not from the application window.')
  }
  return mainWindow
}

function send(ownerId: number, channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && mainWindow.webContents.id === ownerId) {
    mainWindow.webContents.send(channel, payload)
  }
}

async function closeOwner(ownerId: number): Promise<void> {
  vaultManager?.lock(ownerId)
  await Promise.all([transfers.cancelOwner(ownerId), groupCommands.cancelOwner(ownerId), tunnels.cancelOwner(ownerId), mcp.cancelOwner(ownerId)])
  for (const [token, id] of restoreOwners) if (id === ownerId) restoreOwners.delete(token)
  backups.dispose()
  service.disconnectOwner(ownerId)
}

function cleanlyStopWorkspace(): Promise<void> {
  if (cleanupFinished) return Promise.resolve()
  cleanupPromise ??= Promise.allSettled([transfers?.dispose(), groupCommands?.dispose(), tunnels?.dispose(), mcp?.dispose(), vaultManager?.dispose()]).then(() => {
    backups?.dispose()
    service?.dispose()
    cleanupFinished = true
  })
  return cleanupPromise
}

async function launchUpdateInstaller(filename: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('In-app installation currently supports Windows.')
  const child = spawn(filename, ['/S', '--updated', '--force-run'], { detached: true, windowsHide: true, stdio: 'ignore' })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  child.unref()
  // The installer starts only after the verified download and explicit install
  // action. The workspace has already finished closing its remote handles.
  setImmediate(() => app.quit())
}

function registerIpc(): void {
  ipcMain.handle(channels.getRemoteProperties, (event, id, path) => service.getRemoteProperties(owner(event).webContents.id, id, path))
  ipcMain.handle(channels.chmodRemote, (event, id, path, mode, version) => service.chmodRemote(owner(event).webContents.id, id, path, mode, version))
  ipcMain.handle(channels.listScriptRuns, (event) => service.listScriptRuns(owner(event).webContents.id))
  const notifiedRuns = new Set<string>()
  ipcMain.handle(channels.notifyScriptRun, (event, id) => {
    const run = service.listScriptRuns(owner(event).webContents.id).find((item) => item.id === id)
    if (!run || run.status === 'running' || notifiedRuns.has(run.id)) return
    notifiedRuns.add(run.id)
    if (notifiedRuns.size > 500) notifiedRuns.delete(notifiedRuns.values().next().value!)
    if (!backgroundTest && Notification.isSupported()) new Notification({ title: 'SSH Heaven · Script finished', body: run.status === 'completed' ? 'Script completed successfully.' : run.status === 'disconnected' ? 'Connection ended before the script finished.' : `Script failed${run.exitCode !== undefined ? ` (exit ${run.exitCode})` : ''}.` }).show()
  })
  ipcMain.handle(channels.exportTerminalLog, async (event, text) => {
    const window = owner(event)
    if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('Terminal exports support up to 16 MiB of text.')
    const result = await dialog.showSaveDialog(window, { title: 'Export terminal log', defaultPath: `SSH Heaven ${new Date().toISOString().replace(/[:.]/g, '-')}.log`, filters: [{ name: 'Terminal log', extensions: ['log', 'txt'] }] })
    if (result.canceled || !result.filePath) return false
    owner(event)
    await writeFile(result.filePath, text, { encoding: 'utf8', mode: 0o600 })
    return true
  })
  ipcMain.handle(channels.pauseTransfer, (event, id) => transfers.pause(owner(event).webContents.id, id))
  ipcMain.handle(channels.resumeTransfer, (event, id) => transfers.resume(owner(event).webContents.id, id))
  ipcMain.handle(channels.moveTransfer, (event, id, direction) => transfers.move(owner(event).webContents.id, id, direction))
  ipcMain.handle(channels.getTransferBandwidthLimit, (event) => transfers.getBandwidthLimit(owner(event).webContents.id))
  ipcMain.handle(channels.setTransferBandwidthLimit, (event, limit) => transfers.setBandwidthLimit(owner(event).webContents.id, limit))
  registerWindowChromeIpc(owner)
  ipcMain.handle(channels.getVaultState, (event) => vaultManager.getState(owner(event).webContents.id))
  ipcMain.handle(channels.setupVaultPin, (event, pin) => vaultManager.setup(owner(event).webContents.id, pin))
  ipcMain.handle(channels.unlockVault, (event, pin) => vaultManager.unlock(owner(event).webContents.id, pin))
  ipcMain.handle(channels.lockVault, (event) => vaultManager.lock(owner(event).webContents.id))
  ipcMain.handle(channels.changeVaultPin, (event, current, next) => vaultManager.changePin(owner(event).webContents.id, current, next))
  ipcMain.handle(channels.disableVaultPin, (event, pin) => vaultManager.disablePin(owner(event).webContents.id, pin))
  ipcMain.handle(channels.getVaultSnapshot, (event) => vaultManager.snapshot(owner(event).webContents.id))
  ipcMain.handle(channels.revealVaultPassword, (event, id) => vaultManager.revealPassword(owner(event).webContents.id, id))
  ipcMain.handle(channels.copyVaultPassword, (event, id) => vaultManager.copyPassword(owner(event).webContents.id, id))
  ipcMain.handle(channels.saveVaultPassword, (event, id, password) => vaultManager.savePassword(owner(event).webContents.id, id, password))
  ipcMain.handle(channels.forgetVaultPassword, (event, id) => vaultManager.forgetPassword(owner(event).webContents.id, id))
  ipcMain.handle(channels.saveVaultKey, (event, key) => vaultManager.saveKey(owner(event).webContents.id, key))
  ipcMain.handle(channels.deleteVaultKey, (event, id) => vaultManager.deleteKey(owner(event).webContents.id, id))
  ipcMain.handle(channels.revealVaultKey, async (event, id, password) => {
    const ownerId = owner(event).webContents.id
    const grant = vaultManager.authorizeRequest(ownerId)
    if (typeof id !== 'string') throw new Error('Choose a saved SSH key.')
    const key = store.getLibrary().keys.find((item) => item.id === id)
    if (!key) throw new Error('This SSH key is no longer saved.')
    const guard = () => {
      owner(event); grant()
      if (!store.getLibrary().keys.some((item) => item.id === id && item.path === key.path)) throw new Error('The saved SSH key changed while opening it.')
    }
    const revealed = await managedKeys.view(key.path, password, guard)
    guard()
    return revealed
  })
  ipcMain.handle(channels.getWallpaperState, (event) => { owner(event); return wallpaper.get() })
  ipcMain.handle(channels.chooseWallpaper, async (event) => {
    const window = owner(event)
    if (choosingWallpaper) throw new Error('A wallpaper picker is already open.')
    choosingWallpaper = true
    try {
      const result = await dialog.showOpenDialog(window, {
        title: 'Choose a wallpaper', properties: ['openFile'],
        filters: [{ name: 'Images and animated GIFs', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      })
      if (result.canceled || !result.filePaths[0]) return null
      owner(event)
      return await wallpaper.select(result.filePaths[0])
    } finally { choosingWallpaper = false }
  })
  ipcMain.handle(channels.setWallpaperPreferences, async (event, preferences) => {
    owner(event)
    return wallpaper.update(preferences)
  })
  ipcMain.handle(channels.clearWallpaper, async (event) => {
    owner(event)
    return wallpaper.clear()
  })
  ipcMain.handle(channels.getMcpState, (event) => { owner(event); return mcp.getState() })
  ipcMain.handle(channels.setMcpEnabled, (event, enabled) => mcp.setEnabled(owner(event).webContents.id, enabled))
  ipcMain.handle(channels.resolveMcpApproval, (event, id, approved) => mcp.resolveApproval(owner(event).webContents.id, id, approved))
  ipcMain.handle(channels.getLibrary, (event) => { owner(event); return libraryWithKeyStatus() })
  ipcMain.handle(channels.saveLibraryItem, async (event, kind, value) => {
    owner(event)
    if (kind === 'key') {
      const input = record(value, 'saved SSH key')
      if (typeof input.path !== 'string' || !path.isAbsolute(input.path) || !keyAllowed(input.path)) throw new Error('Choose the SSH private key using Browse.')
      const metadata = await stat(input.path)
      if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('Choose a regular private key file under 1 MiB.')
    }
    owner(event)
    await store.saveLibraryItem(kind, value)
    return libraryWithKeyStatus()
  })
  ipcMain.handle(channels.deleteLibraryItem, async (event, kind, id) => { owner(event); await store.deleteLibraryItem(kind, id); return libraryWithKeyStatus() })
  ipcMain.handle(channels.getServerMetrics, (event, id) => metrics.getServerMetrics(owner(event).webContents.id, id))
  ipcMain.handle(channels.listTunnels, (event) => tunnels.list(owner(event).webContents.id))
  ipcMain.handle(channels.startTunnel, (event, id, rule) => tunnels.start(owner(event).webContents.id, id, rule))
  ipcMain.handle(channels.stopTunnel, (event, id) => tunnels.stop(owner(event).webContents.id, id))
  ipcMain.handle(channels.getUpdateState, (event) => { owner(event); return updates.getState() })
  ipcMain.handle(channels.checkForUpdates, (event) => { owner(event); return updates.check() })
  ipcMain.handle(channels.openUpdateDownload, (event) => { owner(event); return updates.openDownload() })
  ipcMain.handle(channels.downloadUpdate, (event) => { owner(event); return updates.download() })
  ipcMain.handle(channels.cancelUpdateDownload, (event) => { owner(event); return updates.cancelDownload() })
  ipcMain.handle(channels.installUpdate, (event) => { owner(event); return updates.install() })
  ipcMain.handle(channels.exportBackup, async (event, request) => {
    const window = owner(event)
    const result = await dialog.showSaveDialog(window, { title: 'Save encrypted backup', buttonLabel: 'Save backup', defaultPath: 'SSH Heaven.sshbackup', filters: [{ name: 'SSH Heaven encrypted backup', extensions: ['sshbackup'] }] })
    if (result.canceled || !result.filePath) return { canceled: true, hosts: 0, keys: 0 }
    owner(event)
    return backups.export(result.filePath, request)
  })
  ipcMain.handle(channels.previewBackup, async (event, password) => {
    const window = owner(event)
    const result = await dialog.showOpenDialog(window, { title: 'Open encrypted backup', properties: ['openFile'], filters: [{ name: 'SSH Heaven encrypted backup', extensions: ['sshbackup'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    owner(event)
    const preview = await backups.preview(result.filePaths[0], password)
    while (restoreOwners.size >= 3) restoreOwners.delete(restoreOwners.keys().next().value!)
    restoreOwners.set(preview.token, window.webContents.id)
    return preview
  })
  ipcMain.handle(channels.restoreBackup, async (event, token) => {
    const id = owner(event).webContents.id
    if (typeof token !== 'string' || restoreOwners.get(token) !== id) throw new Error('Preview this backup before restoring it.')
    const restored = await backups.restore(token)
    restoreOwners.delete(token)
    return restored
  })
  ipcMain.handle(channels.importHosts, (event, request) => { owner(event); return bulkImport.import(request) })
  ipcMain.handle(channels.runGroupCommand, (event, request) => groupCommands.start(owner(event).webContents.id, request))
  ipcMain.handle(channels.cancelGroupCommand, (event, runId) => groupCommands.cancel(owner(event).webContents.id, runId))
  ipcMain.handle(channels.listProfiles, (event) => { owner(event); return store.listProfiles() })
  ipcMain.handle(channels.listRecentHosts, (event) => { owner(event); return store.listRecentHosts() })
  ipcMain.handle(channels.clearRecentHosts, (event) => { owner(event); return store.clearRecentHosts() })
  ipcMain.handle(channels.getCredentialStatus, (event) => { owner(event); return vault.status(store.listProfiles()) })
  ipcMain.handle(channels.forgetCredential, (event, id) => { owner(event); return vault.forget(id) })
  ipcMain.handle(channels.setNativeTheme, (event, appearance: unknown) => {
    owner(event)
    if (appearance !== 'dark' && appearance !== 'light') throw new Error('Choose a dark or light appearance.')
    nativeTheme.themeSource = appearance
  })
  ipcMain.handle(channels.readRemoteFile, (event, id, filename) => editor.read(owner(event).webContents.id, id, filename))
  ipcMain.handle(channels.saveRemoteFile, (event, id, filename, content, version) => editor.save(owner(event).webContents.id, id, filename, content, version))
  ipcMain.handle(channels.generateKey, async (event, value) => {
    owner(event)
    if (generatingKey) throw new Error('Another SSH key is being generated. Wait for it to finish.')
    generatingKey = true
    try {
      const generated = await managedKeys.generate(value, () => { owner(event) })
      approvedKeyPaths.add(keyPath(generated.privateKeyPath))
      owner(event)
      const comment = typeof value?.comment === 'string' ? value.comment.trim().slice(0, 100) : ''
      await store.saveLibraryItem('key', { id: randomUUID(), name: comment || `${generated.type === 'ed25519' ? 'Ed25519' : 'RSA'} SSH key`, path: generated.privateKeyPath })
      return generated
    } finally { generatingKey = false }
  })
  ipcMain.handle(channels.saveProfile, async (event, profile) => {
    owner(event)
    const saved = await store.saveProfile(profile)
    await vault.reconcile(store.listProfiles())
    return saved
  })
  ipcMain.handle(channels.deleteProfile, async (event, id) => {
    owner(event)
    await store.deleteProfile(id)
    await vault.forget(id)
  })
  ipcMain.handle(channels.pickPrivateKey, async (event) => {
    const result = await dialog.showOpenDialog(owner(event), { title: 'Choose SSH private key', properties: ['openFile'] })
    const selected = result.canceled ? null : result.filePaths[0] ?? null
    if (selected) approvedKeyPaths.add(keyPath(selected))
    return selected
  })
  ipcMain.handle(channels.connect, async (event, value) => {
    const ownerId = owner(event).webContents.id
    const request = record(value, 'connection request')
    const profile = validateProfile(request.profile)
    for (const flag of ['useSavedCredential', 'rememberCredential']) if (request[flag] !== undefined && typeof request[flag] !== 'boolean') throw new Error('Invalid saved password preference.')
    const usesSaved = request.useSavedCredential === true
    const remember = request.rememberCredential === true
    const isSaved = () => store.listProfiles().some((saved) => saved.id === profile.id && credentialBinding(saved) === credentialBinding(profile))
    if ((usesSaved || remember) && (profile.authType !== 'password' || !isSaved())) throw new Error('Save this host before remembering or using its saved password.')
    if (remember && !(await vault.status(store.listProfiles())).available) throw new Error('Secure password storage is unavailable. Uncheck Remember password to connect.')
    let password = request.password
    if (usesSaved) {
      password = await vault.get(profile)
      if (password === undefined) throw new Error('No saved password matches this host. Enter your password to connect.')
    }
    return service.connect({ ...request, profile, password }, ownerId, remember ? async () => {
      if (!isSaved()) throw new Error('The saved host details changed while connecting.')
      await vault.save(profile, password ?? '')
    } : undefined)
  })
  ipcMain.handle(channels.disconnect, async (event, id) => {
    const ownerId = owner(event).webContents.id
    await transfers.cancelSession(ownerId, id)
    service.disconnect(ownerId, id)
  })
  ipcMain.handle(channels.resolveHostKey, (event, id, trusted) => service.resolveHostKey(owner(event).webContents.id, id, trusted))
  ipcMain.handle(channels.readClipboard, async (event) => {
    owner(event)
    const text = await clipboard.readText()
    if (text.length > 1024 * 1024) throw new Error('Clipboard text is too large to paste (1 MB limit).')
    return text
  })
  ipcMain.handle(channels.writeClipboard, async (event, text: unknown) => {
    owner(event)
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('Invalid clipboard text (1 MB limit).')
    await clipboard.writeText(text)
  })
  ipcMain.handle(channels.listDirectory, (event, id, directory) => service.listDirectory(owner(event).webContents.id, id, directory))
  ipcMain.handle(channels.mkdir, (event, id, directory) => service.mkdir(owner(event).webContents.id, id, directory))
  ipcMain.handle(channels.rename, (event, id, source, destination) => service.rename(owner(event).webContents.id, id, source, destination))
  ipcMain.handle(channels.remove, (event, id, target, type) => service.remove(owner(event).webContents.id, id, target, type))
  ipcMain.handle(channels.upload, (event, id, directory) => uploadFiles(owner(event), service, transfers, id, directory))
  ipcMain.handle(channels.uploadFolder, (event, id, directory) => uploadFolder(owner(event), service, transfers, id, directory))
  ipcMain.handle(channels.uploadDropped, (event, id, directory, paths) => uploadDropped(owner(event), service, transfers, id, directory, paths))
  ipcMain.handle(channels.download, (event, id, filename) => downloadFile(owner(event), service, transfers, id, filename))
  ipcMain.handle(channels.downloadFiles, (event, id, filenames) => downloadFiles(owner(event), service, transfers, id, filenames))
  ipcMain.handle(channels.cancelTransfer, (event, id) => transfers.cancel(owner(event).webContents.id, id))
  ipcMain.handle(channels.retryTransfer, (event, id) => {
    const window = owner(event)
    return transfers.retry(window.webContents.id, id, (filename, signal) => confirmReplace(window, filename, signal))
  })
  ipcMain.on(channels.write, (event, id, data) => {
    // Terminal input can race a remote disconnect. Never let a late keystroke crash the host process.
    try { service.write(owner(event).webContents.id, id, data) } catch { /* Session status is reported by the transport. */ }
  })
  ipcMain.handle(channels.runTerminalScript, (event, id, command, details) => service.runTerminalScript(owner(event).webContents.id, id, command, details))
  ipcMain.on(channels.resize, (event, id, cols, rows) => {
    try { service.resize(owner(event).webContents.id, id, cols, rows) } catch { /* Ignore resize events for closed sessions. */ }
  })
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    ...windowChromeOptions(),
    width: 1440, height: 920, minWidth: 900, minHeight: 680,
    title: 'SSH Heaven', icon: path.join(__dirname, '../../build/icon.png'), show: false, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
      backgroundThrottling: !backgroundTest, offscreen: backgroundTest
    }
  })
  mainWindow = window
  if (backgroundTest) { window.webContents.setFrameRate(60); window.webContents.startPainting() }
  bindWindowChrome(window)
  window.on('focus', () => window.flashFrame(false))
  window.on('minimize', () => vaultManager?.lock(window.webContents.id))
  const ownerId = window.webContents.id
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.on('render-process-gone', () => { void closeOwner(ownerId) })
  window.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) void closeOwner(ownerId)
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  window.once('ready-to-show', () => { if (!backgroundTest) window.show() })
  window.on('closed', () => {
    void closeOwner(ownerId)
    if (mainWindow === window) mainWindow = null
  })
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  if (developmentUrl && !app.isPackaged) {
    const url = new URL(developmentUrl)
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Development UI must use a local HTTP address.')
    await window.loadURL(developmentUrl)
  } else await window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.sshheaven.desktop')
  wallpaper = new WallpaperService(path.join(app.getPath('userData'), 'wallpaper'), {
    inspectImage(bytes, image) {
      if (image.format !== 'png' && image.format !== 'jpeg') return
      const decoded = nativeImage.createFromBuffer(bytes)
      const size = decoded.getSize()
      const matchingSize = size.width === image.width && size.height === image.height
      const rotatedJpeg = image.format === 'jpeg' && size.width === image.height && size.height === image.width
      if (decoded.isEmpty() || !matchingSize && !rotatedJpeg) throw new Error('This image could not be decoded. Choose a valid PNG or JPEG.')
    },
    onChange(state) {
      if (mainWindow && !mainWindow.isDestroyed()) send(mainWindow.webContents.id, channels.wallpaper, state)
    }
  })
  await wallpaper.load()
  protocol.handle('ssh-heaven-wallpaper', (request) => wallpaper.handleRequest(request))
  store = new AppStore(path.join(app.getPath('userData'), 'settings.json'))
  await store.load()
  managedKeys = new ManagedKeyService(path.join(app.getPath('userData'), 'ssh-keys'), require.resolve('ssh2'))
  const credentialCipher: CredentialCipher = {
    async available() {
      const available = await safeStorage.isAsyncEncryptionAvailable()
      return available && (process.platform !== 'linux' || !['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend()))
    },
    encrypt: (password) => safeStorage.encryptStringAsync(password),
    decrypt: async (encrypted) => (await safeStorage.decryptStringAsync(encrypted)).result
  }
  vault = new CredentialVault(path.join(app.getPath('userData'), 'credentials.json'), credentialCipher)
  await vault.load()
  await vault.reconcile(store.listProfiles())
  vaultManager = new VaultManager(path.join(app.getPath('userData'), 'vault-lock.json'), {
    store, vault, cipher: credentialCipher, keyAllowed,
    clipboard: { readText: () => clipboard.readText(), writeText: (text) => clipboard.writeText(text) },
    onState: (id, state) => send(id, channels.vaultState, state)
  })
  await vaultManager.load()
  service = new SshService(store, {
    scriptRun: (id, event) => send(id, channels.scriptRun, event),
    data: (id, event) => send(id, channels.data, event),
    status: (id, event) => {
      send(id, channels.status, event)
      if (event.status === 'error' || event.status === 'disconnected') void transfers.cancelSession(id, event.sessionId)
    },
    hostKey: (id, event) => send(id, channels.hostKey, event)
  }, async (profile) => ({ ...(profile.authType === 'password' ? { password: await vault.get(profile) } : {}) }))
  transfers = new TransferManager((ownerId, sessionId) => service.getSftp(ownerId, sessionId), (id, event) => send(id, channels.transfer, event))
  editor = new RemoteEditorService((ownerId, sessionId) => service.getSftp(ownerId, sessionId), (ownerId, sessionId) => service.getClient(ownerId, sessionId))
  bulkImport = new BulkImportService(store, vault, keyAllowed)
  groupCommands = new GroupCommandManager(store, vault, service, (id, event) => send(id, channels.groupCommand, event))
  metrics = new MetricsService(service)
  tunnels = new TunnelManager(service, (id, event) => send(id, channels.tunnel, event))
  backups = new BackupService(store, vault, path.join(app.getPath('userData'), 'backup-keys'), keyAllowed)
  updates = new UpdateService(app.getVersion(), (event) => { if (mainWindow && !mainWindow.isDestroyed()) send(mainWindow.webContents.id, channels.update, event) }, (url) => shell.openExternal(url), undefined, {
    directory: path.join(app.getPath('userData'), 'updates'),
    beforeInstall: async () => {
      if (generatingKey) throw new Error('Wait for SSH key generation to finish before installing.')
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error('The application window is no longer available.')
      // Stop live work first, retaining usable services if launching fails.
      await closeOwner(mainWindow.webContents.id)
    },
    launchInstaller: launchUpdateInstaller
  })
  // Release checks use only public metadata. Local development stays offline.
  if (app.isPackaged) await updates.initialize(path.join(app.getAppPath(), 'build', 'release-config.json'))
  mcp = new McpService({
    store, ssh: service, metrics, editor, version: app.getVersion(),
    connectionFile: path.join(app.getPath('userData'), 'mcp-connection.json'),
    bridgePath: app.isPackaged ? path.join(process.resourcesPath, 'mcp', 'bridge.cjs') : path.join(app.getAppPath(), 'build', 'mcp', 'bridge.cjs'),
    bridgeCommand: process.execPath, bridgeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    notifyState: (event) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        send(mainWindow.webContents.id, channels.mcpState, event)
        const next = event.pendingApprovals[0]?.id
        if (next !== lastMcpApprovalId) mainWindow.flashFrame(!!next && !mainWindow.isFocused())
        lastMcpApprovalId = next
      }
    }
  })
  registerIpc()
  await createWindow()
  const updateCheck = setTimeout(() => { void updates.check() }, 5000)
  updateCheck.unref()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow() })
}).catch((error) => {
  if (backgroundTest) process.stderr.write(`SSH Heaven could not start: ${errorMessage(error)}\n`)
  else dialog.showErrorBox('SSH Heaven could not start', errorMessage(error))
  app.quit()
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', (event) => {
  updates?.dispose()
  if (cleanupFinished || !transfers) { service?.dispose(); return }
  event.preventDefault()
  if (quitting) return
  quitting = true
  // Keep the connection alive just long enough to close stream handles and
  // remove temporary siblings before tearing down the SSH transport.
  void cleanlyStopWorkspace().finally(() => app.quit())
})
