export type AgentTurnEventType = 'turn_started' | 'awaiting_user'

export type AgentTurnOutcome = 'success' | 'failed'

export interface AgentTurnEvent {
  schema: 1
  workspaceId: string
  agent: string
  type: AgentTurnEventType
  outcome?: AgentTurnOutcome
  sessionId?: string
  at?: number
}
