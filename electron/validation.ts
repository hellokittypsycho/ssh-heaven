import path from 'node:path'

export function record(value: unknown, label = 'request'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}.`)
  }
  return value as Record<string, unknown>
}

export function textValue(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\0')) {
    throw new Error(`Invalid ${label}.`)
  }
  return value
}

export function identifier(value: unknown, label = 'identifier'): string {
  const result = textValue(value, label, 128)
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error(`Invalid ${label}.`)
  return result
}

export function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid ${label}.`)
  }
  return value
}

export function optionalText(value: unknown, label: string, maximum = 4096): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return textValue(value, label, maximum)
}

export function remotePath(value: unknown): string {
  return textValue(value, 'remote path', 32768)
}

export function remoteFilename(value: unknown): string {
  const name = textValue(value, 'filename', 255)
  if (name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error('A filename cannot contain path separators.')
  return name
}

/** A remote directory listing must never select a path outside a local download folder. */
export function localDownloadName(value: unknown): string {
  const name = remoteFilename(value)
  if (/[<>:"|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error('This remote filename is not supported on Windows. Rename it before downloading.')
  }
  return name
}

export function childLocalPath(directory: string, filename: string): string {
  const root = path.resolve(directory)
  const destination = path.resolve(root, localDownloadName(filename))
  if (path.dirname(destination) !== root) throw new Error('Invalid download destination.')
  return destination
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
