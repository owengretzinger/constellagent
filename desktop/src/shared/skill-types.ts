export interface SkillMetadata {
  author?: string
  version?: string
  generatedBy?: string
  [key: string]: string | undefined
}

export interface Skill {
  name: string
  description: string
  license: string
  compatibility: string
  metadata: SkillMetadata
  content: string
}

export interface UpdateSkillInput extends Skill {
  previousName: string
}
