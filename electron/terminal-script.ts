import { randomBytes } from 'node:crypto'

const START = '\x1b]777;ssh-heaven;'
const END = 7
function octal(value: Buffer): string { return Array.from(value, (byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('') }
function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'` }

export function terminalScript(command: string): { payload: string; parser: ScriptCompletionParser } {
  const nonce = randomBytes(24).toString('hex')
  // Even the nonce is octal encoded in the echoed command. Only the actual
  // printf output contains the private control frame that marks completion.
  const finish = `r=$?; printf '\\033]777;ssh-heaven;${octal(Buffer.from(nonce))};%s\\007' "$r"`
  const invocation = `s=$(printf '${octal(Buffer.from(command, 'utf8'))}'; printf .); trap ${quote(finish)} 0; trap 'exit 130' 2; trap 'exit 143' 15; sh -c "\${s%.}"; exit $?`
  return { payload: `sh -c ${quote(invocation)}\r`, parser: new ScriptCompletionParser(nonce) }
}

/** Recognize only this run's unpredictable OSC frame, never prompts or text
 * claiming success. State is bounded by the frame prefix plus three digits. */
export class ScriptCompletionParser {
  private readonly prefix: Buffer
  private pending = Buffer.alloc(0)
  private completed = false
  constructor(nonce: string) {
    if (!/^[a-f0-9]{48}$/.test(nonce)) throw new Error('Invalid script completion nonce.')
    this.prefix = Buffer.from(`${START}${nonce};`)
  }
  consume(chunk: Buffer): { data: Buffer; exitCode?: number } {
    const input = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)
    const output: Buffer[] = []
    let offset = 0, exitCode: number | undefined
    while (offset < input.length) {
      const marker = input.indexOf(this.prefix, offset)
      if (marker < 0) {
        let tail = Math.min(this.prefix.length - 1, input.length - offset)
        while (tail && !input.subarray(input.length - tail).equals(this.prefix.subarray(0, tail))) tail--
        if (input.length - tail > offset) output.push(input.subarray(offset, input.length - tail))
        if (tail) this.pending = Buffer.from(input.subarray(input.length - tail))
        break
      }
      if (marker > offset) output.push(input.subarray(offset, marker))
      const after = marker + this.prefix.length
      const end = input.indexOf(END, after)
      if (end < 0 && input.length - after <= 3) { this.pending = Buffer.from(input.subarray(marker)); break }
      const code = end >= 0 ? input.subarray(after, end).toString('ascii') : ''
      if (/^\d{1,3}$/.test(code) && Number(code) <= 255) {
        if (!this.completed) { this.completed = true; exitCode = Number(code) }
        offset = end + 1
      } else {
        // Invalid/overlong control sequences remain ordinary terminal bytes.
        // Advance one byte so a later real completion is still recognized.
        output.push(input.subarray(marker, marker + 1)); offset = marker + 1
      }
    }
    return { data: output.length === 1 ? output[0] : Buffer.concat(output), ...(exitCode === undefined ? {} : { exitCode }) }
  }
}
