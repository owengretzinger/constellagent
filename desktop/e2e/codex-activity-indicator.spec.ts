import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')
const FAKE_CODEX_BIN = '/tmp/codex'

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: [appPath], env: { ...process.env, CI_TEST: '1' } })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(1500)
  return { app, window }
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

    const worktreePath = await (window as any).api.git.createWorktree(repo, 'ws-codex', 'branch-codex', true, 'main')
    const workspaceId = crypto.randomUUID()
    store.addWorkspace({
      id: workspaceId,
      name: 'ws-codex',
      branch: 'branch-codex',
      worktreePath,
      projectId,
    })

    const ptyId = await (window as any).api.pty.create(worktreePath, '/bin/bash', { AGENT_ORCH_WS_ID: workspaceId })
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

    const worktreePath1 = await (window as any).api.git.createWorktree(repo, 'ws-codex-a', 'branch-codex-a', true, 'main')
    const workspaceId1 = crypto.randomUUID()
    store.addWorkspace({
      id: workspaceId1,
      name: 'ws-codex-a',
      branch: 'branch-codex-a',
      worktreePath: worktreePath1,
      projectId,
    })
    const ptyId1 = await (window as any).api.pty.create(worktreePath1, '/bin/bash', { AGENT_ORCH_WS_ID: workspaceId1 })
    store.addTab({
      id: crypto.randomUUID(),
      workspaceId: workspaceId1,
      type: 'terminal',
      title: 'Terminal',
      ptyId: ptyId1,
    })

    const worktreePath2 = await (window as any).api.git.createWorktree(repo, 'ws-codex-b', 'branch-codex-b', true, 'main')
    const workspaceId2 = crypto.randomUUID()
    store.addWorkspace({
      id: workspaceId2,
      name: 'ws-codex-b',
      branch: 'branch-codex-b',
      worktreePath: worktreePath2,
      projectId,
    })
    const ptyId2 = await (window as any).api.pty.create(worktreePath2, '/bin/bash', { AGENT_ORCH_WS_ID: workspaceId2 })
    store.addTab({
      id: crypto.randomUUID(),
      workspaceId: workspaceId2,
      type: 'terminal',
      title: 'Terminal',
      ptyId: ptyId2,
    })

    // Keep ws-b selected while ws-a runs in background.
    store.setActiveWorkspace(workspaceId2)

    return { workspaceId1, workspaceId2, ptyId1, ptyId2 }
  }, repoPath)
}

test.describe('Codex activity indicator', () => {
  test('marks workspace active while codex process runs and clears when done', async () => {
    const repoPath = createTestRepo('codex-activity')
    const { app, window } = await launchApp()

    try {
      const { workspaceId, ptyId } = await setupWorkspace(window, repoPath)
      await window.waitForTimeout(800)

      await window.evaluate(({ ptyId: id, fakeCodexPath }) => {
        ;(window as any).api.pty.write(
          id,
          `SLEEP_BIN="$(command -v sleep)" && ln -sf "$SLEEP_BIN" "${fakeCodexPath}" && "${fakeCodexPath}" 2\n`
        )
      }, { ptyId, fakeCodexPath: FAKE_CODEX_BIN })

      await window.waitForTimeout(300)
      await window.evaluate((id: string) => {
        ;(window as any).api.pty.write(id, '\n')
      }, ptyId)

      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().activeClaudeWorkspaceIds.has(wsId),
        workspaceId,
        { timeout: 5000 }
      )

      await window.waitForTimeout(2200)
      await window.evaluate(({ ptyId: id, wsId }) => {
        ;(window as any).api.pty.write(
          id,
          `mkdir -p /tmp/constellagent-notify && echo "${wsId}" > /tmp/constellagent-notify/test-$(date +%s%N)-$$ && rm -f /tmp/constellagent-activity/${wsId}\n`
        )
      }, { ptyId, wsId: workspaceId })

      await window.waitForFunction(
        (wsId: string) => !(window as any).__store.getState().activeClaudeWorkspaceIds.has(wsId),
        workspaceId,
        { timeout: 10000 }
      )

      const isActive = await window.evaluate((wsId: string) => {
        return (window as any).__store.getState().activeClaudeWorkspaceIds.has(wsId)
      }, workspaceId)
      expect(isActive).toBe(false)
    } finally {
      rmSync(FAKE_CODEX_BIN, { force: true })
      await app.close()
    }
  })

  test('marks background workspace unread when activity transitions to done', async () => {
    const repoPath = createTestRepo('codex-unread')
    const { app, window } = await launchApp()

    try {
      const { workspaceId1, workspaceId2, ptyId1 } = await setupTwoWorkspaces(window, repoPath)
      await window.waitForTimeout(800)

      await window.evaluate(({ ptyId: id, fakeCodexPath }) => {
        ;(window as any).api.pty.write(
          id,
          `SLEEP_BIN="$(command -v sleep)" && ln -sf "$SLEEP_BIN" "${fakeCodexPath}" && "${fakeCodexPath}" 2\n`
        )
      }, { ptyId: ptyId1, fakeCodexPath: FAKE_CODEX_BIN })

      await window.waitForTimeout(300)
      await window.evaluate((id: string) => {
        ;(window as any).api.pty.write(id, '\n')
      }, ptyId1)

      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().activeClaudeWorkspaceIds.has(wsId),
        workspaceId1,
        { timeout: 5000 }
      )

      // Ensure ws-b is still selected while ws-a finishes.
      await window.evaluate((wsId: string) => {
        ;(window as any).__store.getState().setActiveWorkspace(wsId)
      }, workspaceId2)

      await window.waitForTimeout(2200)
      await window.evaluate(({ ptyId: id, wsId }) => {
        ;(window as any).api.pty.write(
          id,
          `rm -f /tmp/constellagent-activity/${wsId}\n`
        )
      }, { ptyId: ptyId1, wsId: workspaceId1 })

      await window.waitForFunction(
        (wsId: string) => !(window as any).__store.getState().activeClaudeWorkspaceIds.has(wsId),
        workspaceId1,
        { timeout: 10000 }
      )

      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(wsId),
        workspaceId1,
        { timeout: 5000 }
      )

      const hasUnread = await window.evaluate((wsId: string) => {
        return (window as any).__store.getState().unreadWorkspaceIds.has(wsId)
      }, workspaceId1)
      expect(hasUnread).toBe(true)
    } finally {
      rmSync(FAKE_CODEX_BIN, { force: true })
      await app.close()
    }
  })
})
