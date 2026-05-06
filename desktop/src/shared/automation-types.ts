export const AUTOMATION_HARNESSES = ['claude', 'codex', 'pi'] as const

export type AutomationHarness = (typeof AUTOMATION_HARNESSES)[number]

export const DEFAULT_AUTOMATION_HARNESS: AutomationHarness = 'claude'

const AUTOMATION_HARNESS_LABELS: Record<AutomationHarness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  pi: 'Pi',
}

export function normalizeAutomationHarness(value: unknown): AutomationHarness {
  return AUTOMATION_HARNESSES.includes(value as AutomationHarness)
    ? (value as AutomationHarness)
    : DEFAULT_AUTOMATION_HARNESS
}

export function getAutomationHarnessLabel(harness: AutomationHarness): string {
  return AUTOMATION_HARNESS_LABELS[harness]
}

export interface AutomationConfig {
  id: string
  name: string
  projectId: string
  prompt: string
  cronExpression: string
  enabled: boolean
  harness: AutomationHarness
  repoPath: string
}

export interface AutomationRunStartedEvent {
  automationId: string
  automationName: string
  projectId: string
  workspaceId: string
  ptyId: string
  worktreePath: string
  branch: string
}
