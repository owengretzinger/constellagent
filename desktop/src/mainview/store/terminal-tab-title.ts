const MAX_TITLE_LENGTH = 48

function truncateTitle(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'Terminal'
  return trimmed.length > MAX_TITLE_LENGTH ? `${trimmed.slice(0, MAX_TITLE_LENGTH - 3)}...` : trimmed
}

function basename(pathValue: string): string {
  const trimmed = pathValue.replace(/['"]/g, '').trim()
  const segments = trimmed.split('/')
  return segments[segments.length - 1] || trimmed
}

export function titleFromTerminalCommand(rawCommand: string): string {
  let command = rawCommand.trim()
  if (!command) return 'Terminal'

  // Strip leading shell env assignments and wrappers.
  command = command
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*/g, '')
    .replace(/^(?:sudo|command|exec)\s+/g, '')
    .trim()
  if (!command) return 'Terminal'

  const tokens = command.split(/\s+/)
  const [tool, arg1, arg2] = tokens

  if (tool === 'git' && arg1) return truncateTitle(`git ${arg1}`)
  if ((tool === 'npm' || tool === 'pnpm' || tool === 'bun') && arg1 === 'run' && arg2) {
    return truncateTitle(`${tool}:${arg2}`)
  }
  if (tool === 'yarn' && arg1) return truncateTitle(`yarn:${arg1}`)
  if ((tool === 'python' || tool === 'python3' || tool === 'node' || tool === 'deno') && arg1) {
    return truncateTitle(`${tool} ${basename(arg1)}`)
  }

  return truncateTitle(tokens.slice(0, 3).join(' '))
}
