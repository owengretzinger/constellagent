import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')
const TMP_DIR = '/tmp'

async function launchApp(
  label: string
): Promise<{ app: ElectronApplication; window: Page; notifyDir: string; activityDir: string }> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const notifyDir = join(TMP_DIR, `constellagent-notify-${suffix}`)
  const activityDir = join(TMP_DIR, `constellagent-activity-${suffix}`)
  const app = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      CI_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      CONSTELLAGENT_NOTIFY_DIR: notifyDir,
      CONSTELLAGENT_ACTIVITY_DIR: activityDir,
    },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(1500)
  return { app, window, notifyDir, activityDir }
}

function createTestRepo(name: string): string {
  const repoPath = join('/tmp', `test-repo-${name}-${Date.now()}`)
  mkdirSync(repoPath, { recursive: true })
  execSync('git init', { cwd: repoPath })
  execSync('git checkout -b main', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n')
  execSync('git add .', { cwd: repoPath })
  execSync('git commit -m "initial commit"', { cwd: repoPath })
  return repoPath
}

/** Set up two workspaces with terminals. Returns both workspace IDs. Active workspace is ws2. */
async function setupTwoWorkspaces(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    // Workspace 1
    const wt1 = await (window as any).api.git.createWorktree(repo, 'ws-1', 'branch-1', true)
    const ws1Id = crypto.randomUUID()
    store.addWorkspace({ id: ws1Id, name: 'ws-1', branch: 'branch-1', worktreePath: wt1, projectId })
    const pty1Id = await (window as any).api.pty.create(wt1, undefined, { AGENT_ORCH_WS_ID: ws1Id })
    store.addTab({ id: crypto.randomUUID(), workspaceId: ws1Id, type: 'terminal', title: 'Terminal', ptyId: pty1Id })

    // Workspace 2 (becomes active since addWorkspace sets active)
    const wt2 = await (window as any).api.git.createWorktree(repo, 'ws-2', 'branch-2', true)
    const ws2Id = crypto.randomUUID()
    store.addWorkspace({ id: ws2Id, name: 'ws-2', branch: 'branch-2', worktreePath: wt2, projectId })
    const pty2Id = await (window as any).api.pty.create(wt2, undefined, { AGENT_ORCH_WS_ID: ws2Id })
    store.addTab({ id: crypto.randomUUID(), workspaceId: ws2Id, type: 'terminal', title: 'Terminal', ptyId: pty2Id })

    return { ws1Id, ws2Id }
  }, repoPath)
}

/** Set up the IPC listener from the test context (mirrors what App.tsx useEffect does) */
async function setupNotifyListener(window: Page) {
  await window.evaluate(() => {
    ;(window as any).api.agent.onNotifyWorkspace((wsId: string) => {
      const state = (window as any).__store.getState()
      if (wsId !== state.activeWorkspaceId) {
        state.markWorkspaceUnread(wsId)
      }
    })
  })
}

/** Write a signal file to the notification directory, simulating what the hook script does */
function writeSignalFile(workspaceId: string, notifyDir: string): void {
  mkdirSync(notifyDir, { recursive: true })
  const target = join(notifyDir, `test-${Date.now()}-${Math.random()}`)
  const tmpTarget = `${target}.tmp`
  writeFileSync(tmpTarget, `${workspaceId}\n`)
  renameSync(tmpTarget, target)
}

test.describe('Unread indicator', () => {
  test('notification signal marks non-active workspace as unread', async () => {
    const repoPath = createTestRepo('unread-1')
    const { app, window, notifyDir, activityDir } = await launchApp('unread-1')

    try {
      const { ws1Id } = await setupTwoWorkspaces(window, repoPath)
      await setupNotifyListener(window)
      await window.waitForTimeout(500)

      // ws2 is active, write signal file for ws1
      writeSignalFile(ws1Id, notifyDir)

      // Wait for watcher poll (500ms interval) + IPC delivery
      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 5000 }
      )

      const isUnread = await window.evaluate((wsId: string) => {
        return (window as any).__store.getState().unreadWorkspaceIds.has(wsId)
      }, ws1Id)
      expect(isUnread).toBe(true)
    } finally {
      await app.close()
      rmSync(notifyDir, { recursive: true, force: true })
      rmSync(activityDir, { recursive: true, force: true })
    }
  })

  test('switching to unread workspace dismisses indicator', async () => {
    const repoPath = createTestRepo('unread-2')
    const { app, window, notifyDir, activityDir } = await launchApp('unread-2')

    try {
      const { ws1Id } = await setupTwoWorkspaces(window, repoPath)
      await setupNotifyListener(window)
      await window.waitForTimeout(500)

      // Write signal for ws1 (non-active)
      writeSignalFile(ws1Id, notifyDir)

      // Wait for unread to be set
      await window.waitForFunction(
        (wsId: string) => (window as any).__store.getState().unreadWorkspaceIds.has(wsId),
        ws1Id,
        { timeout: 3000 }
      )

      // Switch to ws1
      await window.evaluate((wsId: string) => {
        ;(window as any).__store.getState().setActiveWorkspace(wsId)
      }, ws1Id)
      await window.waitForTimeout(500)

      // Unread should be cleared
      const isUnreadAfter = await window.evaluate((wsId: string) => {
        return (window as any).__store.getState().unreadWorkspaceIds.has(wsId)
      }, ws1Id)
      expect(isUnreadAfter).toBe(false)
    } finally {
      await app.close()
      rmSync(notifyDir, { recursive: true, force: true })
      rmSync(activityDir, { recursive: true, force: true })
    }
  })

  test('notification for active workspace does not show indicator', async () => {
    const repoPath = createTestRepo('unread-3')
    const { app, window, notifyDir, activityDir } = await launchApp('unread-3')

    try {
      const { ws2Id } = await setupTwoWorkspaces(window, repoPath)
      await setupNotifyListener(window)
      await window.waitForTimeout(500)

      // ws2 is active — write signal for ws2
      writeSignalFile(ws2Id, notifyDir)
      await window.waitForTimeout(1500)

      // ws2 should NOT be marked as unread
      const isUnread = await window.evaluate((wsId: string) => {
        return (window as any).__store.getState().unreadWorkspaceIds.has(wsId)
      }, ws2Id)
      expect(isUnread).toBe(false)
    } finally {
      await app.close()
      rmSync(notifyDir, { recursive: true, force: true })
      rmSync(activityDir, { recursive: true, force: true })
    }
  })
})
