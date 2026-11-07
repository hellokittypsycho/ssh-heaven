import assert from 'node:assert/strict'
import test from 'node:test'
import { findIPRanges, redactIPs } from '../shared/ip-redaction'

test('display IP masking handles IPv4, compressed/full IPv6, scopes and mapped addresses without changing widths', () => {
  for (const address of ['0.0.0.0', '127.0.0.1', '192.168.1.254', '255.255.255.255', '001.002.003.004', '::', '::1', '2001:db8::1', '2001:DB8:0:0:0:0:2:1', 'fe80::42%eth0', '::ffff:192.0.2.15', '2001:db8:0:0:0:0:192.0.2.1']) {
    const text = `connect [${address}] now`
    const result = redactIPs(text)
    assert.equal(result, `connect [${'•'.repeat(address.length)}] now`, address)
    assert.equal(result.length, text.length)
  }
})
test('IP redaction preserves surrounding text, bracketed ports, punctuation, Unicode and multiple addresses', () => {
  const text = '你好 demo@127.0.0.1:22 → [2001:db8::12]:2222, address=fe80::1%en0.'
  const ranges = findIPRanges(text)
  assert.deepEqual(ranges.map(({ start, end }) => text.slice(start, end)), ['127.0.0.1', '2001:db8::12', 'fe80::1%en0.'])
  assert.equal(redactIPs(text), '你好 demo@•••••••••:22 → [••••••••••••]:2222, address=••••••••••••')
  assert.equal(redactIPs(text).length, text.length)
})
test('redaction rejects invalid IPv4/IPv6 and leaves common numbers, hostnames and times alone', () => {
  for (const value of ['999.1.2.3', '192.168.1.999', '1.2.3', '1.2.3.4.5', '2001:db8:1', '2001:::1', '2001:db8::1::2', '12:34:56', '1234:5678:abcd', 'example.com', 'version 1.2.3', 'CPU 80%', 'foo::bar']) assert.equal(redactIPs(value), value)
})
test('mapped IPv6 and embedded IPv4 matches merge into one range', () => {
  assert.deepEqual(findIPRanges('::ffff:192.0.2.15'), [{ start: 0, end: 17 }])
})
