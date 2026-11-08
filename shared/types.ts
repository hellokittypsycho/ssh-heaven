export type AuthType = 'password' | 'privateKey' | 'agent'

export interface HostProfile {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  group?: string
  favorite?: boolean
  jumpHostId?: string
  autoReconnect?: boolean
  tmuxSession?: string
  color?: string
  icon?: 'server' | 'database' | 'cloud' | 'code' | 'shield' | 'globe'
  notes?: string
}

export type WorkspaceLayout = 'tabs' | 'split' | 'grid'
export interface SavedWorkspace { id: string; name: string; profileIds: string[]; layout: WorkspaceLayout }
export interface SavedKey { id: string; name: string; path: string; available?: boolean }
export interface GroupDefaults { id: string; group: string; username: string; port: number; keyId?: string }
export interface Runbook { id: string; name: string; command: string; description?: string; group?: string }
export interface TunnelRule { id: string; name: string; direction: 'local' | 'remote'; bindPort: number; targetHost: string; targetPort: number; profileId?: string }
export interface LibraryState { runbooks: Runbook[]; keys: SavedKey[]; groupDefaults: GroupDefaults[]; workspaces: SavedWorkspace[]; tunnelRules: TunnelRule[] }
export type LibraryKind = 'runbook' | 'key' | 'group' | 'workspace' | 'tunnel'
export type LibraryItem = Runbook | SavedKey | GroupDefaults | SavedWorkspace | TunnelRule
export interface ServerMetrics { sessionId: string; host: string; os: string; uptimeSeconds: number; cpuPercent: number | null; memoryTotalBytes: number; memoryUsedBytes: number; diskTotalBytes: number; diskUsedBytes: number; sampledAt: number }
export interface TunnelInfo extends TunnelRule { sessionId: string; boundPort: number; status: 'active' | 'closed' | 'error'; error?: string }
export interface BackupExportRequest { password: string; includePasswords: boolean; includePrivateKeys: boolean; preferences: Record<string, string> }
export interface BackupExportResult { canceled: boolean; hosts: number; keys: number; path?: string }
export interface BackupPreview { token: string; filename: string; hosts: number; newHosts: number; skippedHosts: number; keys: number; passwords: number; runbooks: number; workspaces: number }
export interface BackupRestoreResult { hosts: number; keys: number; skippedHosts: number; preferences: Record<string, string> }
export type UpdateStatus = 'unconfigured' | 'idle' | 'checking' | 'available' | 'not-available' | 'error' | 'downloading' | 'downloaded' | 'installing'
export interface UpdateState { status: UpdateStatus; currentVersion: string; version?: string; message?: string; downloadAvailable?: boolean; downloadedBytes?: number; totalBytes?: number; progress?: number }
export interface McpApproval {
  id: string; tool: 'run_command' | 'write_remote_file' | 'run_group_command'; summary: string
  sessionId?: string; host?: string; username?: string; port?: number; group?: string
  targets?: { id: string; name: string; host: string; username: string; port?: number }[]
  command?: string; path?: string; content?: string; previousContent?: string
  createdAt: number; expiresAt: number
}
export interface McpState { enabled: boolean; endpoint?: string; connectionFile?: string; claudeConfig: string; codexConfig: string; tools: string[]; pendingApprovals: McpApproval[]; error?: string }

export interface RecentHost { profile: HostProfile; lastConnectedAt: number }
export interface KeyGenerationRequest { type: 'ed25519' | 'rsa'; comment?: string; passphrase?: string }
export interface GeneratedKey { type: 'ed25519' | 'rsa'; privateKeyPath: string; publicKeyPath: string; publicKey: string; fingerprint: string }
export interface RevealedVaultKey { publicKey: string; privateKey: string }

export interface ConnectRequest {
  sessionId: string
  profile: HostProfile
  password?: string
  passphrase?: string
  cols?: number
  rows?: number
  useSavedCredential?: boolean
  rememberCredential?: boolean
}

