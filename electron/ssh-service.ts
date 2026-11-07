import { createHash, randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import ssh2, { type Client as SshClient, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import type { ConnectRequest, DirectoryListing, HostKeyChallenge, HostProfile, RemoteEntry, SessionInfo, SessionStatus, TerminalData } from '../shared/types'
import { AppStore, validateProfile } from './store'
import { errorMessage, identifier, integer, record, remotePath } from './validation'

const { Client } = ssh2

export interface SessionEvents {
  data(ownerId: number, event: TerminalData): void
  status(ownerId: number, event: SessionStatus): void
  hostKey(ownerId: number, event: HostKeyChallenge): void
}

export interface ExecuteRequest { sessionId: string; profile: HostProfile; command: string; password?: string; passphrase?: string }
export interface ExecuteEvents {
  phase(status: 'connecting' | 'verifying' | 'running'): void
  data(data: Uint8Array, stream: 'stdout' | 'stderr'): void
}
export interface ResolvedCredentials { password?: string; passphrase?: string }
export type CredentialResolver = (profile: HostProfile) => Promise<ResolvedCredentials>
export interface CommandOutput { stdout: string; stderr: string; exitCode: number | null }
export interface ConnectedSession extends SessionInfo { profileId: string; name: string; port: number; group?: string }

interface Session {
  id: string
  ownerId: number
  client: SshClient
  shell?: ClientChannel
  sftp?: Promise<SFTPWrapper>
  connected: boolean
  closed: boolean
  failed: boolean
  profile: HostProfile
  hops?: SshClient[]
  rejectConnect?: (error: Error) => void
  flushOutput?: () => void
  beforeInput?: () => void
}

interface Challenge {
  ownerId: number
  sessionId: string
  respond(trusted: boolean): void
}

function credential(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 8192) throw new Error(`Invalid ${label}.`)
  return value
}

function collectCommand(client: SshClient, command: string, options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<CommandOutput> {
  const timeoutMs = integer(options.timeoutMs ?? 5_000, 'command timeout', 1, 60_000)
  const maxBytes = integer(options.maxBytes ?? 64 * 1024, 'command output limit', 1, 2 * 1024 * 1024)
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined
    let settled = false
    let length = 0
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const finish = (error?: Error, code?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', aborted)
      if (error) { try { channel?.signal('TERM'); channel?.close(); channel?.destroy() } catch { /* Closed channel. */ }; reject(error) }
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: typeof code === 'number' ? code : null })
    }
    const timer = setTimeout(() => finish(new Error('The server command timed out.')), timeoutMs)
    const aborted = () => finish(new Error('The server command was canceled.'))
    options.signal?.addEventListener('abort', aborted, { once: true })
    const capture = (chunks: Buffer[], data: Buffer) => {
      if (settled) return
      length += data.length
      if (length > maxBytes) { finish(new Error('The server command exceeded the allowed output size.')); return }
      chunks.push(Buffer.from(data))
    }
    try {
      if (options.signal?.aborted) { aborted(); return }
      client.exec(command, (error, stream) => {
        if (error) { finish(error); return }
        channel = stream
        if (settled) { stream.destroy(); return }
        stream.on('data', (data: Buffer) => capture(stdout, data))
        stream.stderr.on('data', (data: Buffer) => capture(stderr, data))
        stream.on('error', (failure: Error) => finish(failure))
        stream.on('close', (code?: number, signal?: string) => finish(signal ? new Error(`Server command terminated by ${signal}.`) : undefined, code))
      })
    } catch (error) { finish(error instanceof Error ? error : new Error(errorMessage(error))) }
  })
}

export class SshService {
  private readonly sessions = new Map<string, Session>()
  private readonly challenges = new Map<string, Challenge>()
  private readonly ownerEpochs = new Map<number, number>()
  private readonly executions = new Map<string, { ownerId: number; close(): void }>()
  private readonly closedListeners = new Set<(ownerId: number, sessionId: string) => void>()
  private readonly preparing = new Map<string, { ownerId: number; canceled: boolean }>()

  constructor(private readonly store: AppStore, private readonly events: SessionEvents, private readonly credentialResolver?: CredentialResolver) {}

  onSessionClosed(listener: (ownerId: number, sessionId: string) => void): () => void {
    this.closedListeners.add(listener)
    return () => this.closedListeners.delete(listener)
  }

