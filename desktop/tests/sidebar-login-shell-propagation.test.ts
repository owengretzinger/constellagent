import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'

describe('Sidebar PTY creation', () => {
  test('passes useLoginShell to every pty.create call', () => {
    const source = readFileSync('src/renderer/components/Sidebar/Sidebar.tsx', 'utf-8')
    const callPattern = /window\.api\.pty\.create\(/g
    const callIndexes = Array.from(source.matchAll(callPattern)).map((match) => match.index ?? -1)

    expect(callIndexes.length).toBeGreaterThan(0)

    for (const index of callIndexes) {
      const snippet = source.slice(index, index + 240)
      expect(snippet.includes('useLoginShell')).toBe(true)
    }
  })
})
