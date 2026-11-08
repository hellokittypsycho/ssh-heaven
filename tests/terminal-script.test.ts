import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { ScriptCompletionParser, terminalScript } from '../electron/terminal-script'

const nonce = 'ab'.repeat(24)
const marker = (code: string | number, token = nonce) => Buffer.from(`\x1b]777;ssh-heaven;${token};${code}\x07`)
test('completion frames survive every chunk boundary, preserve UTF-8/ANSI bytes, and are never rendered', () => {
  const before = Buffer.from('中文\x1b[31mreal output\x1b[0m\r\n'), after = Buffer.from('prompt$ ')
  const value = Buffer.concat([before, marker(7), after])
  for (let split = 0; split <= value.length; split++) {
    const parser = new ScriptCompletionParser(nonce)
    const first = parser.consume(value.subarray(0, split)), second = parser.consume(value.subarray(split))
    assert.deepEqual(Buffer.concat([first.data, second.data]), Buffer.concat([before, after]))
    assert.equal(first.exitCode ?? second.exitCode, 7)
  }
})
test('plain status text, other nonces, overlong codes, and malformed frames cannot forge completion', () => {
  const invalid = Buffer.concat([Buffer.from('completed Exit 0 ssh-heaven 0\n'), marker(0, 'cd'.repeat(24)), marker('999'), marker('0000'), marker('-1'), marker('abc')])
  const parser = new ScriptCompletionParser(nonce)
  const chunks: Buffer[] = []
  for (const byte of invalid) {
    const result = parser.consume(Buffer.from([byte])); assert.equal(result.exitCode, undefined); chunks.push(result.data)
  }
  assert.deepEqual(Buffer.concat(chunks), invalid)
  const real = parser.consume(marker(0)); assert.equal(real.exitCode, 0); assert.equal(real.data.length, 0)
  assert.equal(parser.consume(marker(7)).exitCode, undefined, 'a run completes exactly once')
})
test('large malformed output remains bounded and a later valid completion still works', () => {
  const parser = new ScriptCompletionParser(nonce)
  const value = Buffer.concat([marker('').subarray(0, -1), Buffer.alloc(1024 * 1024, 65)])
  assert.deepEqual(parser.consume(value).data, value)
  assert.equal(parser.consume(marker(255)).exitCode, 255)
})
test('detaching a completed parser preserves a trailing partial terminal escape without parsing later output', () => {
  const parser = new ScriptCompletionParser(nonce)
  const parsed = parser.consume(Buffer.concat([marker(0), Buffer.from('prompt\x1b')]))
  assert.equal(parsed.exitCode, 0)
  assert.deepEqual(Buffer.concat([parsed.data, parser.flush()]), Buffer.from('prompt\x1b'))
  assert.equal(parser.flush().length, 0)
})
test('the real child shell preserves Unicode, tabs, quotes, trailing newlines, and its actual exit status', { timeout: 15_000 }, async () => {
  const script = "printf '%s\\n' 'quotes\" and 中文'\nprintf '\\tend\\n'\nexit 7\n\n"
  const { payload, parser } = terminalScript(script)
  assert.match(payload, /^sh -c 's=\$\(printf /)
  assert.equal(/[\x00-\x1f\x7f]/.test(payload.slice(0, -1)), false, 'only the final Enter may be a terminal control byte')
  const executable = process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe') : '/bin/sh'
  const result = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(executable, [...(process.platform === 'win32' ? ['--noprofile', '--norc'] : []), '-c', payload.slice(0, -1)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk)); child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.once('error', reject); child.once('close', () => resolve(Buffer.concat(chunks)))
  })
  const parsed = parser.consume(result)
  assert.equal(parsed.data.toString('utf8'), 'quotes" and 中文\n\tend\n')
  assert.equal(parsed.exitCode, 7)
})
