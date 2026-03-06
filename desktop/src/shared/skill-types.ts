export interface Skill {
  id: string
  name: string
  description: string
  instruction: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

export interface CreateSkillInput {
  name: string
  description?: string
  instruction: string
  enabled?: boolean
}

export interface UpdateSkillInput {
  name?: string
  description?: string
  instruction?: string
  enabled?: boolean
}
