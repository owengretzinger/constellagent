import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readFile, writeFile } from 'fs/promises'

export const CODEX_DIR = join(homedir(), '.codex')
export const CODEX_CONFIG_PATH = join(CODEX_DIR, 'config.toml')

export async function loadCodexConfigText(): Promise<string> {
  try {
    return await readFile(CODEX_CONFIG_PATH, 'utf-8')
  } catch {
    return ''
  }
}

export async function saveCodexConfigText(contents: string): Promise<void> {
  await mkdir(CODEX_DIR, { recursive: true })
  await writeFile(CODEX_CONFIG_PATH, contents, 'utf-8')
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export async function ensureCodexProjectTrusted(projectPath: string): Promise<void> {
  const header = `[projects."${tomlEscape(projectPath)}"]`
  const trustLine = 'trust_level = "trusted"'
  const config = await loadCodexConfigText()

  if (!config.trim()) {
    await saveCodexConfigText(`${header}\n${trustLine}\n`)
    return
  }

  const lines = config.split('\n')
  const headerIndex = lines.findIndex((line) => line.trim() === header)

  if (headerIndex === -1) {
    const nextConfig = `${config.trimEnd()}\n\n${header}\n${trustLine}\n`
    await saveCodexConfigText(nextConfig)
    return
  }

  let sectionEnd = lines.length
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    if (/^\s*\[.*\]\s*$/.test(lines[i])) {
      sectionEnd = i
      break
    }
  }

  const trustIndex = lines.slice(headerIndex + 1, sectionEnd).findIndex((line) =>
    /^\s*trust_level\s*=/.test(line)
  )

  if (trustIndex >= 0) {
    lines[headerIndex + 1 + trustIndex] = trustLine
  } else {
    lines.splice(headerIndex + 1, 0, trustLine)
  }

  await saveCodexConfigText(`${lines.join('\n').trimEnd()}\n`)
}
