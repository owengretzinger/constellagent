export interface ParsedPrUrl {
  owner: string
  repo: string
  number: number
}

/** Parse a full GitHub or Graphite PR URL */
export function parsePrUrl(url: string): ParsedPrUrl | null {
  const trimmed = url.trim()

  // GitHub: https://github.com/{owner}/{repo}/pull/{number}
  const ghMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/
  )
  if (ghMatch) {
    return {
      owner: ghMatch[1],
      repo: ghMatch[2],
      number: parseInt(ghMatch[3], 10),
    }
  }

  // Graphite: https://app.graphite.dev/github/pr/{owner}/{repo}/{number}
  // Also matches app.graphite.com (Graphite uses both domains)
  const grMatch = trimmed.match(
    /^https?:\/\/app\.graphite\.(?:dev|com)\/github\/pr\/([^/]+)\/([^/]+)\/(\d+)/
  )
  if (grMatch) {
    return {
      owner: grMatch[1],
      repo: grMatch[2],
      number: parseInt(grMatch[3], 10),
    }
  }

  return null
}

/** Parse "#123" shorthand -- returns just the PR number, or null */
export function parsePrNumber(input: string): number | null {
  const match = input.trim().match(/^#(\d+)$/)
  return match ? parseInt(match[1], 10) : null
}
