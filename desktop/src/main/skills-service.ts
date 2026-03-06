import { mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { CreateSkillInput, Skill, UpdateSkillInput } from '../shared/skill-types'
import { loadJsonFile, saveJsonFile } from './claude-config'

interface SkillFileShape {
  skills?: Skill[]
}

function sanitizeText(value: string | undefined): string {
  return (value ?? '').trim()
}

function normalizeSkill(raw: unknown): Skill | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  if (
    typeof row.id !== 'string' ||
    typeof row.name !== 'string' ||
    typeof row.description !== 'string' ||
    typeof row.instruction !== 'string' ||
    typeof row.enabled !== 'boolean' ||
    typeof row.createdAt !== 'number' ||
    typeof row.updatedAt !== 'number'
  ) {
    return null
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instruction: row.instruction,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export class SkillsService {
  constructor(private readonly filePath: string) {}

  private async readAll(): Promise<Skill[]> {
    const loaded = await loadJsonFile<SkillFileShape>(this.filePath, { skills: [] })
    const rows = Array.isArray(loaded.skills) ? loaded.skills : []
    return rows
      .map(normalizeSkill)
      .filter((skill): skill is Skill => !!skill)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  private async writeAll(skills: Skill[]): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await saveJsonFile(this.filePath, { skills })
  }

  async list(): Promise<Skill[]> {
    return this.readAll()
  }

  async create(input: CreateSkillInput): Promise<Skill> {
    const name = sanitizeText(input.name)
    const instruction = sanitizeText(input.instruction)
    const description = sanitizeText(input.description)
    if (!name) throw new Error('Skill name is required')
    if (!instruction) throw new Error('Skill instruction is required')

    const now = Date.now()
    const skill: Skill = {
      id: crypto.randomUUID(),
      name,
      description,
      instruction,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    }

    const skills = await this.readAll()
    skills.unshift(skill)
    await this.writeAll(skills)
    return skill
  }

  async update(id: string, input: UpdateSkillInput): Promise<Skill> {
    const skillId = sanitizeText(id)
    if (!skillId) throw new Error('Skill id is required')
    const skills = await this.readAll()
    const index = skills.findIndex((skill) => skill.id === skillId)
    if (index < 0) throw new Error('Skill not found')

    const current = skills[index]
    const next: Skill = {
      ...current,
      name: input.name !== undefined ? sanitizeText(input.name) : current.name,
      description: input.description !== undefined ? sanitizeText(input.description) : current.description,
      instruction: input.instruction !== undefined ? sanitizeText(input.instruction) : current.instruction,
      enabled: input.enabled ?? current.enabled,
      updatedAt: Date.now(),
    }

    if (!next.name) throw new Error('Skill name is required')
    if (!next.instruction) throw new Error('Skill instruction is required')

    skills[index] = next
    await this.writeAll(skills.sort((a, b) => b.updatedAt - a.updatedAt))
    return next
  }

  async delete(id: string): Promise<void> {
    const skillId = sanitizeText(id)
    if (!skillId) throw new Error('Skill id is required')
    const skills = await this.readAll()
    const next = skills.filter((skill) => skill.id !== skillId)
    if (next.length === skills.length) throw new Error('Skill not found')
    await this.writeAll(next)
  }
}
