import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_IMPORT_ENTRIES, MAX_IMPORT_TEXT_BYTES, parseBulkHosts } from '../shared/import'
import type { BulkImportRequest } from '../shared/types'

const request = (text: string, changes: Partial<BulkImportRequest> = {}): BulkImportRequest => ({ text, port: 22, authType: 'password', ...changes })

test('bulk import accepts DNS/IPv4, root defaults, colon passwords, and original physical line numbers', () => {
  const result = parseBulkHosts(request('\uFEFF# Private host list\n\n1.1.1.1:root:password\r\nserver.example:another-password\n  # another comment\nlocalhost:admin:pass:with:colons\nnode-1.example.:deploy: padded password \n'))
  assert.deepEqual(result, {
    entries: [
      { line: 3, host: '1.1.1.1', username: 'root', password: 'password' },
      { line: 4, host: 'server.example', username: 'root', password: 'another-password' },
      { line: 6, host: 'localhost', username: 'admin', password: 'pass:with:colons' },
      { line: 7, host: 'node-1.example.', username: 'deploy', password: ' padded password ' },
    ],
    errors: [], totalLines: 4, duplicates: 0,
  })
})

test('bulk import validates bracketed IPv6 including compression and embedded IPv4', () => {
  const result = parseBulkHosts(request('[::1]:root:local\n[2001:db8:0:0:0:0:0:1]:deploy:remote\n[::ffff:192.0.2.128]:mapped-password\n[2001:db8::1]:admin:https://password.example:443'))
  assert.deepEqual(result.entries.map(({ host, username, password }) => ({ host, username, password })), [
    { host: '::1', username: 'root', password: 'local' },
    { host: '2001:db8:0:0:0:0:0:1', username: 'deploy', password: 'remote' },
    { host: '::ffff:192.0.2.128', username: 'root', password: 'mapped-password' },
    { host: '2001:db8::1', username: 'admin', password: 'https://password.example:443' },
  ])
  assert.deepEqual(result.errors, [])
  const invalid = ['[:::1]:root:pass', '[1::2::3]:root:pass', '[1:2:3:4:5:6:7]:root:pass', '[1:2:3:4:5:6:7:8:9]:root:pass', '[1:2:3:4:5:6:7:8::]:root:pass', '[::ffff:999.0.0.1]:root:pass', '[fe80::1%eth0]:root:pass', '[::1]junk:root:pass', '[::1:root:pass']
  assert.equal(parseBulkHosts(request(invalid.join('\n'))).errors.length, invalid.length)
})

test('shared-key import accepts bare hosts and usernames while discarding every supplied password', () => {
  const preview = parseBulkHosts(request('host1.example\nhost2.example:deploy\nhost3.example:admin:DO_NOT_RETAIN:MORE_SECRET\n[::1]\n[2001:DB8::2]:operator:any-password\nhost4.example:admin:', { authType: 'privateKey', privateKeyPath: 'C:\\keys\\id_ed25519' }))
  assert.deepEqual(preview.entries, [
    { line: 1, host: 'host1.example', username: 'root' },
    { line: 2, host: 'host2.example', username: 'deploy' },
    { line: 3, host: 'host3.example', username: 'admin' },
    { line: 4, host: '::1', username: 'root' },
    { line: 5, host: '2001:DB8::2', username: 'operator' },
    { line: 6, host: 'host4.example', username: 'admin' },
  ])
  assert.deepEqual(preview.errors, [])
  assert.equal(JSON.stringify(preview).includes('SECRET'), false)
  assert.equal(preview.entries.some((entry) => 'password' in entry), false)
  assert.equal(parseBulkHosts(request('host.example:', { authType: 'privateKey' })).errors.length, 1)
})

test('bulk import deduplicates hostname case and username endpoints while keeping the first credentials', () => {
  const preview = parseBulkHosts(request('Example.com:root:first\nexample.COM:root:second\nexample.com:admin:third\n[2001:DB8::1]:root:fourth\n[2001:db8::1]:root:fifth'))
  assert.equal(preview.totalLines, 5)
  assert.equal(preview.duplicates, 2)
  assert.deepEqual(preview.entries.map((entry) => entry.password), ['first', 'third', 'fourth'])
  assert.deepEqual(preview.errors, [])
})

