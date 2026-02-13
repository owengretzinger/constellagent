import { mkdirSync, readdirSync, readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'

const NOTIFY_DIR = '/tmp/constellagent-notify'
const ACTIVITY_DIR = '/tmp/constellagent-activity'
const POLL_INTERVAL = 500

export class NotificationWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastActiveIds: string = ''

  start(): void {
    mkdirSync(NOTIFY_DIR, { recursive: true })
    mkdirSync(ACTIVITY_DIR, { recursive: true })
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
      const files = readdirSync(NOTIFY_DIR)
      for (const f of files) {
        this.processFile(join(NOTIFY_DIR, f))
      }
    } catch {
      // Directory may not exist yet
    }
  }

  private pollActivity(): void {
    try {
      const files = readdirSync(ACTIVITY_DIR)
      const sorted = files.sort().join(',')
      if (sorted !== this.lastActiveIds) {
        const prevIds = this.lastActiveIds ? this.lastActiveIds.split(',').filter(Boolean) : []
        const nextIdSet = new Set(files)
        const becameInactive = prevIds.filter((id) => !nextIdSet.has(id))

        this.lastActiveIds = sorted
        this.sendActivity(files)

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
      if (!wsId) return
      this.notifyRenderer(wsId)
      unlinkSync(filePath)
    } catch {
      // File may have been already processed or deleted
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
