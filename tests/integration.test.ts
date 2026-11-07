import assert from 'node:assert/strict'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import ssh2, { type SFTPWrapper } from 'ssh2'
import { startFixture } from './fixture'

const { Client } = ssh2

test('SSH shell and SFTP file operations work against an isolated local server', { timeout: 30_000 }, async () => {
  const fixture = await startFixture()
  const client = new Client()
  try {
    const ready = once(client, 'ready')
    client.connect({ host: fixture.host, port: fixture.port, username: fixture.username, password: fixture.password })
    await ready

    const output = await new Promise<string>((resolve, reject) => {
      client.shell((error, stream) => {
        if (error) { reject(error); return }
        let text = ''
        stream.on('data', (data: Buffer) => { text += data.toString() })
        stream.on('error', reject)
        stream.on('close', () => resolve(text))
        stream.write('whoami\rpwd\recho terminal-integration-marker\rexit\r')
      })
    })
    assert.match(output, /SSH Heaven local test server/)
    assert.match(output, /\r\nterminal-integration-marker\r\n/)
    assert.match(output, /\r\ndemo\r\n/)

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)))
    const initial = await new Promise<string>((resolve, reject) => sftp.realpath('.', (error, value) => error ? reject(error) : resolve(value)))
    assert.equal(initial, '/')
    const entries = await new Promise<string[]>((resolve, reject) => sftp.readdir('/', (error, value) => error ? reject(error) : resolve(value.map((entry) => entry.filename))))
    assert.ok(entries.includes('welcome.txt'))
    assert.ok(entries.includes('documents'))

    await new Promise<void>((resolve, reject) => sftp.mkdir('/transfer-test', (error) => error ? reject(error) : resolve()))
    // More than one SFTP packet ensures offsets and transfer chunking are tested.
    const payload = Buffer.from('ssh-heaven-transfer-\u2601\n'.repeat(8_000))
    await new Promise<void>((resolve, reject) => sftp.writeFile('/transfer-test/upload.txt', payload, (error) => error ? reject(error) : resolve()))
    const downloaded = await new Promise<Buffer>((resolve, reject) => sftp.readFile('/transfer-test/upload.txt', (error, value) => error ? reject(error) : resolve(value)))
    assert.deepEqual(downloaded, payload)
    assert.deepEqual(await fs.readFile(path.join(fixture.root, 'transfer-test', 'upload.txt')), payload)
    await new Promise<void>((resolve, reject) => sftp.rename('/transfer-test/upload.txt', '/transfer-test/renamed.txt', (error) => error ? reject(error) : resolve()))
    const stats = await new Promise<{ size: number }>((resolve, reject) => sftp.stat('/transfer-test/renamed.txt', (error, value) => error ? reject(error) : resolve(value)))
    assert.equal(stats.size, payload.length)
    await new Promise<void>((resolve, reject) => sftp.unlink('/transfer-test/renamed.txt', (error) => error ? reject(error) : resolve()))
    await new Promise<void>((resolve, reject) => sftp.rmdir('/transfer-test', (error) => error ? reject(error) : resolve()))
    assert.deepEqual((await fs.readdir(fixture.root)).sort(), ['documents', 'welcome.txt'])

    for (const remotePath of ['/../escape.txt', '/documents/../../escape.txt', '/C:/escape.txt', '/documents\\..\\escape.txt']) {
      await assert.rejects(new Promise<void>((resolve, reject) => sftp.writeFile(remotePath, 'escape', (error) => error ? reject(error) : resolve())))
    }
    sftp.end()
  } finally {
    client.end()
    await fixture.close()
  }
  await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' })
})

test('SSH authentication rejects incorrect passwords', { timeout: 15_000 }, async () => {
  const fixture = await startFixture()
  const client = new Client()
  try {
    const rejected = new Promise<Error>((resolve, reject) => {
      client.once('error', resolve)
      client.once('ready', () => reject(new Error('Incorrect password was accepted')))
    })
    client.connect({ host: fixture.host, port: fixture.port, username: fixture.username, password: 'wrong-password' })
    assert.match((await rejected).message, /authentication/i)
  } finally {
    client.end()
    await fixture.close()
  }
})
