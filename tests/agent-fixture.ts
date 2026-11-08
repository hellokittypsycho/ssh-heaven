import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import net, { type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'

/** Isolated OpenSSH-agent protocol fixture; never touches the user's agent or
 * binds the standard Windows OpenSSH named pipe. Keys exist only in test data. */
export async function startAgentFixture(filename: string, passphrase: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-agent-'))
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\ssh-heaven-agent-test-${randomUUID()}` : path.join(directory, 'agent.sock')
  const key = ssh2.utils.parseKey(await readFile(filename), passphrase)
  if (key instanceof Error || Array.isArray(key)) throw new Error('Invalid fixture identity')
  const sockets = new Set<Socket>()
  let signatures = 0, identities = 0
  const string = (value: Buffer | string) => { const data = Buffer.from(value); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); return Buffer.concat([size, data]) }
  const frame = (body: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32BE(body.length); return Buffer.concat([size, body]) }
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    let pending = Buffer.alloc(0)
    socket.on('data', (data: Buffer) => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= 4) {
        const length = pending.readUInt32BE(0)
        if (length < 1 || length > 1024 * 1024) { socket.destroy(); return }
        if (pending.length < length + 4) return
        const request = pending.subarray(4, 4 + length); pending = pending.subarray(4 + length)
        if (request[0] === 11) {
          identities++
          const count = Buffer.alloc(4); count.writeUInt32BE(1)
          socket.write(frame(Buffer.concat([Buffer.from([12]), count, string(key.getPublicSSH()), string('ephemeral test identity')])))
        } else if (request[0] === 13) {
          try {
            let offset = 1
            const readString = () => { const size = request.readUInt32BE(offset); offset += 4; if (offset + size > request.length) throw new Error(); const value = request.subarray(offset, offset + size); offset += size; return value }
            const publicKey = readString(), blob = readString(), flags = request.readUInt32BE(offset)
            if (!publicKey.equals(key.getPublicSSH())) throw new Error()
            const algorithm = key.type === 'ssh-rsa' ? flags & 4 ? 'rsa-sha2-512' : flags & 2 ? 'rsa-sha2-256' : 'ssh-rsa' : key.type
            const signed = key.sign(blob, algorithm === 'rsa-sha2-512' ? 'sha512' : algorithm === 'rsa-sha2-256' ? 'sha256' : 'sha1')
            if (signed instanceof Error) throw signed
            signatures++
            socket.write(frame(Buffer.concat([Buffer.from([14]), string(Buffer.concat([string(algorithm), string(signed)]))])))
          } catch { socket.write(frame(Buffer.from([5]))) }
        } else socket.write(frame(Buffer.from([5])))
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
  return { path: socketPath, get signatures() { return signatures }, get identities() { return identities }, async close() { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }) } }
}
