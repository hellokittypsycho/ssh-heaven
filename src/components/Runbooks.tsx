const variablePattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

export function runbookVariables(command: string): string[] {
  const names = [...command.matchAll(variablePattern)].map((match) => match[1])
  if (/\{\{|\}\}/.test(command.replace(variablePattern, ''))) throw new Error('Use variable names such as {{service}} with letters, numbers, and underscores.')
  return [...new Set(names)]
}

/** Values are POSIX shell arguments. Templates must leave variables unquoted. */
export function renderRunbook(command: string, values: Record<string, string>): string {
  const variables = runbookVariables(command)
  if (!variables.length) return command
  if (command.includes('<<')) throw new Error('Runbook variables cannot be used with shell heredocs. Use ordinary command arguments.')
  let quote: string | null = null
  let result = ''
  for (let index = 0; index < command.length;) {
    const match = command.slice(index).match(/^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/)
    if (match) {
      if (quote) throw new Error('Place variables outside shell quotes; their values are quoted automatically.')
      const value = values[match[1]]
      if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new Error(`Enter a value for ${match[1]} (up to 8192 characters).`)
      result += `'${value.replace(/'/g, `'"'"'`)}'`
      index += match[0].length
      continue
    }
    const character = command[index++]
    result += character
    if (character === '\\' && quote !== "'" && index < command.length) { result += command[index++]; continue }
    if (character === "'" || character === '"' || character === '`') {
      if (!quote) quote = character
      else if (quote === character) quote = null
    }
  }
  if (/\{\{|\}\}/.test(result)) throw new Error('Variables must be unescaped command arguments.')
  if (result.length > 32768) throw new Error('The expanded command exceeds 32768 characters.')
  return result
}
