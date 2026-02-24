export type AgentTurnEventType =
  | 'turn_started'
  | 'awaiting_user'
  | 'turn_completed'
  | 'turn_failed'

export interface AgentTurnEvent {
  schema: 1
  workspaceId: string
  agent: string
  type: AgentTurnEventType
  sessionId?: string
  at?: number
}
