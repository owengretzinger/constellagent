export type AgentTurnEventType = 'turn_started' | 'awaiting_user'

export type AgentTurnOutcome = 'success' | 'failed'

// Accepted on the wire for backward compatibility. Older adapters may still
// emit turn_completed/turn_failed, which are normalized to awaiting_user.
export type AgentTurnEventWireType = AgentTurnEventType | 'turn_completed' | 'turn_failed'

export interface AgentTurnEvent {
  schema: 1
  workspaceId: string
  agent: string
  type: AgentTurnEventType
  outcome?: AgentTurnOutcome
  sessionId?: string
  at?: number
}

export interface AgentTurnEventWire {
  schema: 1
  workspaceId: string
  agent: string
  type: AgentTurnEventWireType
  outcome?: AgentTurnOutcome
  sessionId?: string
  at?: number
}
