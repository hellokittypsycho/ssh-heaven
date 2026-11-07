import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const publisher = process.env.SSH_HEAVEN_PUBLISHER?.trim()
const feed = process.env.SSH_HEAVEN_UPDATE_URL
const download = process.env.SSH_HEAVEN_DOWNLOAD_URL
if (!publisher) throw new Error('Set SSH_HEAVEN_PUBLISHER before building a signed release. See RELEASE.md.')
if (!!feed !== !!download) throw new Error('Set both SSH_HEAVEN_UPDATE_URL and SSH_HEAVEN_DOWNLOAD_URL, or leave both unset.')
function secureUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) throw new Error('Use fixed HTTPS release URLs without credentials or query parameters.')
  return url.href
}
const certificateSubject = process.env.SSH_HEAVEN_CERTIFICATE_SUBJECT
if (!process.env.WIN_CSC_LINK && !process.env.CSC_LINK && !certificateSubject) throw new Error('Configure a signing certificate through WIN_CSC_LINK/CSC_LINK or SSH_HEAVEN_CERTIFICATE_SUBJECT. See RELEASE.md.')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const configFile = path.join(root, 'build', 'release-config.json')
const original = await readFile(configFile, 'utf8')
const temporary = await mkdtemp(path.join(tmpdir(), 'ssh-heaven-release-'))
async function run(script, args) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit', windowsHide: true })
    child.on('error', reject); child.on('exit', (code) => resolve(code ?? 1))
  })
  if (code !== 0) throw new Error(`Release build exited with status ${code}.`)
}
try {
  // Keep the tracked GitHub provider unless a custom version manifest is supplied.
  if (feed) await writeFile(configFile, JSON.stringify({ enabled: true, provider: 'manifest', manifestUrl: secureUrl(feed), downloadUrl: secureUrl(download) }, null, 2))
  const config = { ...pkg.build, forceCodeSigning: true,
    win: { ...pkg.build.win, signExecutable: true,
      signtoolOptions: { publisherName: publisher, signingHashAlgorithms: ['sha256'], ...(certificateSubject ? { certificateSubjectName: certificateSubject } : {}) } } }
  const builderConfig = path.join(temporary, 'builder.json')
  await writeFile(builderConfig, JSON.stringify(config))
  await run(path.join(root, 'scripts/build-mcp.mjs'), [])
  await run(path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), ['build'])
  await run(path.join(root, 'node_modules/electron-builder/cli.js'), ['--config', builderConfig, '--win', 'nsis', '--publish', 'never'])
  if (feed) await writeFile(path.join(root, 'release', 'version.json'), JSON.stringify({ version: pkg.version }, null, 2))
} finally {
  await writeFile(configFile, original)
  // This is only the absolute directory returned by mkdtemp above.
  if (path.dirname(temporary) !== path.resolve(tmpdir()) || !path.basename(temporary).startsWith('ssh-heaven-release-')) throw new Error('Unexpected temporary release directory.')
  await rm(temporary, { recursive: true, force: true })
}
