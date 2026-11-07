import { createConnection, createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { TunnelInfo, TunnelRule } from '../shared/types'
import { SshService } from './ssh-service'
import { errorMessage, identifier, integer, record, textValue } from './validation'

interface Resource { ownerId: number; client: Client; info: TunnelInfo; server?: Server; connections: Set<Duplex>; closed: boolean; bound: boolean; stopping?: Promise<void> }
interface Starting { ownerId: number; sessionId: string; canceled: boolean; promise?: Promise<TunnelInfo> }
type RemoteHandler = (details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => void

export function validateTunnelRule(value: unknown): TunnelRule {
  const input = record(value, 'forwarding rule')
  if (input.direction !== 'local' && input.direction !== 'remote') throw new Error('Choose local or remote forwarding.')
  const targetHost = textValue(input.targetHost, 'forwarding target', 253)
  if (!targetHost.trim() || /[\s\x00-\x1f\x7f]/.test(targetHost)) throw new Error('Enter a valid forwarding target hostname or IP address.')
  return {
    id: identifier(input.id, 'forwarding rule identifier'), name: textValue(input.name, 'forwarding rule name', 100), direction: input.direction,
    bindPort: integer(input.bindPort, 'listening port', 0, 65535), targetHost, targetPort: integer(input.targetPort, 'target port', 1, 65535),
    ...(input.profileId ? { profileId: identifier(input.profileId, 'forwarding host identifier') } : {})
  }
}

export class TunnelManager {
  private readonly active = new Map<string, Resource>()
  private readonly history = new Map<string, { ownerId: number; info: TunnelInfo }>()
  private readonly starting = new Map<string, Starting>()
  private readonly remoteHandlers = new Map<Client, RemoteHandler>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(private readonly ssh: SshService, private readonly notify: (ownerId: number, info: TunnelInfo) => void) {
    this.unsubscribe = ssh.onSessionClosed((ownerId, sessionId) => { void this.cancelSession(ownerId, sessionId).catch(() => {}) })
  }

  list(ownerId: number): TunnelInfo[] {
    return [...this.history.values()].filter((entry) => entry.ownerId === ownerId).map((entry) => ({ ...entry.info }))
  }

  start(ownerId: number, sessionValue: unknown, value: unknown): Promise<TunnelInfo> {
    if (this.disposed) return Promise.reject(new Error('Forwarding is shutting down.'))
    const sessionId = identifier(sessionValue, 'session identifier')
    const rule = validateTunnelRule(value)
    if (this.active.has(rule.id) || this.starting.has(rule.id)) return Promise.reject(new Error('This forwarding rule is already running.'))
    if (this.active.size + this.starting.size >= 32) return Promise.reject(new Error('The forwarding limit has been reached (32 rules).'))
    const profile = this.ssh.getProfile(ownerId, sessionId)
    if (rule.profileId && rule.profileId !== profile.id) return Promise.reject(new Error('This forwarding rule belongs to a different saved host.'))
    const client = this.ssh.getClient(ownerId, sessionId)
    const starting: Starting = { ownerId, sessionId, canceled: false }
    const info: TunnelInfo = { ...rule, sessionId, boundPort: rule.bindPort, status: 'active' }
    const resource: Resource = { ownerId, client, info, connections: new Set(), closed: false, bound: false }
    const operation = this.open(resource, starting).catch(async (error) => {
      await this.stopResource(resource).catch(() => {})
      const failed: TunnelInfo = { ...info, status: 'error', error: errorMessage(error) }
      this.publish(ownerId, failed)
      throw error
    }).finally(() => this.starting.delete(rule.id))
    starting.promise = operation
    this.starting.set(rule.id, starting)
    return operation
  }

  private async open(resource: Resource, starting: Starting): Promise<TunnelInfo> {
    const { client, info } = resource
    if (info.direction === 'local') {
      const server = createServer((socket) => this.localConnection(resource, socket))
      resource.server = server
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(info.bindPort, '127.0.0.1', () => {
          server.off('error', reject)
          const address = server.address()
          if (!address || typeof address === 'string') { reject(new Error('The forwarding listener did not receive a TCP port.')); return }
          info.boundPort = address.port
          resource.bound = true
          this.active.set(info.id, resource)
          resolve()
        })
      })
      server.on('error', (error) => { if (!resource.closed) { info.error = errorMessage(error); info.status = 'error'; this.publish(resource.ownerId, info); void this.stopResource(resource) } })
    } else {
      this.ensureRemoteHandler(client)
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const timer = setTimeout(() => { settled = true; reject(new Error('The SSH server did not respond to the remote forwarding request.')) }, 8_000)
        try {
          client.forwardIn('127.0.0.1', info.bindPort, (error, port) => {
            clearTimeout(timer)
            if (settled || resource.closed) {
              if (!error && (port || info.bindPort)) {
                info.boundPort = port || info.bindPort
                resource.bound = true
                resource.stopping = undefined
                this.active.set(info.id, resource)
                void this.stopResource(resource).catch(() => {})
              }
              return
            }
            settled = true
            if (error) { reject(error); return }
            info.boundPort = port || info.bindPort
            if (!info.boundPort) { reject(new Error('The SSH server did not report the remote listening port.')); return }
            resource.bound = true
            this.active.set(info.id, resource)
            resolve()
          })
        } catch (error) { settled = true; clearTimeout(timer); reject(error) }
      })
    }
    if (starting.canceled || this.disposed || this.ssh.getClient(resource.ownerId, info.sessionId) !== client) throw new Error('The SSH session closed or forwarding was canceled while starting.')
    this.publish(resource.ownerId, info)
    return { ...info }
  }

  private localConnection(resource: Resource, socket: Socket): void {
    socket.on('error', () => {})
    if (resource.closed) { socket.destroy(); return }
    resource.connections.add(socket)
    socket.once('close', () => resource.connections.delete(socket))
    socket.pause()
    try {
      resource.client.forwardOut(socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, resource.info.targetHost, resource.info.targetPort, (error, channel) => {
        if (error || resource.closed || socket.destroyed) { channel?.destroy(); socket.destroy(); return }
        this.pipe(resource, socket, channel)
        socket.resume()
      })
    } catch { socket.destroy() }
  }

  private pipe(resource: Resource, socket: Socket, channel: ClientChannel): void {
    resource.connections.add(socket); resource.connections.add(channel)
    socket.on('error', () => channel.destroy())
    channel.on('error', () => socket.destroy())
    socket.once('close', () => { resource.connections.delete(socket); channel.destroy() })
    channel.once('close', () => { resource.connections.delete(channel); socket.destroy() })
    socket.pipe(channel).pipe(socket)
  }

  private ensureRemoteHandler(client: Client): void {
    if (this.remoteHandlers.has(client)) return
    const handler: RemoteHandler = (details, accept, reject) => {
      const rejectConnection = () => { try { reject() } catch { /* The SSH request may already have closed. */ } }
      const resource = [...this.active.values()].find((item) => item.client === client && item.info.direction === 'remote' && !item.closed && item.info.boundPort === details.destPort)
      if (!resource || !['127.0.0.1', 'localhost', '::1'].includes(details.destIP)) { rejectConnection(); return }
      const socket = createConnection({ host: resource.info.targetHost, port: resource.info.targetPort })
      resource.connections.add(socket)
      let accepted = false
      socket.setTimeout(10_000, () => socket.destroy(new Error('Forwarding target timed out.')))
      socket.once('error', () => { if (!accepted) rejectConnection(); socket.destroy() })
      socket.once('close', () => resource.connections.delete(socket))
      socket.once('connect', () => {
        if (resource.closed) { rejectConnection(); socket.destroy(); return }
        accepted = true; socket.setTimeout(0)
        try { this.pipe(resource, socket, accept()) } catch { socket.destroy() }
      })
    }
    this.remoteHandlers.set(client, handler)
    client.on('tcp connection', handler)
  }

  async stop(ownerId: number, value: unknown): Promise<void> {
    const id = identifier(value, 'forwarding rule identifier')
    const starting = this.starting.get(id)
    if (starting && starting.ownerId !== ownerId) throw new Error('This forwarding rule belongs to another window.')
    if (starting) { starting.canceled = true; await starting.promise?.catch(() => {}); return }
    const resource = this.active.get(id)
    const previous = this.history.get(id)
    if (!resource) {
      if (previous && previous.ownerId !== ownerId) throw new Error('This forwarding rule belongs to another window.')
      if (previous?.info.status === 'error') this.publish(ownerId, { ...previous.info, status: 'closed', error: undefined })
      return
    }
    if (resource.ownerId !== ownerId) throw new Error('This forwarding rule belongs to another window.')
    await this.stopResource(resource)
  }

  private stopResource(resource: Resource): Promise<void> {
    if (resource.stopping) return resource.stopping
    resource.closed = true
    if (!resource.bound || resource.info.direction === 'local') this.active.delete(resource.info.id)
    for (const connection of resource.connections) connection.destroy()
    resource.connections.clear()
    const operation = (async () => {
      if (resource.server?.listening) await new Promise<void>((resolve) => resource.server!.close(() => resolve()))
      if (resource.bound && resource.info.direction === 'remote' && resource.info.boundPort) {
        let live = false
        try { live = this.ssh.getClient(resource.ownerId, resource.info.sessionId) === resource.client } catch { /* Disconnected SSH already closes server listeners. */ }
        if (live) await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('The SSH server did not confirm that the remote listener closed. Disconnect this SSH session to close it.')), 3_000)
          try {
            resource.client.unforwardIn('127.0.0.1', resource.info.boundPort, (error) => {
              clearTimeout(timer)
              if (error) reject(new Error('The SSH server refused to close the remote listener. Disconnect this SSH session to close it.'))
              else resolve()
            })
          } catch (error) { clearTimeout(timer); reject(error) }
        })
      }
      resource.bound = false
      this.active.delete(resource.info.id)
      resource.info.status = 'closed'; resource.info.error = undefined
      this.publish(resource.ownerId, resource.info)
      if (![...this.active.values()].some((item) => item.client === resource.client && item.info.direction === 'remote' && item.bound)) {
        const handler = this.remoteHandlers.get(resource.client)
        if (handler) resource.client.off('tcp connection', handler)
        this.remoteHandlers.delete(resource.client)
      }
    })().catch((error) => {
      resource.info.status = 'error'; resource.info.error = errorMessage(error)
      if (resource.bound) this.active.set(resource.info.id, resource)
      this.publish(resource.ownerId, resource.info)
      throw error
    }).finally(() => { if (resource.info.status === 'error') resource.stopping = undefined })
    resource.stopping = operation
    return operation
  }

  async cancelSession(ownerId: number, sessionId: string): Promise<void> {
    const pending = [...this.starting.values()].filter((item) => item.ownerId === ownerId && item.sessionId === sessionId)
    for (const item of pending) item.canceled = true
    await Promise.all([...this.active.values()].filter((item) => item.ownerId === ownerId && item.info.sessionId === sessionId).map((item) => this.stopResource(item).catch(() => {})))
    await Promise.all(pending.map((item) => item.promise?.catch(() => {})))
  }

  async cancelOwner(ownerId: number): Promise<void> {
    const sessions = new Set([...this.active.values()].filter((item) => item.ownerId === ownerId).map((item) => item.info.sessionId))
    for (const item of this.starting.values()) if (item.ownerId === ownerId) sessions.add(item.sessionId)
    await Promise.all([...sessions].map((id) => this.cancelSession(ownerId, id)))
  }

  async dispose(): Promise<void> {
    this.disposed = true
    const owners = new Set([...this.active.values()].map((item) => item.ownerId))
    for (const item of this.starting.values()) owners.add(item.ownerId)
    await Promise.all([...owners].map((id) => this.cancelOwner(id)))
    this.unsubscribe()
  }

  private publish(ownerId: number, info: TunnelInfo): void {
    this.history.delete(info.id)
    this.history.set(info.id, { ownerId, info: { ...info } })
    for (const [id, entry] of this.history) {
      if (this.history.size <= 100) break
      if (entry.info.status !== 'active') this.history.delete(id)
    }
    this.notify(ownerId, { ...info })
  }
}
