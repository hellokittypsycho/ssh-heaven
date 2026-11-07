import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { runbookVariables, renderRunbook } from '../src/components/Runbooks'

test('runbook arguments quote metacharacters, quotes, and multiline values without evaluating them', () => {
  const value = "service'; $(touch should-not-exist)\n&& echo injected"
  const result = renderRunbook('printf %s {{service}}', { service: value })
  assert.equal(result, `printf %s 'service'"'"'; $(touch should-not-exist)\n&& echo injected'`)
  assert.deepEqual(runbookVariables('echo {{one}} {{ two }} {{one}}'), ['one', 'two'])
  if (process.platform !== 'win32') assert.equal(execFileSync('/bin/sh', ['-c', result], { encoding: 'utf8' }), value)
})

test('runbook substitution rejects quoted/heredoc/invalid variables and missing values', () => {
  for (const command of ['echo "{{name}}"', "echo '{{name}}'", 'echo `echo {{name}}`', 'cat <<EOF\n{{name}}\nEOF']) assert.throws(() => renderRunbook(command, { name: 'value' }), /quotes|heredoc/)
  assert.throws(() => renderRunbook('echo {{bad-name}}', {}), /variable names/)
  assert.throws(() => renderRunbook('echo {{missing}}', {}), /Enter a value/)
  assert.equal(renderRunbook('systemctl status nginx', {}), 'systemctl status nginx')
})