test('bulk import rejects malformed hosts and credentials without echoing sensitive input', () => {
  const invalid = [
    '999.1.1.1:root:SUPER_SECRET', '127.1:root:SUPER_SECRET', '1.2.3.4.5:root:SUPER_SECRET', '192.168.01.1:root:SUPER_SECRET',
    'https://example.com:root:SUPER_SECRET', 'https://example.com', 'ssh://example.com', 'user@example.com:SUPER_SECRET', 'server/path:SUPER_SECRET', 'server\\path:SUPER_SECRET',
    'white space.example:SUPER_SECRET', ' leading.example:SUPER_SECRET', 'trailing.example :SUPER_SECRET', 'server\tname:SUPER_SECRET',
    '-bad.example:SUPER_SECRET', 'bad-.example:SUPER_SECRET', 'bad..example:SUPER_SECRET', 'bad_name.example:SUPER_SECRET',
    `${'a'.repeat(64)}.example:SUPER_SECRET`, `${'abc.'.repeat(64)}example:SUPER_SECRET`,
    'example.com::SUPER_SECRET', 'example.com:bad user:SUPER_SECRET', 'example.com:bad/user:SUPER_SECRET',
    'example.com:', 'example.com:root:', 'bare.example', `example.com:root:${'p'.repeat(8193)}`, 'example.com:root:SUPER_SECRET\0',
  ]
  const result = parseBulkHosts(request(invalid.join('\n')))
  assert.deepEqual(result.entries, [])
  assert.equal(result.errors.length, invalid.length)
  assert.deepEqual(result.errors.map((error) => error.line), invalid.map((_, index) => index + 1))
  assert.ok(result.errors.every((error) => !error.message.includes('SUPER_SECRET') && !error.message.includes('example.com')))
  assert.equal(result.totalLines, invalid.length)
})

test('bulk import uses only the global port; an apparent line port remains an ordinary username field', () => {
  const result = parseBulkHosts(request('example.com:2222:password', { port: 2200 }))
  assert.deepEqual(result.entries, [{ line: 1, host: 'example.com', username: '2222', password: 'password' }])
  assert.equal('port' in result.entries[0], false)
})

test('bulk import caps unique entries, reports overflow once, and still counts later duplicates', () => {
  const lines = Array.from({ length: MAX_IMPORT_ENTRIES + 2 }, (_, index) => `host${index}.example:password`)
  lines.push('HOST0.EXAMPLE:other-password')
  const result = parseBulkHosts(request(lines.join('\n')))
  assert.equal(result.entries.length, MAX_IMPORT_ENTRIES)
  assert.equal(result.totalLines, MAX_IMPORT_ENTRIES + 3)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0].line, 201)
  assert.match(result.errors[0].message, /200/)
  assert.equal(result.duplicates, 1)
  // Many bad rows cannot inflate an error preview without bound.
  assert.ok(parseBulkHosts(request('invalid\n'.repeat(500))).errors.length <= 201)
})

test('bulk import validates request-level limits and accepts empty/comment-only previews', () => {
  for (const value of [null, [], '', { text: 12, port: 22, authType: 'password' }, request('', { port: 0 }), request('', { port: 65536 }), request('', { port: 1.5 }), request('', { authType: 'invalid' as 'password' }), request('', { group: 'x'.repeat(101) }), request('', { group: 'bad\0group' }), request('', { privateKeyPath: 'bad\0key' })]) {
    assert.throws(() => parseBulkHosts(value))
  }
  assert.throws(() => parseBulkHosts(request('x'.repeat(MAX_IMPORT_TEXT_BYTES + 1))), /1 MiB/)
  assert.throws(() => parseBulkHosts(request('☁'.repeat(Math.floor(MAX_IMPORT_TEXT_BYTES / 3) + 1))), /1 MiB/)
  assert.deepEqual(parseBulkHosts(request(' \n# no hosts\r\n\t')), { entries: [], errors: [], totalLines: 0, duplicates: 0 })
})
