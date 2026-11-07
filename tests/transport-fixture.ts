import { generateKeyPairSync } from 'node:crypto'
import { createConnection, createServer, type Server as TcpServer, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import ssh2, { type Connection, type ServerChannel } from 'ssh2'

export interface TransportFixtureOptions { username?: string; password?: string; forwarding?: boolean; denyCancelForward?: boolean; tmux?: boolean; metrics?: 'valid' | 'unsupported' | 'large' }
export const VALID_METRICS_OUTPUT = 'SSH_HEAVEN_METRICS_V1\nos Fixture Linux\nuptime 12345.5\ncpu1 100 0 50 500 20 10 0 0\ncpu2 140 0 60 550 20 10 0 0\nmemory 8192 2048\ndisk 100000 25000\n'

/** Protocol fixture only: every TCP listener and forwarding destination is loopback. */
export async function startTransportFixture(options: TransportFixtureOptions = {}) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  const username = options.username ?? 'transport-user'
  const password = options.password ?? 'transport-only-password'
  const commands: string[] = []
  const forwarded: { direction: 'direct' | 'remote'; host: string; port: number }[] = []
  const clients = new Set<Connection>()
  const resources = new Map<Connection, { sockets: Set<Duplex>; listeners: Map<number, TcpServer> }>()
  let authentications = 0

  function shell(stream: ServerChannel) {
    let input = ''
    stream.write('Transport fixture shell\r\n$ ')
    stream.on('data', (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          if (!input && character === '\n') continue
          const command = input.trim(); input = ''
          stream.write(`\r\n${command.startsWith('echo ') ? command.slice(5) : command === 'pwd' ? '/' : command ? 'fixture command' : ''}\r\n$ `)
        } else if (character >= ' ') { input += character; stream.write(character) }
      }
    })
  }

  function loopback(host: string): boolean { return /^127\./.test(host) || host === '::1' || host === 'localhost' }
  function join(state: { sockets: Set<Duplex> }, socket: Socket, stream: ServerChannel) {
    state.sockets.add(socket); state.sockets.add(stream)
    socket.on('error', () => stream.destroy()); stream.on('error', () => socket.destroy())
    socket.once('close', () => { state.sockets.delete(socket); stream.destroy() })
    stream.once('close', () => { state.sockets.delete(stream); socket.destroy() })
    socket.pipe(stream).pipe(socket)
  }

  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client)
    const state = { sockets: new Set<Duplex>(), listeners: new Map<number, TcpServer>() }
    resources.set(client, state)
    client.on('error', () => {})
    client.on('authentication', (auth) => { if (auth.method === 'password' && auth.username === username && auth.password === password) auth.accept(); else auth.reject(['password']) })
    client.on('ready', () => {
      authentications++
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (allow) => allow?.())
        session.on('window-change', (allow) => allow?.())
        session.on('shell', (open) => shell(open()))
        session.on('exec', (open, _reject, info) => {
          commands.push(info.command)
          const stream = open()
          if (info.command === 'wait-for-cancel') { stream.write('waiting\n'); return }
          if (info.command === "sh -c 'command -v tmux >/dev/null 2>&1'") { stream.exit(options.tmux ? 0 : 127); stream.end(); return }
          if (info.command.startsWith('tmux new-session -A -s ')) {
            if (options.tmux) shell(stream)
            else { stream.stderr.write('tmux not installed\n'); stream.exit(127); stream.end() }
            return
          }
          if (info.command.includes('SSH_HEAVEN_METRICS_V1')) {
            if (options.metrics === 'unsupported') { stream.write('SSH_HEAVEN_METRICS_UNSUPPORTED\n'); stream.exit(64) }
            else { stream.write(options.metrics === 'large' ? 'X'.repeat(64 * 1024) : VALID_METRICS_OUTPUT); stream.exit(0) }
          } else { stream.write(`${info.command.startsWith('echo ') ? info.command.slice(5) : 'fixture command'}\n`); stream.exit(0) }
          stream.end()
        })
      })
      client.on('tcpip', (accept, reject, info) => {
        if (!options.forwarding || !loopback(info.destIP)) { reject(); return }
        forwarded.push({ direction: 'direct', host: info.destIP, port: info.destPort })
        const socket = createConnection({ host: info.destIP, port: info.destPort })
        state.sockets.add(socket)
        let opened = false
        socket.once('error', () => { if (!opened) reject(); socket.destroy() })
        socket.once('close', () => state.sockets.delete(socket))
        socket.once('connect', () => { opened = true; join(state, socket, accept()) })
      })
      client.on('request', (accept, reject, name, info) => {
        if (!options.forwarding || info.bindAddr !== '127.0.0.1') { reject?.(); return }
        if (name === 'cancel-tcpip-forward') {
          if (options.denyCancelForward) { reject?.(); return }
          const listener = state.listeners.get(info.bindPort)
          if (!listener) { reject?.(); return }
          state.listeners.delete(info.bindPort)
          listener.close(() => accept?.())
          return
        }
        if (name !== 'tcpip-forward') { reject?.(); return }
        let port = info.bindPort
        const listener = createServer((socket) => {
          state.sockets.add(socket); socket.on('error', () => {})
          socket.once('close', () => state.sockets.delete(socket))
          client.forwardOut('127.0.0.1', port, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, (error, channel) => {
            if (error) { socket.destroy(); return }
            join(state, socket, channel)
          })
        })
        listener.once('error', () => reject?.())
        listener.listen(port, '127.0.0.1', () => {
          const address = listener.address()
          if (!address || typeof address === 'string') { reject?.(); return }
          port = address.port; state.listeners.set(port, listener)
          forwarded.push({ direction: 'remote', host: '127.0.0.1', port })
          accept?.(port)
        })
      })
    })
    client.on('close', () => {
      clients.delete(client)
      for (const socket of state.sockets) socket.destroy()
      for (const listener of state.listeners.values()) listener.close()
      resources.delete(client)
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener failed')
  let closed = false
  return {
    host: '127.0.0.1', port: address.port, username, password, commands, forwarded,
    get authentications() { return authentications },
    disconnectClients() { for (const client of clients) client.end() },
    async close() {
      if (closed) return
      closed = true
      for (const state of resources.values()) {
        for (const socket of state.sockets) socket.destroy()
        for (const listener of state.listeners.values()) listener.close()
      }
      for (const client of clients) client.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
