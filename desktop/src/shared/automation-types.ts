export interface AutomationConfig {
  id: string
  name: string
  projectId: string
  prompt: string
  cronExpression: string
  enabled: boolean
  repoPath: string
}

export interface AutomationRunStartedEvent {
  automationId: string
  automationName: string
  projectId: string
  ptyId: string
  worktreePath: string
  branch: string
}
