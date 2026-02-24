import { test, expect, type Page } from '@playwright/test'
import { join } from 'path'
import { execSync } from 'child_process'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { launchControlledApp } from './helpers/electron-app-driver'

function createTestRepo(name: string): string {
  const stamp = `${name}-${Date.now()}`
  const repoPath = join('/tmp', `test-repo-${stamp}`)
  mkdirSync(repoPath, { recursive: true })
  execSync('git init', { cwd: repoPath })
  execSync('git checkout -b main', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n')
  execSync('git add .', { cwd: repoPath })
  execSync('git commit -m "initial commit"', { cwd: repoPath })
  return repoPath
}

function writeAgentEvent(
  eventDir: string,
  event: {
    workspaceId: string
    agent: string
    type: 'turn_started' | 'awaiting_user'
    outcome?: 'success' | 'failed'
    sessionId?: string
  },
): void {
  mkdirSync(eventDir, { recursive: true })
  const target = join(eventDir, `event-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  const tmpTarget = `${target}.tmp`
  writeFileSync(
    tmpTarget,
    JSON.stringify({
      schema: 1,
      workspaceId: event.workspaceId,
      agent: event.agent,
      type: event.type,
      outcome: event.outcome,
      sessionId: event.sessionId,
      at: Date.now(),
    }),
  )
  renameSync(tmpTarget, target)
}

async function setupTwoWorkspaces(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const wt1 = await (window as any).api.git.createWorktree(repo, 'ws-1', 'branch-1', true, 'main')
    const ws1Id = crypto.randomUUID()
    store.addWorkspace({ id: ws1Id, name: 'ws-1', branch: 'branch-1', worktreePath: wt1, projectId })
    const pty1Id = await (window as any).api.pty.create(wt1, '/bin/bash', { AGENT_ORCH_WS_ID: ws1Id })
    store.addTab({ id: crypto.randomUUID(), workspaceId: ws1Id, type: 'terminal', title: 'Terminal', ptyId: pty1Id })

    const wt2 = await (window as any).api.git.createWorktree(repo, 'ws-2', 'branch-2', true, 'main')
    const ws2Id = crypto.randomUUID()
    store.addWorkspace({ id: ws2Id, name: 'ws-2', branch: 'branch-2', worktreePath: wt2, projectId })
    const pty2Id = await (window as any).api.pty.create(wt2, '/bin/bash', { AGENT_ORCH_WS_ID: ws2Id })
    store.addTab({ id: crypto.randomUUID(), workspaceId: ws2Id, type: 'terminal', title: 'Terminal', ptyId: pty2Id })

    // keep ws2 focused while ws1 emits activity
    store.setActiveWorkspace(ws2Id)

    return { ws1Id, ws2Id }
  }, repoPath)
}

test.describe('Agent event protocol', () => {
  test('can control app via code and verify activity -> awaiting_user transitions', async () => {
    const repoPath = createTestRepo('agent-events')
    const { app, window, eventDir } = await launchControlledApp('agent-events')

    try {
      const { ws1Id } = await setupTwoWorkspaces(window, repoPath)
      await window.waitForTimeout(600)

      writeAgentEvent(eventDir, {
        workspaceId: ws1Id,
        agent: 'pi-mono',
        type: 'turn_started',
        sessionId: 'session-1',
      })

      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 5000 },
      )

      writeAgentEvent(eventDir, {
        workspaceId: ws1Id,
        agent: 'pi-mono',
        type: 'awaiting_user',
        sessionId: 'session-1',
      })

      await window.waitForFunction(
        (wsId: string) => !(window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 5000 },
      )
      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 5000 },
      )

      await window.evaluate((wsId: string) => {
        ;(window as any).__store.getState().setActiveWorkspace(wsId)
      }, ws1Id)

      await window.waitForFunction(
        (wsId: string) => !(window as any).__store.getState().unreadWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 5000 },
      )

      const isActive = await window.evaluate((wsId: string) => {
        return (window as any).__store.getState().activeAgentWorkspaceIds.has(wsId)
      }, ws1Id)
      expect(isActive).toBe(false)
    } finally {
      await app.close()
      rmSync(eventDir, { recursive: true, force: true })
    }
  })
})
