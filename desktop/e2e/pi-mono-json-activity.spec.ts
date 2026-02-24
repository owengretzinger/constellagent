import { test, expect, type Page } from '@playwright/test'
import { join } from 'path'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'
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

async function setupTwoWorkspaces(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const wt1 = await (window as any).api.git.createWorktree(repo, 'ws-pi-a', 'branch-pi-a', true, 'main')
    const ws1Id = crypto.randomUUID()
    store.addWorkspace({ id: ws1Id, name: 'ws-pi-a', branch: 'branch-pi-a', worktreePath: wt1, projectId })
    const pty1Id = await (window as any).api.pty.create(wt1, '/bin/bash', { AGENT_ORCH_WS_ID: ws1Id })
    store.addTab({ id: crypto.randomUUID(), workspaceId: ws1Id, type: 'terminal', title: 'Terminal', ptyId: pty1Id })

    const wt2 = await (window as any).api.git.createWorktree(repo, 'ws-pi-b', 'branch-pi-b', true, 'main')
    const ws2Id = crypto.randomUUID()
    store.addWorkspace({ id: ws2Id, name: 'ws-pi-b', branch: 'branch-pi-b', worktreePath: wt2, projectId })
    const pty2Id = await (window as any).api.pty.create(wt2, '/bin/bash', { AGENT_ORCH_WS_ID: ws2Id })
    store.addTab({ id: crypto.randomUUID(), workspaceId: ws2Id, type: 'terminal', title: 'Terminal', ptyId: pty2Id })

    // keep workspace B selected while workspace A runs in the background.
    store.setActiveWorkspace(ws2Id)

    return { ws1Id, ws2Id, pty1Id, pty2Id }
  }, repoPath)
}

function writeFakePiMonoJsonScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `#!/bin/bash
printf '{"type":"session","version":3,"id":"pi-json-session","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp"}\\n'
printf '{"type":"agent_start"}\\n'
printf '{"type":"turn_start"}\\n'
sleep 1
printf '{"type":"turn_end","message":{"role":"assistant","content":[]},"toolResults":[]}\\n'
sleep 1
`,
    { mode: 0o755 },
  )
  chmodSync(scriptPath, 0o755)
}

test.describe('Pi-mono JSON activity detection', () => {
  test('detects running and awaiting-user from pi --mode json event stream', async () => {
    const repoPath = createTestRepo('pi-mono-json')
    const { app, window, notifyDir, activityDir, eventDir } = await launchControlledApp('pi-mono-json')
    const scriptPath = join('/tmp', `fake-pi-mono-json-${Date.now()}.sh`)

    try {
      writeFakePiMonoJsonScript(scriptPath)
      const { ws1Id, pty1Id } = await setupTwoWorkspaces(window, repoPath)
      await window.waitForTimeout(600)

      await window.evaluate(({ ptyId, cmd }) => {
        ;(window as any).api.pty.write(ptyId, `${cmd}\n`)
      }, { ptyId: pty1Id, cmd: scriptPath })

      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 7000 },
      )

      await window.waitForFunction(
        (wsId: string) => !(window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 7000 },
      )

      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 7000 },
      )

      const hasUnread = await window.evaluate((wsId: string) => {
        return (window as any).__store.getState().unreadWorkspaceIds.has(wsId)
      }, ws1Id)
      expect(hasUnread).toBe(true)
    } finally {
      await app.close()
      rmSync(scriptPath, { force: true })
      rmSync(notifyDir, { recursive: true, force: true })
      rmSync(activityDir, { recursive: true, force: true })
      rmSync(eventDir, { recursive: true, force: true })
    }
  })
})
