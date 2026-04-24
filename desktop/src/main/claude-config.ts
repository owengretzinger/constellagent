import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'

// ── Paths ──

export const CLAUDE_CONFIG_PATH = join(homedir(), '.claude.json')
export const CLAUDE_DIR = join(homedir(), '.claude')
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json')

// ── Generic JSON helpers ──

export async function loadJsonFile<T = Record<string, unknown>>(
  filePath: string,
  fallback: T,
): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function saveJsonFile(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

// ── Claude-specific helpers ──

export async function trustPathForClaude(dirPath: string): Promise<void> {
  const config = await loadJsonFile<Record<string, unknown>>(CLAUDE_CONFIG_PATH, {})
  const projects = (config.projects ?? {}) as Record<string, unknown>
  if (!(dirPath in projects)) {
    projects[dirPath] = { hasTrustDialogAccepted: true }
  } else {
    const entry = projects[dirPath] as Record<string, unknown>
    entry.hasTrustDialogAccepted = true
  }
  config.projects = projects
  await saveJsonFile(CLAUDE_CONFIG_PATH, config)
}

export async function prepareClaudeForAutomation(dirPath: string): Promise<void> {
  const config = await loadJsonFile<Record<string, unknown>>(CLAUDE_CONFIG_PATH, {})
  const projects = (config.projects ?? {}) as Record<string, unknown>

  if (!(dirPath in projects)) {
    projects[dirPath] = { hasTrustDialogAccepted: true }
  } else {
    const entry = projects[dirPath] as Record<string, unknown>
    entry.hasTrustDialogAccepted = true
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (apiKey && typeof config.primaryApiKey !== 'string') {
    config.primaryApiKey = apiKey
  }
  if (apiKey) {
    config.hasCompletedOnboarding = true
  }

  config.projects = projects
  await saveJsonFile(CLAUDE_CONFIG_PATH, config)
}

export async function loadClaudeSettings(): Promise<Record<string, unknown>> {
  return loadJsonFile<Record<string, unknown>>(CLAUDE_SETTINGS_PATH, {})
}

export async function saveClaudeSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(CLAUDE_DIR, { recursive: true })
  await saveJsonFile(CLAUDE_SETTINGS_PATH, settings)
}
