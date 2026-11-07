import type { BulkImportRequest, ImportEntry, ImportPreview } from './types'

export const MAX_IMPORT_TEXT_BYTES = 1024 * 1024
export const MAX_IMPORT_ENTRIES = 200
const MAX_PREVIEW_ERRORS = 200

function validateRequest(value: unknown): BulkImportRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host import request.')
  const input = value as Record<string, unknown>
  if (typeof input.text !== 'string') throw new Error('Provide host import text.')
  if (input.text.length > MAX_IMPORT_TEXT_BYTES || new TextEncoder().encode(input.text).byteLength > MAX_IMPORT_TEXT_BYTES) {
    throw new Error('The import text exceeds the 1 MiB limit.')
  }
  if (!Number.isInteger(input.port) || typeof input.port !== 'number' || input.port < 1 || input.port > 65535) {
    throw new Error('Choose an SSH port from 1 to 65535.')
  }
  if (input.authType !== 'password' && input.authType !== 'privateKey') throw new Error('Choose password or private key authentication.')
  if (input.group !== undefined && (typeof input.group !== 'string' || input.group.length > 100 || /[\x00-\x1f\x7f]/.test(input.group))) {
    throw new Error('The import group must be at most 100 characters without control characters.')
  }
  if (input.privateKeyPath !== undefined && (typeof input.privateKeyPath !== 'string' || input.privateKeyPath.length > 32768 || input.privateKeyPath.includes('\0'))) {
    throw new Error('Choose a valid private key path.')
  }
  return {
    text: input.text,
    port: input.port,
    authType: input.authType,
    ...(input.group !== undefined ? { group: input.group as string } : {}),
    ...(input.privateKeyPath !== undefined ? { privateKeyPath: input.privateKeyPath as string } : {}),
  }
}

function isIPv4(host: string): boolean {
  const octets = host.split('.')
  return octets.length === 4 && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
}

function isIPv6(host: string): boolean {
  if (!/^[\da-f:.]+$/i.test(host) || !host.includes(':')) return false
  const compressedAt = host.indexOf('::')
  if (compressedAt !== -1 && host.indexOf('::', compressedAt + 2) !== -1) return false
  const left = compressedAt === -1 ? host : host.slice(0, compressedAt)
  const right = compressedAt === -1 ? '' : host.slice(compressedAt + 2)
  const groups = [...(left ? left.split(':') : []), ...(right ? right.split(':') : [])]
  let units = 0
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    if (group.includes('.')) {
      if (index !== groups.length - 1 || !host.endsWith(group) || !isIPv4(group)) return false
      units += 2
    } else {
      if (!/^[\da-f]{1,4}$/i.test(group)) return false
      units++
    }
  }
  return compressedAt === -1 ? units === 8 : units < 8
}

function validHostname(host: string): boolean {
  if (!host || host.length > 253 || /[\s\x00-\x1f\x7f:/\\@?#\[\]]/.test(host)) return false
  // Numeric addresses must pass IPv4 validation rather than falling through
  // as DNS labels (for example 999.10.10.10 or abbreviated 127.1).
  if (/^[\d.]+$/.test(host)) return isIPv4(host)
  const dns = host.endsWith('.') ? host.slice(0, -1) : host
  return dns.split('.').every((label) => label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))
}

function validUsername(username: string): boolean {
  return username.length > 0 && username.length <= 256 && !/[\s\x00-\x1f\x7f/:]/.test(username)
}

interface HostAndFields { host: string; fields?: string }
function splitHost(line: string): HostAndFields | null {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(line)) return null
  if (line.startsWith('[')) {
    const bracket = line.indexOf(']')
    if (bracket === -1) return null
    const host = line.slice(1, bracket)
    const suffix = line.slice(bracket + 1)
    if (!isIPv6(host) || (suffix && !suffix.startsWith(':'))) return null
    return { host, ...(suffix ? { fields: suffix.slice(1) } : {}) }
  }
  const colon = line.indexOf(':')
  const host = colon === -1 ? line : line.slice(0, colon)
  if (!validHostname(host)) return null
  return { host, ...(colon !== -1 ? { fields: line.slice(colon + 1) } : {}) }
}

/**
 * Parses only data, with no Node or filesystem dependency, so the renderer and
 * main process use identical validation. Lines have no per-host port syntax:
 * the request port applies to every entry.
 *
 * Password mode accepts host:password (root) or host:username:password. A colon
 * in a password requires the explicit username form. Key mode accepts host,
 * host:username, and the three-field form while discarding its password.
 * IPv6 addresses must be bracketed in input; returned hosts omit the brackets.
 */
export function parseBulkHosts(value: unknown): ImportPreview {
  const request = validateRequest(value)
  const entries: ImportEntry[] = []
  const errors: ImportPreview['errors'] = []
  const seen = new Set<string>()
  let totalLines = 0
  let duplicates = 0
  let entryLimitReported = false
  let errorLimitReported = false
  const error = (line: number, message: string) => {
    if (errors.length < MAX_PREVIEW_ERRORS) errors.push({ line, message })
    else if (!errorLimitReported) {
      errorLimitReported = true
      errors.push({ line, message: 'Additional invalid lines were omitted from this preview. Split the list into smaller batches.' })
    }
  }

  const lines = request.text.split(/\r\n|\n|\r/)
  for (let index = 0; index < lines.length; index++) {
    // A UTF-8 text file may begin with a BOM. Password whitespace is otherwise
    // preserved exactly; trim is used only to identify blanks and comments.
    const source = index === 0 ? lines[index].replace(/^\uFEFF/, '') : lines[index]
    const trimmed = source.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    totalLines++
    const line = index + 1
    const parsed = splitHost(source)
    if (!parsed) {
      error(line, 'Use a valid DNS hostname, IPv4 address, or bracketed IPv6 address without URLs, paths, or whitespace.')
      continue
    }

    let username = 'root'
    let password: string | undefined
    if (parsed.fields === undefined) {
      if (request.authType === 'password') {
        error(line, 'Use host:password or host:username:password.')
        continue
      }
    } else {
      const colon = parsed.fields.indexOf(':')
      if (request.authType === 'privateKey') username = colon === -1 ? parsed.fields : parsed.fields.slice(0, colon)
      else if (colon === -1) password = parsed.fields
      else {
        username = parsed.fields.slice(0, colon)
        password = parsed.fields.slice(colon + 1)
      }
    }
    if (!validUsername(username)) {
      error(line, 'Provide a nonempty username without whitespace, slashes, or control characters.')
      continue
    }
    if (request.authType === 'password' && (!password || password.length > 8192 || password.includes('\0'))) {
      error(line, 'Provide a nonempty password of at most 8192 characters without NUL characters.')
      continue
    }
    const key = JSON.stringify([parsed.host.toLowerCase(), request.port, username])
    if (seen.has(key)) { duplicates++; continue }
    seen.add(key)
    if (entries.length >= MAX_IMPORT_ENTRIES) {
      if (!entryLimitReported) {
        entryLimitReported = true
        error(line, 'Import up to 200 unique hosts at a time. Split the list into smaller batches.')
      }
      continue
    }
    entries.push({ line, host: parsed.host, username, ...(password !== undefined ? { password } : {}) })
  }
  return { entries, errors, totalLines, duplicates }
}
