import { generateKeyPairSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2, { type Connection, type ParsedKey, type ServerChannel } from 'ssh2'

export interface FixtureOptions { privateKeyAuth?: boolean; ioDelayMs?: number; host?: string; port?: number; username?: string; password?: string }

/** Local test server only. Never listen on an external interface. */
export interface SshFixture {
  host: string
  port: number
  username: string
  password: string
  root: string
  privateKeyPath?: string
  passphrase?: string
  close(): Promise<void>
}

const { Server, utils } = ssh2
const { STATUS_CODE, OPEN_MODE } = utils.sftp

function fixtureError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

export async function startFixture(options: FixtureOptions = {}): Promise<SshFixture> {
  const host = options.host ?? '127.0.0.1'
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && host !== '::1') throw new Error('Fixtures may only listen on loopback addresses.')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-heaven-fixture-'))
  fs.writeFileSync(path.join(root, 'welcome.txt'), 'Welcome to SSH Heaven!\nLocal SSH and SFTP integration fixture.\n')
  fs.mkdirSync(path.join(root, 'documents'))
  fs.writeFileSync(path.join(root, 'documents', 'notes.txt'), 'Files stay inside the fixture sandbox.\n')

  const username = options.username ?? 'demo'
  const password = options.password ?? 'ssh-heaven-demo'
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  let identityDirectory: string | undefined
  let privateKeyPath: string | undefined
  let passphrase: string | undefined
  let authorizedKey: ParsedKey | undefined
  if (options.privateKeyAuth) {
    passphrase = 'ssh-heaven-test-key-passphrase'
    const identity = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem', cipher: 'aes-256-cbc', passphrase },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    })
    const parsed = utils.parseKey(identity.privateKey, passphrase)
    if (parsed instanceof Error) throw parsed
    authorizedKey = parsed
    // Test identities are kept outside the SFTP tree so directory fixtures stay
    // stable and an SFTP download cannot retrieve an authentication key.
    identityDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-heaven-test-identity-'))
    privateKeyPath = path.join(identityDirectory, 'id_rsa.enc')
    fs.writeFileSync(privateKeyPath, identity.privateKey, { mode: 0o600 })
  }
  const clients = new Set<Connection>()
  const fileDescriptors = new Set<number>()

  // Reject drive names, alternate separators, NUL, traversal above /, and all
  // symlinks. Checking every component also protects creation/rename targets.
  function resolveRemote(remotePath: string): string {
    if (remotePath.includes('\0') || remotePath.includes('\\') || remotePath.includes(':')) {
      throw fixtureError('Invalid fixture path', 'EACCES')
    }
    const segments: string[] = []
    for (const segment of remotePath.split('/')) {
      if (!segment || segment === '.') continue
      if (segment === '..') {
        if (!segments.length) throw fixtureError('Path escapes fixture root', 'EACCES')
        segments.pop()
      } else {
        // Windows silently strips trailing dots/spaces and has reserved device
        // names, so disallow these names consistently on every test platform.
        if (/[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) {
          throw fixtureError('Invalid fixture path component', 'EACCES')
        }
        segments.push(segment)
      }
    }
    const target = path.resolve(root, ...segments)
    const relative = path.relative(root, target)
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw fixtureError('Path escapes fixture root', 'EACCES')
    }
    let ancestor = root
    for (const segment of segments) {
      ancestor = path.join(ancestor, segment)
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) throw fixtureError('Symlinks are disabled in the fixture', 'EACCES')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return target
  }

  function remoteName(localPath: string): string {
    return `/${path.relative(root, localPath).split(path.sep).join('/')}`
  }

  function attributes(stats: fs.Stats) {
    return {
      mode: stats.mode,
      uid: stats.uid,
      gid: stats.gid,
      size: stats.size,
      atime: Math.floor(stats.atimeMs / 1000),
      mtime: Math.floor(stats.mtimeMs / 1000),
    }
  }

  function openShell(stream: ServerChannel, columns: () => number) {
    let input = ''
    let child: ChildProcessWithoutNullStreams | undefined
    stream.once('close', () => { child?.kill() })
    const prompt = () => stream.write(`\r\n${username}@ssh-heaven:/$ `)
    stream.write('SSH Heaven local test server\r\nType help for available commands.\r\n')
    prompt()
    stream.on('data', (data: Buffer) => {
      if (child) { child.stdin.write(data); return }
      for (const char of data.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          if (char === '\n' && input.length === 0) continue
          const command = input.trim()
          input = ''
          stream.write('\r\n')
          if (command === 'exit') { stream.exit(0); stream.end(); return }
          if (command === 'pwd') stream.write('/\r\n')
          else if (command === 'ls' || command === 'ls -la') stream.write(`${fs.readdirSync(root).join('  ')}\r\n`)
          else if (command === 'whoami') stream.write(`${username}\r\n`)
          else if (command.startsWith('echo ')) stream.write(`${command.slice(5)}\r\n`)
          else if (command === 'help') stream.write('Commands: pwd, ls, whoami, echo <text>, clear, exit\r\n')
          else if (command === 'clear') stream.write('\x1b[2J\x1b[H')
          else if (command === 'stream-privacy-fixture') {
            stream.write('PRIVACY-BEGIN\r\n')
            for (let line = 0; line < 45; line++) stream.write(`history-${line} 192.0.2.88\r\n`)
            stream.write('styled \x1b[31m198.51.\x1b[32m100.42\x1b[0m\r\n')
            stream.write('edited 198.51.100.00\x1b[2D42\r\nCJK 中文 203.0.113.57\r\n')
            stream.write(`${'W'.repeat(Math.max(0, columns() - 5))}198.51.100.73\r\n`)
            const chunks = ['split-v4 203.', '0.113.', '19\r\nsplit-v6 2001:db8:', ':1234\r\nPRIVACY-END\r\n']
            chunks.forEach((chunk, index) => setTimeout(() => { if (!stream.destroyed) stream.write(chunk) }, index * 25))
          }
          else if (command === 'stream-privacy-alt') {
            stream.write('\x1b[?1049h\x1b[2J\x1b[HALTERNATE 198.51.100.121\r\n2001:db8::abcd\r\n')
            setTimeout(() => { if (!stream.destroyed) stream.write('\x1b[?1049l\r\nPRIVACY-ALT-END\r\n') }, 200)
          }
          else if (command.startsWith("sh -c 's=$(printf ")) {
            const executable = process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/sh'
            const processHandle = spawn(executable, [...(process.platform === 'win32' ? ['--noprofile', '--norc'] : []), '-c', command], { cwd: root, windowsHide: true, stdio: 'pipe' })
            child = processHandle
            processHandle.stdout.on('data', (chunk: Buffer) => { if (!stream.destroyed) stream.write(chunk) })
            processHandle.stderr.on('data', (chunk: Buffer) => { if (!stream.destroyed) stream.write(chunk) })
            processHandle.once('error', () => { if (!stream.destroyed) stream.write('Fixture script interpreter could not start.\r\n') })
            processHandle.once('close', () => { if (child === processHandle) child = undefined; if (!stream.destroyed) prompt() })
          }
          else if (command) stream.write(`Fixture command not found: ${command}\r\n`)
          if (!child) prompt()
        } else if (char === '\x03') {
          input = ''; stream.write('^C'); prompt()
        } else if (char === '\x7f' || char === '\b') {
          if (input.length) { input = input.slice(0, -1); stream.write('\b \b') }
        } else if (char >= ' ') {
          input += char
          stream.write(char)
        }
      }
    })
  }

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client)
    client.on('error', () => { /* Expected when tests disconnect/reject host keys. */ })
    client.on('close', () => clients.delete(client))
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === username && context.password === password) context.accept()
      else if (context.method === 'publickey' && context.username === username && authorizedKey
        && context.key.algo === authorizedKey.type && context.key.data.equals(authorizedKey.getPublicSSH())
        && (!context.signature || (context.blob && authorizedKey.verify(context.blob, context.signature, context.hashAlgo) === true))) {
        context.accept()
      } else context.reject(authorizedKey ? ['password', 'publickey'] : ['password'])
    })
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept()
      let columns = 80
      session.on('pty', (acceptPty, _reject, info) => { columns = info.cols; acceptPty?.() })
      session.on('window-change', (acceptResize, _reject, info) => { columns = info.cols; acceptResize?.() })
      session.on('shell', (acceptShell) => openShell(acceptShell(), () => columns))
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec()
        if (info.command === 'wait-for-cancel') { stream.write('Waiting for cancellation\n'); return }
        if (info.command === 'signal-terminate') { stream.exit('TERM'); stream.end(); return }
        if (/^exit \d+$/.test(info.command)) { stream.exit(Number(info.command.slice(5))); stream.end(); return }
        if (info.command === 'large-output') stream.write(`${'L'.repeat(300 * 1024)}\nend-of-output\n`)
        else if (info.command.startsWith('echo ')) stream.write(`${info.command.slice(5)}\n`)
        else if (info.command === 'pwd') stream.write('/\n')
        else stream.write('SSH Heaven fixture\n')
        stream.exit(0)
        stream.end()
      })
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()
        let sftpClosed = false
        sftp.once('close', () => { sftpClosed = true })
        type Handle = { kind: 'file'; fd: number } | { kind: 'directory'; localPath: string; consumed: boolean }
        const handles = new Map<string, Handle>()
        let nextHandle = 1
        const makeHandle = (value: Handle) => {
          const handle = Buffer.alloc(4)
          handle.writeUInt32BE(nextHandle++)
          handles.set(handle.toString('hex'), value)
          return handle
        }
        const getHandle = (handle: Buffer) => {
          const value = handles.get(handle.toString('hex'))
          if (!value) throw fixtureError('Unknown handle', 'EBADF')
          return value
        }
        const respond = (requestId: number, operation: () => void) => {
          try { operation() } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            const status = code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE
              : code === 'EACCES' || code === 'EPERM' ? STATUS_CODE.PERMISSION_DENIED
                : STATUS_CODE.FAILURE
            sftp.status(requestId, status, (error as Error).message)
          }
        }
        sftp.on('REALPATH', (requestId, remotePath) => respond(requestId, () => {
          const localPath = resolveRemote(remotePath)
          sftp.name(requestId, [{ filename: remoteName(localPath), longname: remoteName(localPath), attrs: attributes(fs.statSync(localPath)) }])
        }))
        const stat = (requestId: number, remotePath: string) => respond(requestId, () => {
          sftp.attrs(requestId, attributes(fs.statSync(resolveRemote(remotePath))))
        })
        sftp.on('STAT', stat)
        sftp.on('LSTAT', stat)
        sftp.on('FSTAT', (requestId, handle) => respond(requestId, () => {
          const value = getHandle(handle)
          sftp.attrs(requestId, attributes(value.kind === 'file' ? fs.fstatSync(value.fd) : fs.statSync(value.localPath)))
        }))
        sftp.on('OPENDIR', (requestId, remotePath) => respond(requestId, () => {
          const localPath = resolveRemote(remotePath)
          if (!fs.statSync(localPath).isDirectory()) throw fixtureError('Not a directory', 'ENOTDIR')
          sftp.handle(requestId, makeHandle({ kind: 'directory', localPath, consumed: false }))
        }))
        sftp.on('READDIR', (requestId, handle) => respond(requestId, () => {
          const value = getHandle(handle)
          if (value.kind !== 'directory') throw fixtureError('Not a directory handle', 'EBADF')
          if (value.consumed) { sftp.status(requestId, STATUS_CODE.EOF); return }
          value.consumed = true
          const names = fs.readdirSync(value.localPath).map((name) => {
            const localPath = resolveRemote(`${remoteName(value.localPath)}/${name}`)
            return { filename: name, longname: name, attrs: attributes(fs.statSync(localPath)) }
          })
          if (names.length) sftp.name(requestId, names)
          else sftp.status(requestId, STATUS_CODE.EOF)
        }))
        sftp.on('OPEN', (requestId, remotePath, flags, attrs) => respond(requestId, () => {
          let nativeFlags = flags & OPEN_MODE.WRITE ? flags & OPEN_MODE.READ ? fs.constants.O_RDWR : fs.constants.O_WRONLY : fs.constants.O_RDONLY
          if (flags & OPEN_MODE.CREAT) nativeFlags |= fs.constants.O_CREAT
          if (flags & OPEN_MODE.TRUNC) nativeFlags |= fs.constants.O_TRUNC
          if (flags & OPEN_MODE.APPEND) nativeFlags |= fs.constants.O_APPEND
          if (flags & OPEN_MODE.EXCL) nativeFlags |= fs.constants.O_EXCL
          const fd = fs.openSync(resolveRemote(remotePath), nativeFlags, attrs.mode ?? 0o644)
          fileDescriptors.add(fd)
          sftp.handle(requestId, makeHandle({ kind: 'file', fd }))
        }))
        const respondIo = (requestId: number, operation: () => void) => {
          if (options.ioDelayMs) setTimeout(() => { if (!sftpClosed) respond(requestId, operation) }, options.ioDelayMs)
          else respond(requestId, operation)
        }
        sftp.on('READ', (requestId, handle, offset, length) => respondIo(requestId, () => {
          const value = getHandle(handle)
          if (value.kind !== 'file') throw fixtureError('Not a file handle', 'EBADF')
          const buffer = Buffer.alloc(Math.min(length, 256 * 1024))
          const count = fs.readSync(value.fd, buffer, 0, buffer.length, offset)
          if (count === 0) sftp.status(requestId, STATUS_CODE.EOF)
          else sftp.data(requestId, buffer.subarray(0, count))
        }))
        sftp.on('WRITE', (requestId, handle, offset, data) => respondIo(requestId, () => {
          const value = getHandle(handle)
          if (value.kind !== 'file') throw fixtureError('Not a file handle', 'EBADF')
          let written = 0
          while (written < data.length) written += fs.writeSync(value.fd, data, written, data.length - written, offset + written)
          sftp.status(requestId, STATUS_CODE.OK)
        }))
        sftp.on('CLOSE', (requestId, handle) => respond(requestId, () => {
          const value = getHandle(handle)
          if (value.kind === 'file') { fs.closeSync(value.fd); fileDescriptors.delete(value.fd) }
          handles.delete(handle.toString('hex'))
          sftp.status(requestId, STATUS_CODE.OK)
        }))
        sftp.on('MKDIR', (requestId, remotePath, attrs) => respond(requestId, () => {
          fs.mkdirSync(resolveRemote(remotePath), { mode: attrs.mode ?? 0o755 })
          sftp.status(requestId, STATUS_CODE.OK)
        }))
        sftp.on('RENAME', (requestId, oldPath, newPath) => respond(requestId, () => {
          const oldLocalPath = resolveRemote(oldPath)
          if (oldLocalPath === root) throw fixtureError('Cannot rename fixture root', 'EACCES')
          fs.renameSync(oldLocalPath, resolveRemote(newPath))
          sftp.status(requestId, STATUS_CODE.OK)
        }))
        sftp.on('REMOVE', (requestId, remotePath) => respond(requestId, () => {
          fs.unlinkSync(resolveRemote(remotePath))
          sftp.status(requestId, STATUS_CODE.OK)
        }))
        sftp.on('RMDIR', (requestId, remotePath) => respond(requestId, () => {
          const localPath = resolveRemote(remotePath)
          if (localPath === root) throw fixtureError('Cannot remove fixture root', 'EACCES')
          fs.rmdirSync(localPath)
          sftp.status(requestId, STATUS_CODE.OK)
        }))
        sftp.on('close', () => {
          for (const value of handles.values()) {
            if (value.kind === 'file' && fileDescriptors.delete(value.fd)) fs.closeSync(value.fd)
          }
          handles.clear()
        })
      })
    }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not receive a TCP port')
  let closed = false
  return {
    host, port: address.port, username, password, root, privateKeyPath, passphrase,
    async close() {
      if (closed) return
      closed = true
      for (const client of clients) client.end()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      for (const fd of fileDescriptors) fs.closeSync(fd)
      fileDescriptors.clear()
      // root was created by mkdtemp above and is never derived from remote input.
      fs.rmSync(root, { recursive: true, force: true })
      if (identityDirectory) fs.rmSync(identityDirectory, { recursive: true, force: true })
    },
  }
}
