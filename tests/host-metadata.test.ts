import assert from 'node:assert/strict'
import test from 'node:test'
import { validateProfile, validateStoredData } from '../electron/store'
const profile = { id: 'host', name: 'Production', host: 'example.test', port: 22, username: 'root', authType: 'agent', color: '#f472b6', icon: 'database', notes: 'Service owner: operations\nRestart window: Sunday' }
test('agent authentication and host styling/notes round-trip through native settings validation', () => {
  const value = validateProfile(profile)
  assert.deepEqual(value, profile)
  assert.deepEqual(validateStoredData({ version: 1, profiles: [profile], knownHosts: {} }).profiles[0], profile)
  assert.equal('password' in value, false)
})
test('host metadata rejects unsupported colors/icons and unbounded notes', () => {
  for (const invalid of [{ color: 'url(x)' }, { icon: 'script' }, { notes: 'x'.repeat(2001) }, { notes: 'bad\0value' }, { authType: 'invalid' }]) assert.throws(() => validateProfile({ ...profile, ...invalid }))
})
