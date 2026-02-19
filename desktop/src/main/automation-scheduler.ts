import * as cron from 'node-cron'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AutomationConfig, AutomationRunStartedEvent } from '../shared/automation-types'
import { PtyManager } from './pty-manager'
import { GitService } from './git-service'
import { trustPathForClaude } from './claude-config'
import { shouldCatchUpOnWake } from './automation-catchup'

interface AutomationRuntime {
  task: cron.ScheduledTask
  config: AutomationConfig
  lastCheckedAt: number
  nextRunAt: number | null
}

export class AutomationScheduler {
  private jobs = new Map<string, AutomationRuntime>()
  private activeRuns = new Map<string, string>()
  private runLocks = new Set<string>()
  private ptyManager: PtyManager

  constructor(ptyManager: PtyManager) {
    this.ptyManager = ptyManager
  }

  schedule(config: AutomationConfig): void {
    this.unschedule(config.id)
    if (!config.enabled) return

    const task = cron.schedule(config.cronExpression, () => {
      this.onScheduledTick(config.id).catch((err) => {
        console.error(`Automation ${config.id} run failed:`, err)
      })
    })

    this.jobs.set(config.id, {
      task,
      config,
      lastCheckedAt: Date.now(),
      nextRunAt: this.getTaskNextRunAt(task),
    })
  }

  unschedule(automationId: string): void {
    const runtime = this.jobs.get(automationId)
    if (runtime) {
      runtime.task.stop()
      this.jobs.delete(automationId)
    }
  }

  runNow(config: AutomationConfig): void {
    this.executeRun(config, 'manual').catch((err) => {
      console.error(`Automation ${config.id} run failed:`, err)
    })
  }

  async catchUpOnWake(now = new Date()): Promise<void> {
    const nowMs = now.getTime()
    for (const [automationId, runtime] of this.jobs.entries()) {
      try {
        const shouldCatchUp = shouldCatchUpOnWake({
          cronExpression: runtime.config.cronExpression,
          lastCheckedAt: runtime.lastCheckedAt,
          nowMs,
          nextRunAt: runtime.nextRunAt,
        })
        runtime.lastCheckedAt = nowMs
        runtime.nextRunAt = this.getTaskNextRunAt(runtime.task)
        if (!shouldCatchUp) continue

        const started = await this.executeRun(runtime.config, 'catchup')
        if (started) {
          console.info(`[automation] recovered missed run on wake: ${automationId}`)
        }
        runtime.lastCheckedAt = Date.now()
        runtime.nextRunAt = this.getTaskNextRunAt(runtime.task)
      } catch (err) {
        console.error(`[automation] catch-up failed for ${automationId}:`, err)
      }
    }
  }

  destroyAll(): void {
    for (const [id] of this.jobs) {
      this.unschedule(id)
    }
  }

  private async onScheduledTick(automationId: string): Promise<void> {
    const runtime = this.jobs.get(automationId)
    if (!runtime) return
    runtime.lastCheckedAt = Date.now()
    runtime.nextRunAt = this.getTaskNextRunAt(runtime.task)
    await this.executeRun(runtime.config, 'scheduled')
    runtime.lastCheckedAt = Date.now()
    runtime.nextRunAt = this.getTaskNextRunAt(runtime.task)
  }

  private getTaskNextRunAt(task: cron.ScheduledTask): number | null {
    const raw = (task as unknown as { getNextRun?: () => Date | null }).getNextRun?.()
    if (!(raw instanceof Date)) return null
    const ms = raw.getTime()
    return Number.isFinite(ms) ? ms : null
  }

  private async executeRun(config: AutomationConfig, reason: 'scheduled' | 'catchup' | 'manual'): Promise<boolean> {
    if (this.runLocks.has(config.id)) {
      const activePtyId = this.activeRuns.get(config.id)
      console.warn(`[automation] skipping ${reason} run for ${config.id}; previous run still active (${activePtyId})`)
      return false
    }
    this.runLocks.add(config.id)

    let ptyId: string | null = null
    try {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return false

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
        return false
      }

      try {
        await trustPathForClaude(worktreePath)
      } catch {
        // non-fatal
      }

      // Spawn a shell with initialWrite — writes the claude command as soon as
      // the shell emits its first output (ready), no manual timeout needed.
      const shell = process.env.SHELL || '/bin/zsh'
      const escapedPrompt = config.prompt.replace(/'/g, "'\\''")
      const createdPtyId = this.ptyManager.create(
        worktreePath,
        win.webContents,
        shell,
        undefined,
        `claude '${escapedPrompt}'\r`
      )
      ptyId = createdPtyId
      this.activeRuns.set(config.id, createdPtyId)
      this.ptyManager.onExit(createdPtyId, () => {
        if (this.activeRuns.get(config.id) === createdPtyId) {
          this.activeRuns.delete(config.id)
        }
        this.runLocks.delete(config.id)
      })

      // Notify renderer to create workspace + terminal tab
      if (!win.isDestroyed()) {
        const event: AutomationRunStartedEvent = {
          automationId: config.id,
          automationName: config.name,
          projectId: config.projectId,
          ptyId: createdPtyId,
          worktreePath,
          branch,
        }
        win.webContents.send(IPC.AUTOMATION_RUN_STARTED, event)
      }
      return true
    } finally {
      if (!ptyId) {
        this.runLocks.delete(config.id)
      }
    }
  }
}