export interface SessionInfo { sessionId: string; host: string; username: string }
export interface TerminalData { sessionId: string; data: Uint8Array }
export interface SessionStatus {
  sessionId: string
  status: 'connecting' | 'connected' | 'disconnected' | 'error'
  message?: string
}
export interface HostKeyChallenge {
  requestId: string
  sessionId: string
  host: string
  port: number
  fingerprint: string
  previousFingerprint?: string
}
export interface RemoteEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modified: number
  permissions: string
}
export interface DirectoryListing { path: string; entries: RemoteEntry[] }
export interface TransferResult { canceled: boolean; files: string[] }
export interface CredentialStatus { available: boolean; profileIds: string[] }
export interface VaultState { pinEnabled: boolean; unlocked: boolean; available: boolean; remainingAttempts: number; lockedUntil?: number; unlocksUntil?: number; error?: string }
export interface VaultSnapshot { profiles: HostProfile[]; passwordProfileIds: string[]; keys: SavedKey[] }
export interface RemoteFile { path: string; content: string; version: string; size: number; modified: number }
export interface RemoteProperties { path: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number; mode: number; uid?: number; gid?: number; accessed: number; modified: number; version: string }
export interface ScriptRun { id: string; sessionId: string; scriptId?: string; name: string; status: 'running' | 'completed' | 'failed' | 'disconnected'; startedAt: number; finishedAt?: number; durationMs?: number; exitCode?: number; message?: string }
export interface WindowState { platform: string; maximized: boolean; fullscreen: boolean; focused: boolean }
export interface WindowAppearance { appearance: 'dark' | 'light'; background: string; foreground: string; border: string }
export interface WallpaperPreferences { enabled: boolean; opacity: number; blur: number; fit: 'cover' | 'contain'; animate: boolean }
export interface WallpaperState extends WallpaperPreferences { name?: string; assetUrl?: string; posterUrl?: string; kind?: 'image' | 'gif'; error?: string }
export interface BulkImportRequest { text: string; group?: string; port: number; authType: AuthType; privateKeyPath?: string }
export interface ImportEntry { line: number; host: string; username: string; password?: string }
export interface ImportPreview { entries: ImportEntry[]; errors: { line: number; message: string }[]; totalLines: number; duplicates: number }
export interface BulkImportResult { imported: number; skipped: number }
export interface GroupCommandRequest { runId: string; group: string; profileIds: string[]; command: string; passphrase?: string; timeoutSeconds?: number }
export type GroupCommandStatus = 'queued' | 'connecting' | 'verifying' | 'running' | 'completed' | 'failed' | 'canceled'
export interface GroupCommandEvent { runId: string; profileId: string; host: string; username: string; name: string; status: GroupCommandStatus; output?: string; exitCode?: number | null; error?: string; startedAt?: number; finishedAt?: number; truncated?: boolean }
export type TransferStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled'
export interface TransferJob {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  name: string
  source: string
  destination: string
  transferred: number
  total: number
  status: TransferStatus
  message?: string
  startedAt: number
  finishedAt?: number
  bytesPerSecond?: number
  etaSeconds?: number
  queuePosition?: number
  bandwidthLimit?: number
}

