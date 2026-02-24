import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')
const FAKE_CRUSH_BIN = '/tmp/crush'
const TMP_DIR = '/tmp'

/**
 * Write a fake "crush" script that simulates real Crush TUI output:
 *
 * 1. Varied-size output (streaming response) — different sizes per frame
 * 2. Fixed-size repeating output (idle TUI animation) — same size every frame
 *
 * The detection relies on size-change: varied = active, repeated = idle.
 */
function writeFakeCrushInteractive() {
  writeFileSync(
    FAKE_CRUSH_BIN,
    `#!/bin/bash
# Phase 1: varied-size output (simulates response streaming)
printf 'Starting response for your query now...\\n'
sleep 0.15
printf 'Here is a medium length line of streaming output.\\n'
sleep 0.15
printf 'Short.\\n'
sleep 0.15
printf 'And here is a significantly longer line of output that simulates a bigger token burst from the model.\\n'
sleep 0.15
printf 'Done with the main response content.\\n'
sleep 0.15

# Phase 2: fixed-size repeating output (simulates idle TUI animation)
# Each frame must be the exact same size to be detected as repeating.
while true; do
  printf '%-40s\\r' "Waiting for input..."
  sleep 0.1
done
`,
    { mode: 0o755 },
  )
}

async function launchApp(
  label: string,
): Promise<{ app: ElectronApplication; window: Page; eventDir: string }> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const eventDir = join(TMP_DIR, `constellagent-agent-events-${suffix}`)
  const app = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      CI_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      CONSTELLAGENT_AGENT_EVENT_DIR: eventDir,
    },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(1500)
  return { app, window, eventDir }
}

function createTestRepo(name: string): string {
  const stamp = `${name}-${Date.now()}`
  const repoPath = join('/tmp', `test-repo-${stamp}`)
  const remotePath = join('/tmp', `test-remote-${stamp}.git`)
  mkdirSync(repoPath, { recursive: true })
  execSync('git init', { cwd: repoPath })
  execSync('git checkout -b main', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n')
  execSync('git add .', { cwd: repoPath })
  execSync('git commit -m "initial commit"', { cwd: repoPath })
  execSync(`git init --bare "${remotePath}"`)
  execSync(`git remote add origin "${remotePath}"`, { cwd: repoPath })
  return repoPath
}

async function setupWorkspace(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const worktreePath = await (window as any).api.git.createWorktree(
      repo, 'ws-crush', 'branch-crush', true, 'main',
    )
    const workspaceId = crypto.randomUUID()
    store.addWorkspace({
      id: workspaceId,
      name: 'ws-crush',
      branch: 'branch-crush',
      worktreePath,
      projectId,
    })

    const ptyId = await (window as any).api.pty.create(
      worktreePath, '/bin/bash', { AGENT_ORCH_WS_ID: workspaceId },
    )
    store.addTab({
      id: crypto.randomUUID(),
      workspaceId,
      type: 'terminal',
      title: 'Terminal',
      ptyId,
    })

    return { workspaceId, ptyId }
  }, repoPath)
}

async function setupTwoWorkspaces(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const worktreePath1 = await (window as any).api.git.createWorktree(
      repo, 'ws-crush-a', 'branch-crush-a', true, 'main',
    )
    const workspaceId1 = crypto.randomUUID()
    store.addWorkspace({
      id: workspaceId1,
      name: 'ws-crush-a',
      branch: 'branch-crush-a',
      worktreePath: worktreePath1,
      projectId,
    })
    const ptyId1 = await (window as any).api.pty.create(
      worktreePath1, '/bin/bash', { AGENT_ORCH_WS_ID: workspaceId1 },
    )
    store.addTab({
      id: crypto.randomUUID(),
      workspaceId: workspaceId1,
      type: 'terminal',
      title: 'Terminal',
      ptyId: ptyId1,
    })

    const worktreePath2 = await (window as any).api.git.createWorktree(
      repo, 'ws-crush-b', 'branch-crush-b', true, 'main',
    )
    const workspaceId2 = crypto.randomUUID()
    store.addWorkspace({
      id: workspaceId2,
      name: 'ws-crush-b',
      branch: 'branch-crush-b',
      worktreePath: worktreePath2,
      projectId,
    })
    const ptyId2 = await (window as any).api.pty.create(
      worktreePath2, '/bin/bash', { AGENT_ORCH_WS_ID: workspaceId2 },
    )
    store.addTab({
      id: crypto.randomUUID(),
      workspaceId: workspaceId2,
      type: 'terminal',
      title: 'Terminal',
      ptyId: ptyId2,
    })

    store.setActiveWorkspace(workspaceId2)
    return { workspaceId1, workspaceId2, ptyId1, ptyId2 }
  }, repoPath)
}

