export interface ParsedSshPath {
  host: string
  remotePath: string
}

const SSH_HOST_UNSAFE_RE = /[\s\x00-\x1f\x7f]/

function isValidSshHost(host: string): boolean {
  if (!host) return false
  if (host.startsWith('-')) return false
  return !SSH_HOST_UNSAFE_RE.test(host)
}

export function parseSshPath(value: string): ParsedSshPath | null {
  const trimmed = value.trim()
  const match = trimmed.match(/^ssh:\/\/([^/]+)(\/.*)$/)
  if (!match) return null

  const host = match[1]?.trim()
  if (!host || !isValidSshHost(host)) return null

  let remotePath = match[2] ?? ''
  if (!remotePath.startsWith('/')) return null

  try {
    remotePath = decodeURIComponent(remotePath)
  } catch {
    // Keep raw path when the string is not URL-encoded.
  }

  return { host, remotePath }
}

export function isSshPath(value: string): boolean {
  return parseSshPath(value) !== null
}

export function formatSshPath(host: string, remotePath: string): string {
  const normalizedHost = host.trim()
  if (!normalizedHost) throw new Error('SSH host is required')
  if (!isValidSshHost(normalizedHost)) throw new Error('Invalid SSH host')

  const path = remotePath.trim()
  if (!path) throw new Error('Remote path is required')

  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return `ssh://${normalizedHost}${normalizedPath}`
}