  getClient(ownerId: number, sessionId: unknown): SshClient {
    const session = this.getSession(ownerId, sessionId)
    if (!session.connected) throw new Error('Wait for the SSH connection to finish.')
    return session.client
  }

  getProfile(ownerId: number, sessionId: unknown): HostProfile {
    return { ...this.getSession(ownerId, sessionId).profile }
  }

  listSessions(ownerId: number): ConnectedSession[] {
    const profiles = this.store.listProfiles()
    return [...this.sessions.values()].filter((session) => session.ownerId === ownerId && session.connected && !session.closed).map((session) => {
      const actual = session.profile
      const current = profiles.find((profile) => profile.id === actual.id && profile.host.toLowerCase() === actual.host.toLowerCase() && profile.port === actual.port && profile.username === actual.username && profile.authType === actual.authType && (profile.authType !== 'privateKey' || profile.privateKeyPath === actual.privateKeyPath)) ?? actual
      return { sessionId: session.id, profileId: actual.id, name: current.name, host: actual.host, port: actual.port, username: actual.username, ...(current.group ? { group: current.group } : {}) }
    })
  }

  async execOnSession(ownerId: number, sessionId: unknown, command: string, options: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {}): Promise<CommandOutput> {
    const session = this.getSession(ownerId, sessionId)
    if (!session.connected) throw new Error('Wait for the SSH connection to finish.')
    const result = await collectCommand(session.client, command, options)
    if (session.closed) throw new Error('The SSH session disconnected while running the command.')
    return result
  }

  private jumpChain(target: HostProfile): HostProfile[] {
    const saved = new Map(this.store.listProfiles().map((profile) => [profile.id, profile]))
    const seen = new Set([target.id])
    const chain: HostProfile[] = []
    let id = target.jumpHostId
    while (id) {
      if (seen.has(id)) throw new Error('The jump-host route contains a cycle. Edit the saved host route.')
      if (chain.length >= 4) throw new Error('A connection can use at most four jump hosts.')
      const hop = saved.get(id)
      if (!hop) throw new Error('A configured jump host no longer exists. Edit this host route.')
      seen.add(id); chain.unshift(hop); id = hop.jumpHostId
    }
    return chain
  }

  private async connectRoute(session: Session, profile: HostProfile, config: ConnectConfig, fail: (error: unknown) => void, phase?: ExecuteEvents['phase'], signal?: AbortSignal): Promise<void> {
    let previous: SshClient | undefined
    for (const hop of this.jumpChain(profile)) {
      if (session.closed) return
      signal?.throwIfAborted()
      if (!this.credentialResolver) throw new Error(`Saved credentials are required for jump host ${hop.name}.`)
      const resolved = await this.credentialResolver(hop)
      if (session.closed) return
      signal?.throwIfAborted()
      let privateKey: Buffer | undefined
      let passphrase = credential(resolved.passphrase, 'jump-host key passphrase')
      const password = credential(resolved.password, 'jump-host password')
      if (hop.authType === 'privateKey') {
        if (!hop.privateKeyPath || !path.isAbsolute(hop.privateKeyPath)) throw new Error(`Choose a private key for jump host ${hop.name}.`)
        const metadata = await stat(hop.privateKeyPath)
        if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error(`Choose a valid private key for jump host ${hop.name}.`)
        privateKey = await readFile(hop.privateKeyPath)
        if (passphrase === undefined && typeof config.passphrase === 'string' && profile.privateKeyPath && path.resolve(profile.privateKeyPath) === path.resolve(hop.privateKeyPath)) passphrase = config.passphrase
      } else if (password === undefined) throw new Error(`Jump host ${hop.name} has no saved password. Remember its password before using this route.`)
      if (session.closed) return
      signal?.throwIfAborted()
      const sock = previous ? await new Promise<ClientChannel>((resolve, reject) => previous!.forwardOut('127.0.0.1', 0, hop.host, hop.port, (error, channel) => error ? reject(error) : resolve(channel))) : undefined
      if (session.closed) { sock?.destroy(); return }
      const jump = new Client()
      ;(session.hops ??= []).push(jump)
      jump.on('error', (error) => { if (!session.closed) fail(new Error(`Jump host ${hop.name}: ${errorMessage(error)}`)) })
      jump.on('close', () => { if (!session.closed) fail(new Error(`Jump host ${hop.name} disconnected.`)) })
      phase?.('connecting')
      await new Promise<void>((resolve, reject) => {
        jump.once('ready', resolve)
        jump.once('error', reject)
        jump.once('close', () => reject(new Error(`Jump host ${hop.name} closed before authentication completed.`)))
        jump.connect({
          host: hop.host, port: hop.port, username: hop.username, sock,
          readyTimeout: 150_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
          ...(hop.authType === 'privateKey' ? { privateKey, passphrase } : { password }),
          hostVerifier: (key: Buffer, callback: (trusted: boolean) => void) => {
            phase?.('verifying')
            this.verifyHost(session, hop.host, hop.port, key).then(callback, () => callback(false))
          }
        })
        // Interactive keystrokes should not wait for another small packet or
        // a delayed TCP acknowledgement, including on the first jump hop.
        jump.setNoDelay(true)
      })
      previous = jump
    }
    if (session.closed) return
    signal?.throwIfAborted()
    const sock = previous ? await new Promise<ClientChannel>((resolve, reject) => previous!.forwardOut('127.0.0.1', 0, profile.host, profile.port, (error, channel) => error ? reject(error) : resolve(channel))) : undefined
    if (session.closed) { sock?.destroy(); return }
    session.client.connect({ ...config, ...(sock ? { sock } : {}) })
    session.client.setNoDelay(true)
  }

