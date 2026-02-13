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
