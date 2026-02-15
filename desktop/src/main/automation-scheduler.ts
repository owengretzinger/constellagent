import * as cron from 'node-cron'
import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AutomationConfig, AutomationRunStartedEvent } from '../shared/automation-types'
import { GitService } from './git-service'
import { trustPathForClaude } from './claude-config'

interface TerminalService {
  createOrAttach(request: {
    sessionId: string
    workspaceId: string
    cwd: string
    cols: number
    rows: number
    shell?: string
    env?: Record<string, string>
    useLoginShell?: boolean
  }): Promise<unknown>
  write(request: {
    sessionId: string
    data: string
  }): Promise<unknown>
}

export class AutomationScheduler {
  private jobs = new Map<string, cron.ScheduledTask>()
  private terminalService: TerminalService

  constructor(terminalService: TerminalService) {
    this.terminalService = terminalService
  }

  schedule(config: AutomationConfig): void {
    this.unschedule(config.id)
    if (!config.enabled) return

    const task = cron.schedule(config.cronExpression, () => {
      this.executeRun(config).catch((err) => {
        console.error(`Automation ${config.id} run failed:`, err)
      })
    })

    this.jobs.set(config.id, task)
  }

  unschedule(automationId: string): void {
    const job = this.jobs.get(automationId)
    if (job) {
      job.stop()
      this.jobs.delete(automationId)
    }
  }

  runNow(config: AutomationConfig): void {
    this.executeRun(config).catch((err) => {
      console.error(`Automation ${config.id} run failed:`, err)
    })
  }

  destroyAll(): void {
    for (const [id] of this.jobs) {
      this.unschedule(id)
    }
  }

  private async executeRun(config: AutomationConfig): Promise<void> {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return

    const sanitized = config.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30)
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`

    const branch = `auto/${sanitized}/${timestamp}`
    const wtName = `auto-${sanitized}-${timestamp}`

    let worktreePath: string
    try {
      worktreePath = await GitService.createWorktree(config.repoPath, wtName, branch, true)
    } catch (err) {
      console.error(`Failed to create worktree for automation ${config.id}:`, err)
      return
    }

    try {
      await trustPathForClaude(worktreePath)
    } catch {
      // non-fatal
    }

    const ptyId = `pty-${randomUUID()}`

    // Spawn a shell session in daemon-backed terminal host.
    const shell = process.env.SHELL || '/bin/zsh'
    const escapedPrompt = config.prompt.replace(/'/g, "'\\''")
    await this.terminalService.createOrAttach({
      sessionId: ptyId,
      workspaceId: config.projectId,
      cwd: worktreePath,
      cols: 80,
      rows: 24,
      shell,
      useLoginShell: true,
    })
    await this.terminalService.write({
      sessionId: ptyId,
      data: `claude '${escapedPrompt}'\r`,
    })

    // Notify renderer to create workspace + terminal tab
    if (!win.isDestroyed()) {
      const event: AutomationRunStartedEvent = {
        automationId: config.id,
        automationName: config.name,
        projectId: config.projectId,
        ptyId,
        worktreePath,
        branch,
      }
      win.webContents.send(IPC.AUTOMATION_RUN_STARTED, event)
    }
  }
}
