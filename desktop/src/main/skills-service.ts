import { readFile, symlink, unlink, mkdir, lstat } from 'fs/promises'
import { join, basename } from 'path'

interface SkillInfo {
  name: string
  description: string
}

interface SubagentInfo {
  name: string
  description: string
  tools?: string
}

const AGENT_SKILL_DIRS = ['.claude/skills', '.cursor/skills', '.codex/skills', '.gemini/skills']
const AGENT_SUBAGENT_DIRS = ['.claude/agents', '.cursor/agents', '.codex/agents', '.gemini/agents']

function parseYamlFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}
  const result: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    const val = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '')
    if (key && val) result[key] = val
  }
  return result
}

export class SkillsService {
  static async scanSkillDir(skillPath: string): Promise<SkillInfo | null> {
    const skillMdPath = join(skillPath, 'SKILL.md')
    try {
      const content = await readFile(skillMdPath, 'utf-8')
      const frontmatter = parseYamlFrontmatter(content)
      return {
        name: frontmatter.name || basename(skillPath),
        description: frontmatter.description || '',
      }
    } catch {
      return null
    }
  }

  static async syncSkillToAgents(skillPath: string, projectPath: string): Promise<void> {
    const skillName = basename(skillPath)
    for (const dir of AGENT_SKILL_DIRS) {
      const targetDir = join(projectPath, dir)
      await mkdir(targetDir, { recursive: true })
      const linkPath = join(targetDir, skillName)
      await safeSymlink(skillPath, linkPath)
    }
  }

  static async removeSkillFromAgents(skillName: string, projectPath: string): Promise<void> {
    for (const dir of AGENT_SKILL_DIRS) {
      const linkPath = join(projectPath, dir, skillName)
      await safeUnlink(linkPath)
    }
  }

  static async scanSubagentFile(filePath: string): Promise<SubagentInfo | null> {
    try {
      const content = await readFile(filePath, 'utf-8')
      const frontmatter = parseYamlFrontmatter(content)
      return {
        name: frontmatter.name || basename(filePath, '.md'),
        description: frontmatter.description || '',
        tools: frontmatter.tools || undefined,
      }
    } catch {
      return null
    }
  }

  static async syncSubagentToAgents(subagentPath: string, projectPath: string): Promise<void> {
    const fileName = basename(subagentPath)
    for (const dir of AGENT_SUBAGENT_DIRS) {
      const targetDir = join(projectPath, dir)
      await mkdir(targetDir, { recursive: true })
      const linkPath = join(targetDir, fileName)
      await safeSymlink(subagentPath, linkPath)
    }
  }

  static async removeSubagentFromAgents(subagentName: string, projectPath: string): Promise<void> {
    // subagentName should include .md extension
    const fileName = subagentName.endsWith('.md') ? subagentName : `${subagentName}.md`
    for (const dir of AGENT_SUBAGENT_DIRS) {
      const linkPath = join(projectPath, dir, fileName)
      await safeUnlink(linkPath)
    }
  }
}

async function safeSymlink(target: string, linkPath: string): Promise<void> {
  try {
    // Remove existing symlink if present
    const stat = await lstat(linkPath).catch(() => null)
    if (stat) await unlink(linkPath)
    await symlink(target, linkPath)
  } catch {
    // Ignore errors (e.g. permission issues)
  }
}

async function safeUnlink(linkPath: string): Promise<void> {
  try {
    const stat = await lstat(linkPath).catch(() => null)
    if (stat?.isSymbolicLink()) await unlink(linkPath)
  } catch {
    // Ignore
  }
}
