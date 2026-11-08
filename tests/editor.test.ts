import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { SFTPWrapper } from 'ssh2'
import { MAX_EDITOR_BYTES, RemoteEditorService } from '../electron/remote-editor'
import { SshService } from '../electron/ssh-service'
import { AppStore } from '../electron/store'
import { startFixture } from './fixture'

async function harness(bound = false) {
  const fixture = await startFixture()
  const directory = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-editor-'))
  const store = new AppStore(path.join(directory, 'settings.json'))
  await store.load()
  const owner = 601
  const sessionId = 'editor-session'
  const service = new SshService(store, {
    data() {}, status() {},
    hostKey(ownerId, challenge) { queueMicrotask(() => service.resolveHostKey(ownerId, challenge.requestId, true)) }
  })
  await service.connect({ sessionId, password: fixture.password, profile: { id: 'editor-fixture', name: 'Editor fixture', host: fixture.host, port: fixture.port, username: fixture.username, authType: 'password' } }, owner)
  const getSftp = (ownerId: number, id: string) => service.getSftp(ownerId, id)
  const editor = new RemoteEditorService(getSftp, bound ? (ownerId, id) => service.getClient(ownerId, id) : undefined)
  return {
    fixture, directory, service, editor, owner, sessionId,
    async close() { service.dispose(); await fixture.close(); await rm(directory, { recursive: true, force: true }) }
  }
}

test('editor versions cannot be reused after a session ID reconnects to another server with identical file bytes', async () => {
  const h = await harness(true), other = await startFixture()
  try {
    const opened = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    const otherPath = path.join(other.root, 'welcome.txt'), original = await readFile(otherPath, 'utf8')
    assert.equal(original, opened.content)
    h.service.disconnect(h.owner, h.sessionId)
    await h.service.connect({ sessionId: h.sessionId, password: other.password, profile: { id: 'other-editor', name: 'Other editor target', host: other.host, port: other.port, username: other.username, authType: 'password' } }, h.owner)
    await assert.rejects(h.editor.save(h.owner, h.sessionId, opened.path, 'Old server draft must stay local', opened.version), /conflict|connection changed/i)
    assert.equal(await readFile(otherPath, 'utf8'), original)
    const reloaded = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    const saved = await h.editor.save(h.owner, h.sessionId, reloaded.path, 'Explicitly reloaded current target\n', reloaded.version)
    assert.equal(saved.content, 'Explicitly reloaded current target\n')
  } finally { await h.close(); await other.close() }
})

test('editor drafts remain valid when only SFTP reopens on the same live SSH connection', async () => {
  const h = await harness(true)
  try {
    const opened = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    const client = h.service.getClient(h.owner, h.sessionId), sftp = await h.service.getSftp(h.owner, h.sessionId)
    const closed = new Promise<void>((resolve) => sftp.once('close', () => resolve()))
    h.fixture.closeSftpChannels(); await closed
    const reopened = await h.service.getSftp(h.owner, h.sessionId)
    assert.notEqual(reopened, sftp)
    assert.equal(h.service.getClient(h.owner, h.sessionId), client)
    const saved = await h.editor.save(h.owner, h.sessionId, opened.path, 'Same SSH connection, recovered SFTP\n', opened.version)
    assert.equal(saved.content, 'Same SSH connection, recovered SFTP\n')
  } finally { await h.close() }
})

test('remote editor reads and saves UTF-8 text with BOM/line endings intact and correct content hashes', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const original = '\uFEFFconst greeting = "你好";\r\n'
    await writeFile(path.join(h.fixture.root, 'source.ts'), original, 'utf8')
    const opened = await h.editor.read(h.owner, h.sessionId, '/source.ts')
    assert.equal(opened.content, original)
    assert.equal(opened.version, createHash('sha256').update(Buffer.from(original)).digest('hex'))
    assert.equal(opened.size, Buffer.byteLength(original))
    const content = `\uFEFF${'// Multiple chunks with UTF-8 text ☁\r\n'.repeat(8000)}export const saved = true;\r\n`
    const saved = await h.editor.save(h.owner, h.sessionId, opened.path, content, opened.version)
    assert.equal(saved.content, content)
    assert.equal(saved.version, createHash('sha256').update(Buffer.from(content)).digest('hex'))
    assert.equal(saved.size, Buffer.byteLength(content))
    assert.equal(await readFile(path.join(h.fixture.root, 'source.ts'), 'utf8'), content)
    assert.equal((await readdir(h.fixture.root)).some((name) => name.endsWith('.part')), false)
    const empty = await h.editor.save(h.owner, h.sessionId, '/source.ts', '', saved.version)
    assert.equal(empty.content, '')
    assert.equal(empty.size, 0)
    await assert.rejects(h.editor.read(999, h.sessionId, '/welcome.txt'), /another window/)
    await assert.rejects(h.editor.save(999, h.sessionId, '/source.ts', 'unauthorized', empty.version), /another window/)
  } finally { await h.close() }
})