test.describe('Crush activity indicator', () => {
  test('marks workspace active while crush streams output and clears after silence', async () => {
    const repoPath = createTestRepo('crush-activity')
    const { app, window, eventDir } = await launchApp('crush-activity')

    try {
      writeFakeCrushInteractive()
      const { workspaceId, ptyId } = await setupWorkspace(window, repoPath)
      await window.waitForTimeout(800)

      // Launch the fake crush binary.
      await window.evaluate(({ ptyId: id, bin }) => {
        ;(window as any).api.pty.write(id, `${bin}\n`)
      }, { ptyId, bin: FAKE_CRUSH_BIN })

      await window.waitForTimeout(300)

      // Send Enter while crush is running to trigger turn_started.
      await window.evaluate((id: string) => {
        ;(window as any).api.pty.write(id, '\n')
      }, ptyId)

      // Workspace should become active while crush is producing output.
      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        workspaceId,
        { timeout: 5000 },
      )

      // After crush finishes streaming and output goes silent (~5s quiet),
      // the workspace should transition to inactive.
      await window.waitForFunction(
        (wsId: string) => !(window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        workspaceId,
        { timeout: 15000 },
      )

      const isActive = await window.evaluate(
        (wsId: string) => (window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        workspaceId,
      )
      expect(isActive).toBe(false)
    } finally {
      rmSync(FAKE_CRUSH_BIN, { force: true })
      await app.close()
      rmSync(eventDir, { recursive: true, force: true })
    }
  })

  test('marks background workspace unread when crush turn finishes', async () => {
    const repoPath = createTestRepo('crush-unread')
    const { app, window, eventDir } = await launchApp('crush-unread')

    try {
      writeFakeCrushInteractive()
      const { workspaceId1, workspaceId2, ptyId1 } = await setupTwoWorkspaces(window, repoPath)
      await window.waitForTimeout(800)

      await window.evaluate(({ ptyId: id, bin }) => {
        ;(window as any).api.pty.write(id, `${bin}\n`)
      }, { ptyId: ptyId1, bin: FAKE_CRUSH_BIN })

      await window.waitForTimeout(300)
      await window.evaluate((id: string) => {
        ;(window as any).api.pty.write(id, '\n')
      }, ptyId1)

      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        workspaceId1,
        { timeout: 5000 },
      )

      // Keep ws-b selected while ws-a finishes.
      await window.evaluate((wsId: string) => {
        ;(window as any).__store.getState().setActiveWorkspace(wsId)
      }, workspaceId2)

      await window.waitForFunction(
        (wsId: string) => !(window as any).__store.getState().activeAgentWorkspaceIds.has(wsId),
        workspaceId1,
        { timeout: 15000 },
      )

      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(wsId),
        workspaceId1,
        { timeout: 5000 },
      )

      const hasUnread = await window.evaluate(
        (wsId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(wsId),
        workspaceId1,
      )
      expect(hasUnread).toBe(true)
    } finally {
      rmSync(FAKE_CRUSH_BIN, { force: true })
      await app.close()
      rmSync(eventDir, { recursive: true, force: true })
    }
  })
})
