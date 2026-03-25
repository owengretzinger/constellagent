import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import {
  DEFAULT_ACTIVITY_DIR,
  CLAUDE_MARKER_SUFFIX,
  CODEX_MARKER_SEGMENT,
  GEMINI_MARKER_SEGMENT,
  CURSOR_MARKER_SEGMENT,
} from '../shared/agent-markers'

const DEFAULT_NOTIFY_DIR = '/tmp/constellagent-notify'
const POLL_INTERVAL = 500
const FILE_SETTLE_MS = 100

interface ActivityEntry {
  wsId: string
  agentType: string
}

export class NotificationWatcher {
  constructor(
    private readonly notifyDir = process.env.CONSTELLAGENT_NOTIFY_DIR || DEFAULT_NOTIFY_DIR,
    private readonly activityDir = process.env.CONSTELLAGENT_ACTIVITY_DIR || DEFAULT_ACTIVITY_DIR,
  ) {}

  private timer: ReturnType<typeof setInterval> | null = null
  private lastActiveIds: string = ''

  start(): void {
    mkdirSync(this.notifyDir, { recursive: true })
    mkdirSync(this.activityDir, { recursive: true })
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
    this.pollNotifications()
    this.pollActivity()
  }

  private pollNotifications(): void {
    try {
      const files = readdirSync(this.notifyDir)
      const now = Date.now()
      for (const f of files) {
        // Ignore in-progress temp files written by atomic-writer hooks.
        if (f.endsWith('.tmp')) continue
        const filePath = join(this.notifyDir, f)
        try {
          const stat = statSync(filePath)
          // Avoid reading files while writers may still be flushing content.
          if (now - stat.mtimeMs < FILE_SETTLE_MS) continue
        } catch {
          continue
        }
        this.processFile(filePath)
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private pollActivity(): void {
    try {
      const files = readdirSync(this.activityDir)
      // One workspace may have Claude + Codex + others active at once; collect every wsId
      // that has any marker (do not keep only one agent type per workspace).
      const activeWsIds = new Set<string>()
      for (const name of files) {
        const entry = this.workspaceIdFromMarkerName(name)
        if (!entry) {
          this.removeActivityMarker(name)
          continue
        }
        activeWsIds.add(entry.wsId)
      }
      const workspaceIds = [...activeWsIds].sort()
      const entries: ActivityEntry[] = workspaceIds.map((wsId) => ({ wsId, agentType: 'active' }))
      const sorted = workspaceIds.sort().join(',')
      if (sorted !== this.lastActiveIds) {
        const prevIds = this.lastActiveIds ? this.lastActiveIds.split(',').filter(Boolean) : []
        const nextIdSet = new Set(workspaceIds)
        const becameInactive = prevIds.filter((id) => !nextIdSet.has(id))

        this.lastActiveIds = sorted
        this.sendActivity(entries)

        // Fallback completion signal: if a workspace was active and now is not,
        // emit a notify event so renderer can show unread attention dots even
        // when explicit notify files are missed.
        for (const wsId of becameInactive) {
          this.notifyRenderer(wsId)
        }
      }
    } catch {
      if (this.lastActiveIds !== '') {
        const prevIds = this.lastActiveIds.split(',').filter(Boolean)
        this.lastActiveIds = ''
        this.sendActivity([])
        for (const wsId of prevIds) {
          this.notifyRenderer(wsId)
        }
      }
    }
  }

  private processFile(filePath: string): void {
    try {
      const wsId = readFileSync(filePath, 'utf-8').trim()
      if (!wsId) {
        unlinkSync(filePath)
        return
      }
      this.notifyRenderer(wsId)
      unlinkSync(filePath)
    } catch {
      // File may have been already processed or deleted
    }
  }

  private workspaceIdFromMarkerName(name: string): ActivityEntry | null {
    const marker = name.trim()
    if (!marker) return null

    if (marker.endsWith(CLAUDE_MARKER_SUFFIX)) {
      const wsId = marker.slice(0, -CLAUDE_MARKER_SUFFIX.length)
      return wsId ? { wsId, agentType: 'claude-code' } : null
    }

    const codexIdx = marker.indexOf(CODEX_MARKER_SEGMENT)
    if (codexIdx > 0) {
      const wsId = marker.slice(0, codexIdx)
      return wsId ? { wsId, agentType: 'codex' } : null
    }

    const geminiIdx = marker.indexOf(GEMINI_MARKER_SEGMENT)
    if (geminiIdx > 0) {
      const wsId = marker.slice(0, geminiIdx)
      return wsId ? { wsId, agentType: 'gemini' } : null
    }

    const cursorIdx = marker.indexOf(CURSOR_MARKER_SEGMENT)
    if (cursorIdx > 0) {
      const wsId = marker.slice(0, cursorIdx)
      return wsId ? { wsId, agentType: 'cursor' } : null
    }

    return null
  }

  private removeActivityMarker(name: string): void {
    try {
      unlinkSync(join(this.activityDir, name))
    } catch {
      // Marker may already be gone
    }
  }

  private notifyRenderer(workspaceId: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.CLAUDE_NOTIFY_WORKSPACE, workspaceId)
      }
    }
  }

  private sendActivity(entries: ActivityEntry[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.CLAUDE_ACTIVITY_UPDATE, entries)
      }
    }
  }
}
