import { mkdirSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentTurnEvent, AgentTurnEventType } from '../shared/agent-events'

const DEFAULT_AGENT_EVENT_DIR = '/tmp/constellagent-agent-events'

interface EmitAgentTurnEventInput {
  workspaceId: string
  agent: string
  type: AgentTurnEventType
  sessionId?: string
  at?: number
}

export function getAgentEventDir(): string {
  return process.env.CONSTELLAGENT_AGENT_EVENT_DIR || DEFAULT_AGENT_EVENT_DIR
}

export function emitAgentTurnEvent(input: EmitAgentTurnEventInput): void {
  const workspaceId = input.workspaceId.trim()
  const agent = input.agent.trim()
  if (!workspaceId || !agent) return

  const event: AgentTurnEvent = {
    schema: 1,
    workspaceId,
    agent,
    type: input.type,
    sessionId: input.sessionId,
    at: input.at ?? Date.now(),
  }

  try {
    const dir = getAgentEventDir()
    mkdirSync(dir, { recursive: true })
    const baseName = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`
    const target = join(dir, `${baseName}.json`)
    const tmpTarget = `${target}.tmp`
    writeFileSync(tmpTarget, JSON.stringify(event), 'utf-8')
    renameSync(tmpTarget, target)
  } catch {
    // Best-effort write.
  }
}

export const AGENT_EVENT_DEFAULT_DIR = DEFAULT_AGENT_EVENT_DIR