test('remote editor rejects binary, invalid UTF-8, folders, oversized files, and oversized saves without modifying originals', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await writeFile(path.join(h.fixture.root, 'binary.bin'), Buffer.from([0x01, 0x00, 0x02]))
    await writeFile(path.join(h.fixture.root, 'invalid.txt'), Buffer.from([0xc3, 0x28]))
    await writeFile(path.join(h.fixture.root, 'large.txt'), Buffer.alloc(MAX_EDITOR_BYTES + 1, 0x61))
    await assert.rejects(h.editor.read(h.owner, h.sessionId, '/binary.bin'), /binary/)
    await assert.rejects(h.editor.read(h.owner, h.sessionId, '/invalid.txt'), /UTF-8/)
    await assert.rejects(h.editor.read(h.owner, h.sessionId, '/large.txt'), /2 MiB/)
    await assert.rejects(h.editor.read(h.owner, h.sessionId, '/documents'), /regular/)
    const opened = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    await assert.rejects(h.editor.save(h.owner, h.sessionId, opened.path, 'a'.repeat(MAX_EDITOR_BYTES + 1), opened.version), /2 MiB/)
    await assert.rejects(h.editor.save(h.owner, h.sessionId, opened.path, 'contains\0binary', opened.version), /binary/)
    await assert.rejects(h.editor.save(h.owner, h.sessionId, opened.path, 'unpaired\uD800', opened.version), /Unicode/)
    await assert.rejects(h.editor.save(h.owner, h.sessionId, opened.path, 'new content', 'missing-version'), /Reload/)
    assert.equal(await readFile(path.join(h.fixture.root, 'welcome.txt'), 'utf8'), opened.content)
    assert.equal((await readdir(h.fixture.root)).some((name) => name.endsWith('.part')), false)
  } finally { await h.close() }
})

test('remote editor detects stale versions before saving and changes occurring while the temporary sibling is written', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const opened = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    await writeFile(path.join(h.fixture.root, 'welcome.txt'), 'Modified externally before save')
    await assert.rejects(h.editor.save(h.owner, h.sessionId, opened.path, 'Would overwrite newer work', opened.version), /conflict/i)
    assert.equal(await readFile(path.join(h.fixture.root, 'welcome.txt'), 'utf8'), 'Modified externally before save')
    const fresh = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    const sftp = await h.service.getSftp(h.owner, h.sessionId)
    let changed = false
    const concurrent = new Proxy(sftp, {
      get(target, property) {
        if (property === 'write') return (handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error?: Error | null) => void) => {
          target.write(handle, buffer, offset, length, position, (error) => {
            if (error || changed) { callback(error); return }
            changed = true
            void writeFile(path.join(h.fixture.root, 'welcome.txt'), 'Modified externally while saving').then(() => callback(), callback)
          })
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as SFTPWrapper
    const editor = new RemoteEditorService(async () => concurrent)
    await assert.rejects(editor.save(h.owner, h.sessionId, fresh.path, 'Still must not overwrite newer work', fresh.version), /conflict.*while saving/i)
    assert.equal(await readFile(path.join(h.fixture.root, 'welcome.txt'), 'utf8'), 'Modified externally while saving')
    assert.equal((await readdir(h.fixture.root)).some((name) => name.endsWith('.part')), false)
  } finally { await h.close() }
})

test('a remote editor save failure preserves the original and removes its own temporary sibling', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const opened = await h.editor.read(h.owner, h.sessionId, '/welcome.txt')
    const sftp = await h.service.getSftp(h.owner, h.sessionId)
    const limited = new Proxy(sftp, {
      get(target, property) {
        if (property === 'ext_openssh_rename') return () => { throw new Error('Server does not support this extended request') }
        if (property === 'rename') return (_source: string, _destination: string, callback: (error: Error) => void) => callback(new Error('Overwrite unavailable'))
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as SFTPWrapper
    const editor = new RemoteEditorService(async () => limited)
    await assert.rejects(editor.save(h.owner, h.sessionId, opened.path, 'Incomplete save', opened.version), /original file was preserved/)
    assert.equal(await readFile(path.join(h.fixture.root, 'welcome.txt'), 'utf8'), opened.content)
    assert.equal((await readdir(h.fixture.root)).some((name) => name.endsWith('.part')), false)
    assert.ok((await h.service.listDirectory(h.owner, h.sessionId, '/')).entries.some((entry) => entry.name === 'welcome.txt'))
  } finally { await h.close() }
})
