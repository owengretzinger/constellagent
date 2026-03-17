import { getAgentFS, closeAgentFS } from './agentfs-service'

export class ContextDb {
  private projectDir: string

  constructor(projectDir: string) {
    this.projectDir = projectDir
  }

  /** Ensure the AgentFS instance is ready (lazy init) */
  private agent() {
    return getAgentFS(this.projectDir)
  }

  async insert(entry: {
    workspaceId: string
    agentType?: string
    sessionId?: string
    toolName: string
    toolInput?: string
    filePath?: string
    projectHead?: string
    eventType?: string
    toolResponse?: string
    timestamp: string
  }): Promise<void> {
    const agent = await this.agent()
    const db = agent.getDatabase()

    // Insert into entries table
    const stmt = db.prepare(`
      INSERT INTO entries (workspace_id, agent_type, session_id, tool_name, tool_input, file_path, project_head, event_type, tool_response, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    await stmt.run(
      entry.workspaceId,
      entry.agentType ?? 'claude-code',
      entry.sessionId ?? null,
      entry.toolName,
      entry.toolInput ?? null,
      entry.filePath ?? null,
      entry.projectHead ?? null,
      entry.eventType ?? null,
      entry.toolResponse ?? null,
      entry.timestamp,
    )

    // Also record via AgentFS tools API for tool analytics (best-effort)
    // AgentFS tools.record() expects Unix timestamps in seconds, not milliseconds
    const startedAtSec = Math.floor(new Date(entry.timestamp).getTime() / 1000) || Math.floor(Date.now() / 1000)
    try {
      await agent.tools.record(
        entry.toolName,
        startedAtSec,
        startedAtSec,
        entry.toolInput ? { input: entry.toolInput, file: entry.filePath } : undefined,
        entry.toolResponse ?? undefined,
      )
    } catch (err) { console.error('agentfs: tools.record() failed (best-effort)', err) }

    // Store in KV for fast recent-entry retrieval (best-effort)
    try {
      const kvKey = `entry:${entry.workspaceId}:${startedAtSec}:${Math.random().toString(36).slice(2, 8)}`
      await agent.kv.set(kvKey, entry)
    } catch (err) { console.error('agentfs: kv.set() failed (best-effort)', err) }
  }

  async search(query: string, limit = 20): Promise<Array<{
    id: number
    workspaceId: string
    toolName: string
    toolInput: string
    filePath: string | null
    agentType: string
    projectHead: string | null
    eventType: string | null
    toolResponse: string | null
    timestamp: string
  }>> {
    const agent = await this.agent()
    const db = agent.getDatabase()
    const likePattern = `%${query}%`
    const stmt = db.prepare(`
      SELECT id, workspace_id as workspaceId, tool_name as toolName,
             tool_input as toolInput, file_path as filePath,
             agent_type as agentType, project_head as projectHead,
             event_type as eventType, tool_response as toolResponse,
             timestamp
      FROM entries
      WHERE tool_name LIKE ? OR tool_input LIKE ? OR file_path LIKE ? OR tool_response LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `)
    return await stmt.all(likePattern, likePattern, likePattern, likePattern, limit) as any[]
  }

  async getRecent(workspaceId: string, limit = 50): Promise<Array<{
    id: number
    toolName: string
    toolInput: string
    filePath: string | null
    agentType: string
    projectHead: string | null
    eventType: string | null
    toolResponse: string | null
    timestamp: string
  }>> {
    const agent = await this.agent()
    const db = agent.getDatabase()
    const stmt = db.prepare(`
      SELECT id, tool_name as toolName, tool_input as toolInput,
             file_path as filePath, agent_type as agentType,
             project_head as projectHead, event_type as eventType,
             tool_response as toolResponse, timestamp
      FROM entries
      WHERE workspace_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    return await stmt.all(workspaceId, limit) as any[]
  }

  async getRecentAll(limit = 20): Promise<Array<{
    id: number
    toolName: string
    toolInput: string
    filePath: string | null
    agentType: string
    projectHead: string | null
    eventType: string | null
    toolResponse: string | null
    sessionId: string | null
    timestamp: string
  }>> {
    const agent = await this.agent()
    const db = agent.getDatabase()
    const stmt = db.prepare(`
      SELECT id, tool_name as toolName, tool_input as toolInput,
             file_path as filePath, agent_type as agentType,
             project_head as projectHead, event_type as eventType,
             tool_response as toolResponse, session_id as sessionId,
             timestamp
      FROM entries
      ORDER BY id DESC
      LIMIT ?
    `)
    return await stmt.all(limit) as any[]
  }

  /**
   * Build a rich markdown context summary for a workspace.
   * Includes recent activity timeline, files touched, and detailed tool call summaries.
   * This is the primary context surface exposed to agents via hooks.
   */
  async buildAgentContext(workspaceId: string, opts?: { limit?: number; maxChars?: number }): Promise<string> {
    const limit = opts?.limit ?? 30
    const maxChars = opts?.maxChars ?? 6000
    const entries = await this.getRecent(workspaceId, limit)

    if (entries.length === 0) {
      return '# Agent Context\n\nNo recent activity recorded for this workspace.\n'
    }

    const sections: string[] = []

    // ── Header ──
    sections.push(`# Agent Context — Cross-Agent Activity\n`)
    sections.push(`_Auto-generated by Constellagent. ${entries.length} recent entries._\n`)

    // ── Files Recently Touched ──
    const filesTouched = new Map<string, { agent: string; tool: string; timestamp: string }>()
    for (const e of entries) {
      if (e.filePath && !filesTouched.has(e.filePath)) {
        filesTouched.set(e.filePath, {
          agent: e.agentType,
          tool: e.toolName,
          timestamp: e.timestamp,
        })
      }
    }

    if (filesTouched.size > 0) {
      sections.push(`## Files Recently Touched\n`)
      let fileCount = 0
      for (const [fp, meta] of filesTouched) {
        if (fileCount >= 15) {
          sections.push(`- _...and ${filesTouched.size - fileCount} more_`)
          break
        }
        const ago = formatRelativeTime(meta.timestamp)
        sections.push(`- \`${fp}\` (${meta.agent}, ${meta.tool}, ${ago})`)
        fileCount++
      }
      sections.push('')
    }

    // ── Activity Timeline ──
    sections.push(`## Recent Activity\n`)
    sections.push('| Time | Agent | Event | Summary |')
    sections.push('|------|-------|-------|---------|')

    for (const e of entries) {
      const time = e.timestamp?.replace('T', ' ').replace('Z', '') || '?'
      const agent = e.agentType || '?'
      const tool = e.toolName || '?'
      let summary = ''

      if (e.filePath) {
        summary = e.filePath
      } else if (e.toolInput) {
        summary = summarizeInput(e.toolInput)
      }
      summary = summary.replace(/\|/g, '\\|').slice(0, 100)
      sections.push(`| ${time} | ${agent} | ${tool} | ${summary} |`)
    }
    sections.push('')

    // ── Detailed Tool Calls (most recent N with inputs/outputs) ──
    const detailedEntries = entries.filter(e =>
      e.toolName !== 'UserPrompt' && e.toolName !== 'SessionStart' && e.toolName !== 'SessionEnd'
    ).slice(0, 10)

    if (detailedEntries.length > 0) {
      sections.push(`## Recent Tool Call Details\n`)

      for (const e of detailedEntries) {
        const ago = formatRelativeTime(e.timestamp)
        sections.push(`### ${e.toolName} (${e.agentType}, ${ago})`)
        if (e.filePath) sections.push(`- **File**: \`${e.filePath}\``)
        if (e.toolInput) {
          const inputSummary = summarizeInput(e.toolInput, 300)
          sections.push(`- **Input**: ${inputSummary}`)
        }
        if (e.toolResponse) {
          const responseSummary = e.toolResponse.slice(0, 200).replace(/\n/g, ' ')
          sections.push(`- **Result**: ${responseSummary}${e.toolResponse.length > 200 ? '...' : ''}`)
        }
        sections.push('')
      }
    }

    let result = sections.join('\n')
    // Truncate to stay within token budget
    if (result.length > maxChars) {
      result = result.slice(0, maxChars) + '\n\n_...context truncated..._\n'
    }
    return result
  }

  /**
   * Build a context summary across ALL workspaces (for global sliding window).
   */
  async buildGlobalContext(opts?: { limit?: number; maxChars?: number }): Promise<string> {
    const limit = opts?.limit ?? 20
    const maxChars = opts?.maxChars ?? 4000
    const entries = await this.getRecentAll(limit)

    if (entries.length === 0) {
      return '# Cross-Agent Context\n\nNo recent activity.\n'
    }

    const sections: string[] = []
    sections.push(`# Cross-Agent Activity (all workspaces)\n`)

    sections.push('| Time | Agent | Tool | Summary |')
    sections.push('|------|-------|------|---------|')

    for (const e of entries) {
      const time = e.timestamp?.replace('T', ' ').replace('Z', '') || '?'
      const agent = e.agentType || '?'
      const tool = e.toolName || '?'
      let summary = ''
      if (e.filePath) {
        summary = e.filePath
      } else if (e.toolInput) {
        summary = summarizeInput(e.toolInput)
      }
      summary = summary.replace(/\|/g, '\\|').slice(0, 100)
      sections.push(`| ${time} | ${agent} | ${tool} | ${summary} |`)
    }
    sections.push('')

    let result = sections.join('\n')
    if (result.length > maxChars) {
      result = result.slice(0, maxChars) + '\n\n_...truncated..._\n'
    }
    return result
  }

  /**
   * Get context entries filtered by session ID.
   * Useful for resuming a specific agent session or reviewing session-scoped activity.
   */
  async getSessionContext(sessionId: string, limit = 50): Promise<Array<{
    id: number
    workspaceId: string
    toolName: string
    toolInput: string
    filePath: string | null
    agentType: string
    projectHead: string | null
    eventType: string | null
    toolResponse: string | null
    timestamp: string
  }>> {
    const agent = await this.agent()
    const db = agent.getDatabase()
    const stmt = db.prepare(`
      SELECT id, workspace_id as workspaceId, tool_name as toolName,
             tool_input as toolInput, file_path as filePath,
             agent_type as agentType, project_head as projectHead,
             event_type as eventType, tool_response as toolResponse,
             timestamp
      FROM entries
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    return await stmt.all(sessionId, limit) as any[]
  }

  /**
   * Store session metadata in AgentFS KV store.
   * Key format: session:{wsId}:latest -> { sessionId, agentType, startedAt, ... }
   */
  async saveSessionMeta(wsId: string, meta: {
    sessionId: string
    agentType: string
    startedAt: string
    summary?: string
  }): Promise<void> {
    const agent = await this.agent()
    try {
      await agent.kv.set(`session:${wsId}:latest`, meta)
      // Also store in a per-agent key for multi-agent session tracking
      await agent.kv.set(`session:${wsId}:${meta.agentType}:latest`, meta)
    } catch (err) {
      console.error('agentfs: failed to save session meta', err)
    }
  }

  /**
   * Retrieve the latest session metadata for a workspace.
   */
  async getSessionMeta(wsId: string, agentType?: string): Promise<{
    sessionId: string
    agentType: string
    startedAt: string
    summary?: string
  } | null> {
    const agent = await this.agent()
    try {
      const key = agentType
        ? `session:${wsId}:${agentType}:latest`
        : `session:${wsId}:latest`
      const value = await agent.kv.get(key)
      return value as any ?? null
    } catch (err) {
      console.error('agentfs: failed to get session meta', err)
      return null
    }
  }

  async close(): Promise<void> {
    await closeAgentFS(this.projectDir)
  }
}

// ── Helpers ──

function summarizeInput(toolInput: string, maxLen = 80): string {
  try {
    const parsed = JSON.parse(toolInput)
    if (parsed.i) {
      // Unwrap the {i: ...} wrapper from claude-capture
      const inner = parsed.i
      if (typeof inner === 'string') return inner.slice(0, maxLen)
      return (inner.command || inner.file_path || inner.path || inner.content?.slice(0, maxLen) || JSON.stringify(inner).slice(0, maxLen))
    }
    return (parsed.command || parsed.file_path || parsed.path || parsed.summary || JSON.stringify(parsed).slice(0, maxLen))
  } catch {
    return toolInput.slice(0, maxLen)
  }
}

function formatRelativeTime(timestamp: string): string {
  try {
    const then = new Date(timestamp).getTime()
    const now = Date.now()
    const diffMs = now - then
    if (diffMs < 0) return 'just now'
    const diffSec = Math.floor(diffMs / 1000)
    if (diffSec < 60) return `${diffSec}s ago`
    const diffMin = Math.floor(diffSec / 60)
    if (diffMin < 60) return `${diffMin}m ago`
    const diffHour = Math.floor(diffMin / 60)
    if (diffHour < 24) return `${diffHour}h ago`
    const diffDay = Math.floor(diffHour / 24)
    return `${diffDay}d ago`
  } catch {
    return timestamp
  }
}