  async execute(ownerId: number, value: ExecuteRequest, signal: AbortSignal, events: ExecuteEvents): Promise<{ exitCode: number | null }> {
    const epoch = this.ownerEpochs.get(ownerId) ?? 0
    const sessionId = identifier(value.sessionId, 'command session identifier')
    const profile = validateProfile(value.profile)
    if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > 32768 || value.command.includes('\0')) throw new Error('Enter a command of at most 32768 characters.')
    const password = credential(value.password, 'password')
    const passphrase = credential(value.passphrase, 'key passphrase')
    signal.throwIfAborted()
    let privateKey: Buffer | undefined
    if (profile.authType === 'privateKey') {
      if (!profile.privateKeyPath || !path.isAbsolute(profile.privateKeyPath)) throw new Error('Choose a private key file for this host.')
      const file = await stat(profile.privateKeyPath)
      if (!file.isFile() || file.size > 1024 * 1024) throw new Error('Choose a valid private key file (under 1 MB).')
      privateKey = await readFile(profile.privateKeyPath)
    }
    signal.throwIfAborted()
    if ((this.ownerEpochs.get(ownerId) ?? 0) !== epoch) throw new Error('The application window closed while preparing the command.')
    if (this.executions.has(sessionId)) throw new Error('This command session already exists.')
    if (this.executions.size >= 8) throw new Error('Too many command connections are active.')
    const client = new Client()
    const session: Session = { id: sessionId, ownerId, client, profile, connected: false, closed: false, failed: false }
    events.phase('connecting')
    return new Promise((resolve, reject) => {
      let settled = false
      let stream: ClientChannel | undefined
      const cleanup = () => {
        if (session.closed) return
        session.closed = true
        this.executions.delete(sessionId)
        signal.removeEventListener('abort', aborted)
        for (const challenge of this.challenges.values()) if (challenge.sessionId === sessionId) challenge.respond(false)
        stream?.destroy()
        client.destroy()
        for (const hop of [...(session.hops ?? [])].reverse()) hop.destroy()
        // Group executions do not create terminal tabs, but share the global
        // host-key prompt queue. Let that queue remove any canceled/expired
        // synthetic session challenge just as it does for terminal sessions.
        this.events.status(ownerId, { sessionId, status: 'disconnected' })
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(errorMessage(error)))
      }
      const aborted = () => {
        try { stream?.signal('TERM'); stream?.close() } catch { /* Not every server accepts remote signals. */ }
        fail(new Error('Command canceled.'))
      }
      this.executions.set(sessionId, { ownerId, close: () => fail(new Error('Command canceled because the application window closed.')) })
      signal.addEventListener('abort', aborted, { once: true })
      client.on('error', fail)
      client.on('close', () => { if (!settled) fail(new Error('The SSH connection closed before the command completed.')) })
      client.once('ready', () => {
        if (session.closed) return
        client.exec(value.command, (error, channel) => {
          if (error) { fail(error); return }
          if (session.closed) { channel.destroy(); return }
          stream = channel
          events.phase('running')
          channel.on('data', (data: Buffer) => events.data(new Uint8Array(data), 'stdout'))
          channel.stderr.on('data', (data: Buffer) => events.data(new Uint8Array(data), 'stderr'))
          channel.on('error', fail)
          channel.on('close', (code?: number, signal?: string) => {
            if (settled) return
            if (signal) { fail(new Error(`Command terminated by remote signal ${signal}.`)); return }
            settled = true
            cleanup()
            resolve({ exitCode: typeof code === 'number' ? code : null })
          })
        })
      })
      try {
        void this.connectRoute(session, profile, {
          host: profile.host, port: profile.port, username: profile.username,
          readyTimeout: 150_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
          ...(profile.authType === 'privateKey' ? { privateKey, passphrase } : { password: password ?? '' }),
          hostVerifier: (key: Buffer, callback: (trusted: boolean) => void) => {
            events.phase('verifying')
            this.verifyHost(session, profile.host, profile.port, key).then(callback, () => callback(false))
          }
        }, fail, events.phase, signal).catch(fail)
      } catch (error) { fail(error) }
      if (signal.aborted) aborted()
    })
  }

  async connect(value: unknown, ownerId: number, onAuthenticated?: () => Promise<void>): Promise<SessionInfo> {
    const ownerEpoch = this.ownerEpochs.get(ownerId) ?? 0
    const input = record(value, 'connection request')
    const request: ConnectRequest = {
      sessionId: identifier(input.sessionId, 'session identifier'),
      profile: validateProfile(input.profile),
      password: credential(input.password, 'password'),
      passphrase: credential(input.passphrase, 'key passphrase'),
      cols: input.cols === undefined ? 100 : integer(input.cols, 'terminal columns', 1, 1000),
      rows: input.rows === undefined ? 30 : integer(input.rows, 'terminal rows', 1, 1000)
    }
    if (this.sessions.has(request.sessionId) || this.preparing.has(request.sessionId)) throw new Error('This session already exists.')
    if (this.sessions.size + this.preparing.size >= 20) throw new Error('Close an existing session before opening another (20 session limit).')
    const { profile } = request
    if (profile.tmuxSession !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.tmuxSession)) throw new Error('Use a tmux session name of 1–64 letters, numbers, underscores, or hyphens.')
    let privateKey: Buffer | undefined
    const preparing = { ownerId, canceled: false }
    this.preparing.set(request.sessionId, preparing)
    try {
      if (profile.authType === 'privateKey') {
        if (!profile.privateKeyPath || !path.isAbsolute(profile.privateKeyPath)) throw new Error('Choose a private key file first.')
        const metadata = await stat(profile.privateKeyPath)
        if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('Choose a valid private key file (under 1 MB).')
        privateKey = await readFile(profile.privateKeyPath)
      }
      if (preparing.canceled) throw new Error('Connection canceled while preparing the private key.')
      if ((this.ownerEpochs.get(ownerId) ?? 0) !== ownerEpoch) throw new Error('The window closed or reloaded while opening the connection.')
    } finally { this.preparing.delete(request.sessionId) }
    const client = new Client()
    const session: Session = { id: request.sessionId, ownerId, client, profile, connected: false, closed: false, failed: false }
    this.sessions.set(session.id, session)
    this.events.status(ownerId, { sessionId: session.id, status: 'connecting' })

    return new Promise<SessionInfo>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown) => {
        if (session.closed) return
        session.failed = true
        const message = errorMessage(error)
        this.events.status(ownerId, { sessionId: session.id, status: 'error', message })
        if (!settled) { settled = true; reject(new Error(message)) }
        this.closeSession(session)
      }
      session.rejectConnect = (error) => {
        if (!settled) { settled = true; reject(error) }
      }
      client.on('error', fail)
      client.on('close', () => this.closeSession(session))
      client.once('ready', () => {
        if (session.closed) return
        const opened = (error: Error | undefined, stream: ClientChannel) => {
          if (error) { fail(error); return }
          if (session.closed) { stream.close(); return }
          session.shell = stream
          session.connected = true
          const output = this.terminalOutput(session)
          stream.on('data', output)
          stream.stderr.on('data', output)
          stream.on('error', fail)
          stream.on('close', () => this.closeSession(session))
          const persistConnection = async () => {
            const warnings: string[] = []
            if (onAuthenticated) {
              try { await onAuthenticated() } catch (error) { warnings.push(`Connected, but the password could not be remembered. ${errorMessage(error)}`) }
            }
            try { await this.store.recordConnection(profile) } catch { warnings.push('Recent connection history could not be saved.') }
            return warnings.join(' ')
          }
          void persistConnection().then((historyWarning) => {
            if (session.closed) return
            this.events.status(ownerId, { sessionId: session.id, status: 'connected', ...(historyWarning ? { message: historyWarning } : {}) })
            if (!settled) {
              settled = true
              resolve({ sessionId: session.id, host: profile.host, username: profile.username })
            }
          })
        }
        if (profile.tmuxSession) {
          void collectCommand(client, "sh -c 'command -v tmux >/dev/null 2>&1'", { timeoutMs: 5_000, maxBytes: 4096 }).then((result) => {
            if (session.closed) return
            if (result.exitCode !== 0) throw new Error('tmux is not installed on this server. Install tmux or disable the persistent session option.')
            client.exec(`tmux new-session -A -s ${profile.tmuxSession}`, { pty: { term: 'xterm-256color', cols: request.cols, rows: request.rows } }, opened)
          }).catch(fail)
        } else client.shell({ term: 'xterm-256color', cols: request.cols, rows: request.rows }, opened)
      })
      const config: ConnectConfig = {
        host: profile.host, port: profile.port, username: profile.username,
        readyTimeout: 150_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
        ...(profile.authType === 'privateKey' ? { privateKey, passphrase: request.passphrase } : { password: request.password ?? '' }),
        hostVerifier: (key: Buffer, callback: (trusted: boolean) => void) => {
          this.verifyHost(session, profile.host, profile.port, key).then(callback, () => callback(false))
        }
      }
      void this.connectRoute(session, profile, config, fail).catch(fail)
    })
  }

  private async verifyHost(session: Session, host: string, port: number, key: Buffer): Promise<boolean> {
    const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
    const previousFingerprint = this.store.getFingerprint(host, port)
    if (previousFingerprint === fingerprint) return true
    const trusted = await new Promise<boolean>((resolve) => {
      const requestId = randomUUID()
      const timer = setTimeout(() => respond(false), 120_000)
      const respond = (answer: boolean) => {
        clearTimeout(timer)
        this.challenges.delete(requestId)
        resolve(answer && !session.closed)
      }
      this.challenges.set(requestId, { ownerId: session.ownerId, sessionId: session.id, respond })
      this.events.hostKey(session.ownerId, { requestId, sessionId: session.id, host, port, fingerprint, previousFingerprint })
    })
    if (!trusted || session.closed) return false
    await this.store.trustFingerprint(host, port, fingerprint)
    return !session.closed
  }

  resolveHostKey(ownerId: number, requestId: unknown, trusted: unknown): void {
    const id = identifier(requestId, 'host key request')
    if (typeof trusted !== 'boolean') throw new Error('Invalid trust decision.')
    const challenge = this.challenges.get(id)
    if (!challenge || challenge.ownerId !== ownerId) throw new Error('This host verification request has expired.')
    challenge.respond(trusted)
  }

  write(ownerId: number, sessionId: unknown, data: unknown): void {
    const session = this.getSession(ownerId, sessionId)
    if (typeof data !== 'string' || data.length > 1024 * 1024) throw new Error('Invalid terminal input.')
    // Finish the preceding output burst so the next server response to this
    // input takes the immediate path, even at Windows' coarse timer resolution.
    session.beforeInput?.()
    session.shell?.write(data)
  }

  async runTerminalScript(ownerId: number, sessionId: unknown, value: unknown): Promise<void> {
    const session = this.getSession(ownerId, sessionId)
    const shell = session.shell
    if (!session.connected || !shell || shell.destroyed || shell.writableEnded) throw new Error('Connect this SSH terminal before running a script.')
    if (typeof value !== 'string' || !value.trim() || value.length > 32768) throw new Error('Enter a script of at most 32768 characters.')
    const command = value.replace(/\r\n/g, '\n')
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new Error('Scripts can contain text, tabs, and line breaks only. Terminal control characters are not allowed.')
    const utf8 = Buffer.from(command, 'utf8')
    if (utf8.toString('utf8') !== command) throw new Error('The script contains invalid Unicode text.')
    // Readline can interpret literal TAB/LF even inside a quoted pasted
    // argument. Transmit printable ASCII only, decode within the child sh,
    // and retain trailing newlines with a non-newline sentinel. No eval or
    // sourcing is involved; the script keeps this terminal as its stdin.
    const octal = Array.from(utf8, (byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('')
    const invocation = `s=$(printf '${octal}'; printf .); exec sh -c "\${s%.}"`
    const payload = `sh -c '${invocation.replace(/'/g, "'\\''")}'\r`
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        shell.off('error', failed)
        shell.off('close', closed)
        if (error) reject(error); else resolve()
      }
      const failed = (error: Error) => finish(error)
      const closed = () => finish(new Error('The terminal disconnected while submitting the script.'))
      const timer = setTimeout(() => finish(new Error('Script submission could not be confirmed. It may already have been sent; check this terminal before retrying.')), 30_000)
      shell.once('error', failed)
      shell.once('close', closed)
      try { session.beforeInput?.(); shell.write(payload, (error?: Error | null) => finish(error)) }
      catch (error) { finish(error instanceof Error ? error : new Error('The script could not be sent to this terminal.')) }
    })
  }

  private terminalOutput(session: Session): (data: Buffer) => void {
    let tick: ReturnType<typeof setTimeout> | undefined
    let chunks: Uint8Array[] = []
    let bytes = 0
    const flush = () => {
      if (!bytes) return
      const data = chunks.length === 1 ? chunks[0] : new Uint8Array(bytes)
      if (chunks.length !== 1) {
        let offset = 0
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
      }
      chunks = []; bytes = 0
      this.events.data(session.ownerId, { sessionId: session.id, data })
    }
    const flushBurst = () => {
      tick = undefined
      if (bytes) {
        flush()
        // Retain the short burst window while packets keep arriving across
        // separate socket callbacks, rather than restarting immediate sends.
        tick = setTimeout(flushBurst, 4)
      }
    }
    session.flushOutput = () => { if (tick) clearTimeout(tick); tick = undefined; flush() }
    session.beforeInput = session.flushOutput
    return (data) => {
      if (session.closed || !data.byteLength) return
      const owned = new Uint8Array(data)
      if (!tick) {
        // Deliver the first chunk immediately: a keystroke's server echo
        // never waits for a batch timer. Merge only additional packets from
        // a 4ms burst window to avoid thousands of tiny IPC messages across
        // successive socket callbacks. Idle single-key echo stays immediate.
        tick = setTimeout(flushBurst, 4)
        this.events.data(session.ownerId, { sessionId: session.id, data: owned })
      } else {
        chunks.push(owned); bytes += owned.byteLength
        if (bytes >= 64 * 1024) flush()
      }
    }
  }

  resize(ownerId: number, sessionId: unknown, cols: unknown, rows: unknown): void {
    const session = this.getSession(ownerId, sessionId)
    const columns = integer(cols, 'terminal columns', 1, 1000)
    const lines = integer(rows, 'terminal rows', 1, 1000)
    session.shell?.setWindow(lines, columns, 0, 0)
  }

  disconnect(ownerId: number, value: unknown): void {
    const id = identifier(value, 'session identifier')
    const session = this.sessions.get(id)
    if (!session) {
      const preparing = this.preparing.get(id)
      if (preparing && preparing.ownerId !== ownerId) throw new Error('This session belongs to another window.')
      if (preparing) preparing.canceled = true
      return
    }
    if (session.ownerId !== ownerId) throw new Error('This session belongs to another window.')
    this.closeSession(session)
  }

  disconnectOwner(ownerId: number): void {
    this.ownerEpochs.set(ownerId, (this.ownerEpochs.get(ownerId) ?? 0) + 1)
    for (const preparing of this.preparing.values()) if (preparing.ownerId === ownerId) preparing.canceled = true
    for (const session of this.sessions.values()) if (session.ownerId === ownerId) this.closeSession(session)
    for (const execution of this.executions.values()) if (execution.ownerId === ownerId) execution.close()
  }

  dispose(): void {
    for (const preparing of this.preparing.values()) preparing.canceled = true
    for (const session of this.sessions.values()) this.closeSession(session)
    for (const execution of this.executions.values()) execution.close()
  }

  private closeSession(session: Session): void {
    if (session.closed) return
    session.closed = true
    session.flushOutput?.()
    session.flushOutput = undefined
    session.beforeInput = undefined
    this.sessions.delete(session.id)
    for (const challenge of this.challenges.values()) if (challenge.sessionId === session.id) challenge.respond(false)
    session.rejectConnect?.(new Error('Connection closed before the terminal was ready.'))
    session.shell?.destroy()
    session.client.destroy()
    for (const hop of [...(session.hops ?? [])].reverse()) hop.destroy()
    for (const listener of this.closedListeners) listener(session.ownerId, session.id)
    if (!session.failed) this.events.status(session.ownerId, { sessionId: session.id, status: 'disconnected' })
  }

  private getSession(ownerId: number, value: unknown): Session {
    const id = identifier(value, 'session identifier')
    const session = this.sessions.get(id)
    if (!session || session.closed) throw new Error('This SSH session is no longer connected.')
    if (session.ownerId !== ownerId) throw new Error('This session belongs to another window.')
    return session
  }

  async getSftp(ownerId: number, sessionId: unknown): Promise<SFTPWrapper> {
    const session = this.getSession(ownerId, sessionId)
    if (!session.connected) throw new Error('Wait for the SSH connection to finish.')
    if (!session.sftp) session.sftp = new Promise<SFTPWrapper>((resolve, reject) => {
      session.client.sftp((error, sftp) => {
        if (error) { session.sftp = undefined; reject(error) } else resolve(sftp)
      })
    })
    return session.sftp
  }

  async listDirectory(ownerId: number, sessionId: unknown, value: unknown): Promise<DirectoryListing> {
    const requested = remotePath(value)
    const sftp = await this.getSftp(ownerId, sessionId)
    const directory = await new Promise<string>((resolve, reject) => sftp.realpath(requested, (error, result) => error ? reject(error) : resolve(result)))
    const entries = await new Promise<DirectoryListing['entries']>((resolve, reject) => {
      sftp.readdir(directory, (error, list) => {
        if (error) { reject(error); return }
        resolve(list.filter((item) => item.filename !== '.' && item.filename !== '..' && !item.filename.includes('/') && !item.filename.includes('\0')).map((item): RemoteEntry => {
          const mode = item.attrs.mode ?? 0
          const kind = mode & 0o170000
          const permissions = Array.from({ length: 9 }, (_, index) => mode & (1 << (8 - index)) ? 'rwx'[index % 3] : '-').join('')
          return {
            name: item.filename, path: path.posix.join(directory, item.filename),
            type: kind === 0o040000 ? 'directory' : kind === 0o100000 ? 'file' : kind === 0o120000 ? 'symlink' : 'other',
            size: item.attrs.size ?? 0, modified: item.attrs.mtime ?? 0, permissions
          }
        }).sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name)))
      })
    })
    return { path: directory, entries }
  }

  async mkdir(ownerId: number, sessionId: unknown, value: unknown): Promise<void> {
    const directory = remotePath(value)
    const sftp = await this.getSftp(ownerId, sessionId)
    await new Promise<void>((resolve, reject) => sftp.mkdir(directory, (error) => error ? reject(error) : resolve()))
  }

  async rename(ownerId: number, sessionId: unknown, oldValue: unknown, newValue: unknown): Promise<void> {
    const source = remotePath(oldValue)
    const destination = remotePath(newValue)
    const sftp = await this.getSftp(ownerId, sessionId)
    await new Promise<void>((resolve, reject) => sftp.rename(source, destination, (error) => error ? reject(error) : resolve()))
  }

  async remove(ownerId: number, sessionId: unknown, value: unknown, kind: unknown): Promise<void> {
    const target = remotePath(value)
    if (target === '/' || target === '.' || target === '..') throw new Error('Select a file or subdirectory to remove.')
    if (kind !== 'file' && kind !== 'directory') throw new Error('Invalid file type.')
    const sftp = await this.getSftp(ownerId, sessionId)
    await new Promise<void>((resolve, reject) => {
      const callback = (error: Error | undefined | null) => error ? reject(error) : resolve()
      if (kind === 'directory') sftp.rmdir(target, callback)
      else sftp.unlink(target, callback)
    })
  }
}
