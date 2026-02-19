import { beforeAll, describe, expect, it, mock } from 'bun:test'
import type { AutomationConfig } from '../shared/automation-types'

type SchedulerLike = {
  jobs: Map<string, {
    task: { getNextRun?: () => Date | null; stop: () => void }
    config: AutomationConfig
    lastCheckedAt: number
    nextRunAt: number | null
  }>
  executeRun: (config: AutomationConfig, reason: 'scheduled' | 'catchup' | 'manual') => Promise<boolean>
  catchUpOnWake: (now?: Date) => Promise<void>
}

let SchedulerCtor: new (ptyManager: unknown) => SchedulerLike

beforeAll(async () => {
  mock.module('node-cron', () => ({
    schedule: () => ({
      stop: () => {},
      getNextRun: () => null,
    }),
  }))

  mock.module('electron', () => ({
    BrowserWindow: {
      getAllWindows: () => [],
    },
  }))

  const mod = await import('./automation-scheduler')
  SchedulerCtor = mod.AutomationScheduler as unknown as new (ptyManager: unknown) => SchedulerLike
})

function createAutomation(id: string): AutomationConfig {
  return {
    id,
    name: `Automation ${id}`,
    projectId: 'project-1',
    prompt: 'do thing',
    cronExpression: '0 * * * *',
    enabled: true,
    repoPath: '/tmp/repo',
  }
}

describe('AutomationScheduler.catchUpOnWake', () => {
  it('runs at most one catch-up per wake window', async () => {
    const scheduler = new SchedulerCtor({})
    const executeRun = mock(async () => true)
    scheduler.executeRun = executeRun

    let nextRunMs = Date.UTC(2026, 1, 19, 12, 0, 0)
    const task = {
      getNextRun: () => new Date(nextRunMs),
      stop: () => {},
    }

    const firstWake = Date.UTC(2026, 1, 19, 11, 30, 0)
    scheduler.jobs.set('a1', {
      task,
      config: createAutomation('a1'),
      lastCheckedAt: Date.UTC(2026, 1, 19, 9, 0, 0),
      nextRunAt: Date.UTC(2026, 1, 19, 10, 0, 0),
    })

    await scheduler.catchUpOnWake(new Date(firstWake))
    expect(executeRun).toHaveBeenCalledTimes(1)
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), 'catchup')

    // No new missed slot yet: second wake should not create another catch-up run.
    const secondWake = Date.UTC(2026, 1, 19, 11, 35, 0)
    nextRunMs = Date.UTC(2026, 1, 19, 12, 0, 0)
    await scheduler.catchUpOnWake(new Date(secondWake))
    expect(executeRun).toHaveBeenCalledTimes(1)
  })

  it('only catches up automations that missed a slot', async () => {
    const scheduler = new SchedulerCtor({})
    const executeRun = mock(async () => true)
    scheduler.executeRun = executeRun

    const wakeAt = Date.UTC(2026, 1, 19, 11, 30, 0)

    scheduler.jobs.set('due', {
      task: { getNextRun: () => new Date(Date.UTC(2026, 1, 19, 12, 0, 0)), stop: () => {} },
      config: createAutomation('due'),
      lastCheckedAt: Date.UTC(2026, 1, 19, 9, 0, 0),
      nextRunAt: Date.UTC(2026, 1, 19, 10, 0, 0),
    })

    scheduler.jobs.set('not-due', {
      task: { getNextRun: () => new Date(Date.UTC(2026, 1, 19, 12, 0, 0)), stop: () => {} },
      config: createAutomation('not-due'),
      lastCheckedAt: Date.UTC(2026, 1, 19, 11, 29, 30),
      nextRunAt: Date.UTC(2026, 1, 19, 12, 0, 0),
    })

    await scheduler.catchUpOnWake(new Date(wakeAt))

    expect(executeRun).toHaveBeenCalledTimes(1)
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'due' }), 'catchup')
  })

  it('continues processing remaining automations when one catch-up throws', async () => {
    const scheduler = new SchedulerCtor({})
    const executeRun = mock(async (config: AutomationConfig) => {
      if (config.id === 'first') {
        throw new Error('simulated run failure')
      }
      return true
    })
    scheduler.executeRun = executeRun as SchedulerLike['executeRun']

    const wakeAt = Date.UTC(2026, 1, 19, 11, 30, 0)

    scheduler.jobs.set('first', {
      task: { getNextRun: () => new Date(Date.UTC(2026, 1, 19, 12, 0, 0)), stop: () => {} },
      config: createAutomation('first'),
      lastCheckedAt: Date.UTC(2026, 1, 19, 9, 0, 0),
      nextRunAt: Date.UTC(2026, 1, 19, 10, 0, 0),
    })

    scheduler.jobs.set('second', {
      task: { getNextRun: () => new Date(Date.UTC(2026, 1, 19, 12, 0, 0)), stop: () => {} },
      config: createAutomation('second'),
      lastCheckedAt: Date.UTC(2026, 1, 19, 9, 0, 0),
      nextRunAt: Date.UTC(2026, 1, 19, 10, 0, 0),
    })

    await scheduler.catchUpOnWake(new Date(wakeAt))

    expect(executeRun).toHaveBeenCalledTimes(2)
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'first' }), 'catchup')
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'second' }), 'catchup')
  })
})
