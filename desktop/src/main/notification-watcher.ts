import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'

const DEFAULT_NOTIFY_DIR = '/tmp/constellagent-notify'
const DEFAULT_ACTIVITY_DIR = '/tmp/constellagent-activity'
const POLL_INTERVAL = 500
const FILE_SETTLE_MS = 100
const CLAUDE_MARKER_SUFFIX = '.claude'
const CODEX_MARKER_SEGMENT = '.codex.'

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
      const workspaceIds = Array.from(new Set(
        files
          .map((name) => {
            const workspaceId = this.workspaceIdFromMarkerName(name)
            if (!workspaceId) {
              this.removeActivityMarker(name)
              return null
            }
            return workspaceId
          })
          .filter((id): id is string => !!id)
      ))
      const sorted = workspaceIds.sort().join(',')
      if (sorted !== this.lastActiveIds) {
        const prevIds = this.lastActiveIds ? this.lastActiveIds.split(',').filter(Boolean) : []
        const nextIdSet = new Set(workspaceIds)
        const becameInactive = prevIds.filter((id) => !nextIdSet.has(id))

        this.lastActiveIds = sorted
        this.sendActivity(workspaceIds)

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

  private workspaceIdFromMarkerName(name: string): string | null {
    const marker = name.trim()
    if (!marker) return null

    if (marker.endsWith(CLAUDE_MARKER_SUFFIX)) {
      return marker.slice(0, -CLAUDE_MARKER_SUFFIX.length) || null
    }

    const codexIdx = marker.indexOf(CODEX_MARKER_SEGMENT)
    if (codexIdx > 0) {
      return marker.slice(0, codexIdx) || null
    }

    // Legacy format is no longer written. Ignore and clean it up to avoid
    // stale always-active spinners after upgrading marker formats.
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

  private sendActivity(workspaceIds: string[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.CLAUDE_ACTIVITY_UPDATE, workspaceIds)
      }
    }
  }
}
