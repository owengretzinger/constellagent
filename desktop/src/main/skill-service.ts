import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import type { Skill, SkillMetadata, UpdateSkillInput } from '../shared/skill-types'

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

interface ParsedFrontmatter {
  name?: string
  description?: string
  license?: string
  compatibility?: string
  metadata: SkillMetadata
}

function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function formatYamlValue(value: string): string {
  if (/^[a-zA-Z0-9 ._:/-]+$/.test(value) && value.trim() === value && value.length > 0) {
    return value
  }
  return JSON.stringify(value)
}

function parseFrontmatter(frontmatter: string): ParsedFrontmatter {
  const parsed: ParsedFrontmatter = { metadata: {} }
  const lines = frontmatter.split('\n')

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue

    if (line.trim() === 'metadata:') {
      i += 1
      while (i < lines.length) {
        const metadataLine = lines[i]
        const match = metadataLine.match(/^\s{2}([^:]+):\s*(.*)$/)
        if (!match) {
          i -= 1
          break
        }
        parsed.metadata[match[1].trim()] = stripQuotes(match[2])
        i += 1
      }
      continue
    }

    const match = line.match(/^([^:]+):\s*(.*)$/)
    if (!match) continue

    const key = match[1].trim()
    const value = stripQuotes(match[2])
    if (key === 'name') parsed.name = value
    else if (key === 'description') parsed.description = value
    else if (key === 'license') parsed.license = value
    else if (key === 'compatibility') parsed.compatibility = value
  }

  return parsed
}

function splitSkillFile(fileContents: string): { frontmatter: ParsedFrontmatter; body: string } {
  const match = fileContents.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) {
    return { frontmatter: { metadata: {} }, body: fileContents.trim() }
  }

  return {
    frontmatter: parseFrontmatter(match[1]),
    body: match[2].trim(),
  }
}

function serializeSkill(skill: Skill): string {
  const metadataLines = Object.entries(skill.metadata)
    .flatMap(([key, value]) => (
      typeof value === 'string' && value.length > 0
        ? [`  ${key}: ${formatYamlValue(value)}`]
        : []
    ))

  const frontmatter = [
    '---',
    `name: ${formatYamlValue(skill.name)}`,
    `description: ${formatYamlValue(skill.description)}`,
    `license: ${formatYamlValue(skill.license)}`,
    `compatibility: ${formatYamlValue(skill.compatibility)}`,
    'metadata:',
    ...metadataLines,
    '---',
    '',
  ]

  const body = skill.content.trim()
  return `${frontmatter.join('\n')}${body}${body ? '\n' : ''}`
}

export class SkillService {
  private static skillsRoot(): string {
    return process.env.CONSTELLAGENT_SKILLS_DIR
      ? resolve(process.env.CONSTELLAGENT_SKILLS_DIR)
      : resolve(__dirname, '..', '..', '.claude', 'skills')
  }

  private static skillDir(name: string): string {
    return join(this.skillsRoot(), name)
  }

  private static skillFile(name: string): string {
    return join(this.skillDir(name), 'SKILL.md')
  }

  private static assertValidName(name: string): void {
    if (!SKILL_NAME_RE.test(name)) {
      throw new Error('Skill name must be kebab-case (lowercase letters, numbers, and dashes).')
    }
  }

  private static async exists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath)
      return true
    } catch {
      return false
    }
  }

  private static async readSkill(name: string): Promise<Skill> {
    const contents = await readFile(this.skillFile(name), 'utf-8')
    const { frontmatter, body } = splitSkillFile(contents)

    return {
      name: frontmatter.name || name,
      description: frontmatter.description || '',
      license: frontmatter.license || 'MIT',
      compatibility: frontmatter.compatibility || '',
      metadata: {
        author: frontmatter.metadata.author || 'constellagent',
        version: frontmatter.metadata.version || '1.0',
        ...frontmatter.metadata,
      },
      content: body,
    }
  }

  static async list(): Promise<Skill[]> {
    const root = this.skillsRoot()
    if (!(await this.exists(root))) return []

    const entries = await readdir(root, { withFileTypes: true })
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const skillPath = this.skillFile(entry.name)
          if (!(await this.exists(skillPath))) return null
          return this.readSkill(entry.name)
        })
    )

    return skills
      .filter((skill): skill is Skill => skill !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  static async create(skill: Skill): Promise<Skill> {
    this.assertValidName(skill.name)
    const dirPath = this.skillDir(skill.name)
    if (await this.exists(dirPath)) {
      throw new Error(`Skill "${skill.name}" already exists.`)
    }

    await mkdir(dirPath, { recursive: true })
    await writeFile(this.skillFile(skill.name), serializeSkill(skill), 'utf-8')
    return this.readSkill(skill.name)
  }

  static async update(skill: UpdateSkillInput): Promise<Skill> {
    this.assertValidName(skill.previousName)
    this.assertValidName(skill.name)

    const previousDir = this.skillDir(skill.previousName)
    if (!(await this.exists(previousDir))) {
      throw new Error(`Skill "${skill.previousName}" does not exist.`)
    }

    if (skill.previousName !== skill.name) {
      const nextDir = this.skillDir(skill.name)
      if (await this.exists(nextDir)) {
        throw new Error(`Skill "${skill.name}" already exists.`)
      }
      await rename(previousDir, nextDir)
    }

    await writeFile(this.skillFile(skill.name), serializeSkill(skill), 'utf-8')
    return this.readSkill(skill.name)
  }

  static async delete(name: string): Promise<void> {
    this.assertValidName(name)
    const dirPath = this.skillDir(name)
    if (!(await this.exists(dirPath))) {
      throw new Error(`Skill "${name}" does not exist.`)
    }
    await rm(dirPath, { recursive: true, force: true })
  }
}
