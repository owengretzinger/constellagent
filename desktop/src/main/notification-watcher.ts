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
        this.lastActiveIds = sorted
        this.sendActivity(files)
      }
    } catch {
      if (this.lastActiveIds !== '') {
        this.lastActiveIds = ''
        this.sendActivity([])
      }
    }
  }

  private processFile(filePath: string): void {
    try {
      const wsId = readFileSync(filePath, 'utf-8').trim()
      unlinkSync(filePath)
      if (wsId) this.notifyRenderer(wsId)
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