export interface SshHeavenApi {
  listProfiles(): Promise<HostProfile[]>
  listRecentHosts(): Promise<RecentHost[]>
  clearRecentHosts(): Promise<void>
  generateKey(request: KeyGenerationRequest): Promise<GeneratedKey | null>
  setNativeTheme(appearance: 'dark' | 'light'): Promise<void>
  setWindowAppearance(appearance: WindowAppearance): Promise<void>
  getWindowState(): Promise<WindowState>
  onWindowState(callback: (state: WindowState) => void): () => void
  getWallpaperState(): Promise<WallpaperState>
  chooseWallpaper(): Promise<WallpaperState | null>
  setWallpaperPreferences(preferences: Partial<WallpaperPreferences>): Promise<WallpaperState>
  clearWallpaper(): Promise<WallpaperState>
  onWallpaper(callback: (state: WallpaperState) => void): () => void
  importHosts(request: BulkImportRequest): Promise<BulkImportResult>
  runGroupCommand(request: GroupCommandRequest): Promise<void>
  cancelGroupCommand(runId: string): Promise<void>
  onGroupCommand(callback: (event: GroupCommandEvent) => void): () => void
  getCredentialStatus(): Promise<CredentialStatus>
  forgetCredential(profileId: string): Promise<void>
  getVaultState(): Promise<VaultState>
  setupVaultPin(pin: string): Promise<VaultState>
  unlockVault(pin: string): Promise<VaultState>
  lockVault(): Promise<VaultState>
  changeVaultPin(currentPin: string, newPin: string): Promise<VaultState>
  disableVaultPin(pin: string): Promise<VaultState>
  getVaultSnapshot(): Promise<VaultSnapshot>
  revealVaultPassword(profileId: string): Promise<string>
  copyVaultPassword(profileId: string): Promise<void>
  saveVaultPassword(profileId: string, password: string): Promise<void>
  forgetVaultPassword(profileId: string): Promise<void>
  saveVaultKey(key: SavedKey): Promise<void>
  deleteVaultKey(id: string): Promise<void>
  revealVaultKey(id: string, password: string): Promise<RevealedVaultKey>
  onVaultState(callback: (state: VaultState) => void): () => void
  saveProfile(profile: HostProfile): Promise<HostProfile>
  deleteProfile(id: string): Promise<void>
  pickPrivateKey(): Promise<string | null>
  readClipboard(): Promise<string>
  writeClipboard(text: string): Promise<void>
  connect(request: ConnectRequest): Promise<SessionInfo>
  disconnect(sessionId: string): Promise<void>
  write(sessionId: string, data: string): void
  runTerminalScript(sessionId: string, command: string, details?: { scriptId?: string; name?: string }): Promise<ScriptRun>
  listScriptRuns(): Promise<ScriptRun[]>
  onScriptRun(callback: (run: ScriptRun) => void): () => void
  notifyScriptRun(id: string): Promise<void>
  exportTerminalLog(text: string): Promise<boolean>
  resize(sessionId: string, cols: number, rows: number): void
  listDirectory(sessionId: string, path: string): Promise<DirectoryListing>
  upload(sessionId: string, remoteDirectory: string): Promise<TransferResult>
  download(sessionId: string, remotePath: string): Promise<TransferResult>
  downloadFiles(sessionId: string, remotePaths: string[]): Promise<TransferResult>
  cancelTransfer(transferId: string): Promise<void>
  pauseTransfer(transferId: string): Promise<void>
  resumeTransfer(transferId: string): Promise<void>
  moveTransfer(transferId: string, direction: -1 | 1): Promise<void>
  getTransferBandwidthLimit(): Promise<number>
  setTransferBandwidthLimit(bytesPerSecond: number): Promise<void>
  uploadFolder(sessionId: string, remoteDirectory: string): Promise<TransferResult>
  uploadDropped(sessionId: string, remoteDirectory: string, files: File[]): Promise<TransferResult>
  retryTransfer(transferId: string): Promise<TransferResult>
  getLibrary(): Promise<LibraryState>
  saveLibraryItem(kind: LibraryKind, value: LibraryItem): Promise<LibraryState>
  deleteLibraryItem(kind: LibraryKind, id: string): Promise<LibraryState>
  getServerMetrics(sessionId: string): Promise<ServerMetrics>
  listTunnels(): Promise<TunnelInfo[]>
  startTunnel(sessionId: string, rule: TunnelRule): Promise<TunnelInfo>
  stopTunnel(id: string): Promise<void>
  onTunnel(callback: (event: TunnelInfo) => void): () => void
  exportBackup(request: BackupExportRequest): Promise<BackupExportResult>
  previewBackup(password: string): Promise<BackupPreview | null>
  restoreBackup(token: string): Promise<BackupRestoreResult>
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  openUpdateDownload(): Promise<void>
  downloadUpdate(): Promise<UpdateState>
  cancelUpdateDownload(): Promise<UpdateState>
  installUpdate(): Promise<void>
  onUpdate(callback: (event: UpdateState) => void): () => void
  getMcpState(): Promise<McpState>
  setMcpEnabled(enabled: boolean): Promise<McpState>
  resolveMcpApproval(id: string, approved: boolean): Promise<void>
  onMcpState(callback: (event: McpState) => void): () => void
  readRemoteFile(sessionId: string, path: string): Promise<RemoteFile>
  getRemoteProperties(sessionId: string, path: string): Promise<RemoteProperties>
  chmodRemote(sessionId: string, path: string, mode: number, expectedVersion?: string): Promise<RemoteProperties>
  saveRemoteFile(sessionId: string, path: string, content: string, expectedVersion: string): Promise<RemoteFile>
  mkdir(sessionId: string, path: string): Promise<void>
  rename(sessionId: string, oldPath: string, newPath: string): Promise<void>
  remove(sessionId: string, path: string, type: 'file' | 'directory'): Promise<void>
  resolveHostKey(requestId: string, trusted: boolean): Promise<void>
  onData(callback: (event: TerminalData) => void): () => void
  onStatus(callback: (event: SessionStatus) => void): () => void
  onHostKey(callback: (event: HostKeyChallenge) => void): () => void
  onTransfer(callback: (event: TransferJob) => void): () => void
}
