import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AgentTurnEvent, AgentTurnEventType, AgentTurnOutcome } from '../shared/agent-events'
import { AGENT_EVENT_DEFAULT_DIR } from './agent-events'

const POLL_INTERVAL = 500
const FILE_SETTLE_MS = 100

const TURN_EVENT_TYPES: AgentTurnEventType[] = ['turn_started', 'awaiting_user']
const TURN_OUTCOMES: AgentTurnOutcome[] = ['success', 'failed']

function isTurnEventType(value: string): value is AgentTurnEventType {
  return TURN_EVENT_TYPES.includes(value as AgentTurnEventType)
}

function isTurnOutcome(value: string): value is AgentTurnOutcome {
  return TURN_OUTCOMES.includes(value as AgentTurnOutcome)
}

export class NotificationWatcher {
  constructor(
    private readonly eventDir = process.env.CONSTELLAGENT_AGENT_EVENT_DIR || AGENT_EVENT_DEFAULT_DIR,
  ) {}

  private timer: ReturnType<typeof setInterval> | null = null
  private activeEventSessions = new Map<string, Set<string>>()
  private lastPublishedActiveIds = new Set<string>()

  start(): void {
    mkdirSync(this.eventDir, { recursive: true })
    this.pollOnce()
    this.timer = setInterval(() => this.pollOnce(), POLL_INTERVAL)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private pollOnce(): void {
    this.pollAgentEvents()
    this.publishActivity()
  }

  private pollAgentEvents(): void {
    try {
      const files = readdirSync(this.eventDir)
      const now = Date.now()
      for (const f of files) {
        if (f.endsWith('.tmp')) continue
        const filePath = join(this.eventDir, f)
        try {
          const stat = statSync(filePath)
          if (now - stat.mtimeMs < FILE_SETTLE_MS) continue
        } catch {
          continue
        }
        this.processAgentEventFile(filePath)
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private processAgentEventFile(filePath: string): void {
    try {
      const raw = readFileSync(filePath, 'utf-8').trim()
      if (!raw) {
        unlinkSync(filePath)
        return
      }

      const parsed = JSON.parse(raw) as Partial<AgentTurnEvent>
      const event = this.normalizeEvent(parsed)
      if (event) {
        this.applyEvent(event)
      }
      unlinkSync(filePath)
    } catch {
      try {
        unlinkSync(filePath)
      } catch {
        // Ignore unlink failures.
      }
    }
  }

  private normalizeEvent(parsed: Partial<AgentTurnEvent>): AgentTurnEvent | null {
    const workspaceId = typeof parsed.workspaceId === 'string' ? parsed.workspaceId.trim() : ''
    if (!workspaceId) return null

    const type = typeof parsed.type === 'string' ? parsed.type.trim() : ''
    if (!isTurnEventType(type)) return null

    const agent = typeof parsed.agent === 'string' && parsed.agent.trim()
      ? parsed.agent.trim()
      : 'unknown'

    const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
      ? parsed.sessionId.trim()
      : undefined

    const outcome = typeof parsed.outcome === 'string' && isTurnOutcome(parsed.outcome)
      ? parsed.outcome
      : undefined

    return {
      schema: 1,
      workspaceId,
      type,
      outcome: type === 'awaiting_user' ? outcome : undefined,
      agent,
      sessionId,
      at: typeof parsed.at === 'number' ? parsed.at : Date.now(),
    }
  }

  private applyEvent(event: AgentTurnEvent): void {
    const { workspaceId, agent, type, sessionId } = event

    if (type === 'turn_started') {
      this.addActiveSession(workspaceId, this.sessionKey(agent, sessionId))
      return
    }

    this.removeActiveSession(workspaceId, agent, sessionId)
    this.notifyRenderer(workspaceId)
  }

  private addActiveSession(workspaceId: string, key: string): void {
    const sessions = this.activeEventSessions.get(workspaceId)
    if (sessions) {
      sessions.add(key)
      return
    }

    this.activeEventSessions.set(workspaceId, new Set([key]))
  }

  private removeActiveSession(workspaceId: string, agent: string, sessionId?: string): void {
    const sessions = this.activeEventSessions.get(workspaceId)
    if (!sessions) return

    if (sessionId) {
      sessions.delete(this.sessionKey(agent, sessionId))
      sessions.delete(this.sessionKey(agent))
    } else {
      const prefix = `${agent}:`
      for (const key of sessions) {
        if (key.startsWith(prefix)) sessions.delete(key)
      }
    }

    if (sessions.size === 0) {
      this.activeEventSessions.delete(workspaceId)
    }
  }

  private sessionKey(agent: string, sessionId?: string): string {
    return `${agent}:${sessionId || '*default*'}`
  }

  private publishActivity(): void {
    const nextActive = new Set<string>()
    for (const [workspaceId, sessions] of this.activeEventSessions.entries()) {
      if (sessions.size > 0) nextActive.add(workspaceId)
    }

    if (this.equalSets(nextActive, this.lastPublishedActiveIds)) return

    const becameInactive: string[] = []
    for (const wsId of this.lastPublishedActiveIds) {
      if (!nextActive.has(wsId)) becameInactive.push(wsId)
    }

    this.lastPublishedActiveIds = nextActive
    this.sendActivity(Array.from(nextActive).sort())

    // Fallback completion signal: if a workspace was active and now is not,
    // emit a notify event so renderer can show unread attention dots even when
    // explicit awaiting_user events are missed.
    for (const wsId of becameInactive) {
      this.notifyRenderer(wsId)
    }
  }

  private equalSets(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false
    for (const value of a) {
      if (!b.has(value)) return false
    }
    return true
  }

  private notifyRenderer(workspaceId: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.AGENT_NOTIFY_WORKSPACE, workspaceId)
      }
    }
  }

  private sendActivity(workspaceIds: string[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.AGENT_ACTIVITY_UPDATE, workspaceIds)
      }
    }
  }
}
