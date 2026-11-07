import assert from 'node:assert/strict'
import test from 'node:test'
import { privateProps } from '../src/privacy-jsx/mask'
import { setStreamMode } from '../src/stream-mode'

test('stream presentation masks DOM text and accessible hints without mutating connection props or control values', () => {
  const ip = '203.0.113.12'
  const props = { children: ['Server ', ip], title: `Connect to ${ip}`, 'aria-label': ip, value: ip, id: ip, onClick: () => ip }
  try {
    setStreamMode(false)
    assert.equal(privateProps('span', props), props)
    setStreamMode(true)
    const masked = privateProps('input', props) as typeof props & { 'data-stream-private-input': string }
    assert.deepEqual(masked.children, ['Server ', '•'.repeat(ip.length)])
    assert.equal(masked.title, `Connect to ${'•'.repeat(ip.length)}`)
    assert.equal(masked['aria-label'], '•'.repeat(ip.length))
    assert.equal(masked.value, ip)
    assert.equal(masked.id, ip)
    assert.equal(masked.onClick(), ip)
    assert.equal(masked['data-stream-private-input'], 'true')
    assert.equal(privateProps(() => null, props), props)
    assert.equal(props.title, `Connect to ${ip}`)
    const option = privateProps('option', { children: ip }) as { children: string; value: string }
    assert.equal(option.children, '•'.repeat(ip.length))
    assert.equal(option.value, ip, 'masking a native dropdown must preserve its implicit submitted value')
    const textarea = privateProps('textarea', { children: ip }) as { children?: string; defaultValue: string }
    assert.equal(textarea.children, undefined)
    assert.equal(textarea.defaultValue, ip, 'an uncontrolled text area must retain its original model')
    const split = privateProps('span', { children: ['203.0.', false, '113.12'] }) as { children: unknown[] }
    assert.deepEqual(split.children, ['•'.repeat(6), false, '•'.repeat(6)], 'adjacent JSX text pieces must mask a complete address together')
  } finally { setStreamMode(false) }
})
