import assert from 'node:assert/strict'
import test from 'node:test'
import { getRemoteFolders, REMOTE_FOLDERS_KEY, saveRemoteFolders } from '../src/remote-folders'
const memory = () => { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } } }
test('folder metadata stays bound to one host and contains only validated paths/names', () => {
  const storage = memory()
  saveRemoteFolders('a', { lastFolder: '/var/log', bookmarks: [{ name: ' Logs ', path: '/var/log' }, { name: 'Duplicate', path: '/var/log' }, { name: 'Bad', path: 'bad\0path' }] }, storage)
  assert.deepEqual(getRemoteFolders('a', storage), { lastFolder: '/var/log', bookmarks: [{ name: 'Logs', path: '/var/log' }] })
  assert.deepEqual(getRemoteFolders('b', storage), { bookmarks: [] })
  assert.deepEqual(getRemoteFolders(undefined, storage), { bookmarks: [] })
})
test('malformed metadata and unusual profile IDs are safe, bounded, and replaceable', () => {
  const storage = memory()
  storage.setItem(REMOTE_FOLDERS_KEY, '{broken')
  assert.deepEqual(getRemoteFolders('a', storage), { bookmarks: [] })
  saveRemoteFolders('__proto__', { bookmarks: [{ name: 'Root', path: '/' }] }, storage)
  assert.deepEqual(getRemoteFolders('__proto__', storage).bookmarks, [{ name: 'Root', path: '/' }])
  saveRemoteFolders('a', { bookmarks: Array.from({ length: 40 }, (_, index) => ({ name: `Folder ${index}`, path: `/folder${index}` })) }, storage)
  assert.equal(getRemoteFolders('a', storage).bookmarks.length, 30)
})
