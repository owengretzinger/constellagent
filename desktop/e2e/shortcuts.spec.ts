import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: [appPath], env: { ...process.env, CI_TEST: '1' } })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(1500)
  return { app, window }
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

async function setupWorkspaceWithTerminal(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const worktreePath = await (window as any).api.git.createWorktree(repo, 'ws-1', 'branch-1', true)

    const wsId = crypto.randomUUID()
    store.addWorkspace({
      id: wsId, name: 'ws-1', branch: 'branch-1', worktreePath, projectId,
    })

    const ptyId = await (window as any).api.pty.create(worktreePath)
    store.addTab({
      id: crypto.randomUUID(), workspaceId: wsId, type: 'terminal', title: 'Terminal 1', ptyId,
    })

    return { ptyId, wsId, worktreePath, projectId }
  }, repoPath)
}

async function setupTwoWorkspacesWithTerminals(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const worktreePath1 = await (window as any).api.git.createWorktree(repo, 'ws-1', 'branch-1', true)
    const ws1Id = crypto.randomUUID()
    store.addWorkspace({
      id: ws1Id, name: 'ws-1', branch: 'branch-1', worktreePath: worktreePath1, projectId,
    })
    const ptyId1 = await (window as any).api.pty.create(worktreePath1)
    store.addTab({
      id: crypto.randomUUID(), workspaceId: ws1Id, type: 'terminal', title: 'Terminal 1', ptyId: ptyId1,
    })

    const worktreePath2 = await (window as any).api.git.createWorktree(repo, 'ws-2', 'branch-2', true)
    const ws2Id = crypto.randomUUID()
    store.addWorkspace({
      id: ws2Id, name: 'ws-2', branch: 'branch-2', worktreePath: worktreePath2, projectId,
    })
    const ptyId2 = await (window as any).api.pty.create(worktreePath2)
    store.addTab({
      id: crypto.randomUUID(), workspaceId: ws2Id, type: 'terminal', title: 'Terminal 1', ptyId: ptyId2,
    })

    return { ws1Id, ws2Id }
  }, repoPath)
}

async function setupTwoProjectsWithOneWorkspaceEach(window: Page, repoA: string, repoB: string) {
  return await window.evaluate(async ({ repoA, repoB }: { repoA: string; repoB: string }) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectAId = crypto.randomUUID()
    store.addProject({ id: projectAId, name: 'project-alpha', repoPath: repoA })
    const worktreeA = await (window as any).api.git.createWorktree(repoA, 'ws-alpha', 'branch-alpha', true)
    const wsAId = crypto.randomUUID()
    store.addWorkspace({
      id: wsAId, name: 'ws-alpha', branch: 'branch-alpha', worktreePath: worktreeA, projectId: projectAId,
    })
    const ptyA = await (window as any).api.pty.create(worktreeA)
    store.addTab({
      id: crypto.randomUUID(), workspaceId: wsAId, type: 'terminal', title: 'Terminal 1', ptyId: ptyA,
    })

    const projectBId = crypto.randomUUID()
    store.addProject({ id: projectBId, name: 'project-beta', repoPath: repoB })
    const worktreeB = await (window as any).api.git.createWorktree(repoB, 'ws-beta', 'branch-beta', true)
    const wsBId = crypto.randomUUID()
    store.addWorkspace({
      id: wsBId, name: 'ws-beta', branch: 'branch-beta', worktreePath: worktreeB, projectId: projectBId,
    })
    const ptyB = await (window as any).api.pty.create(worktreeB)
    store.addTab({
      id: crypto.randomUUID(), workspaceId: wsBId, type: 'terminal', title: 'Terminal 1', ptyId: ptyB,
    })

    return { wsAId, wsBId }
  }, { repoA, repoB })
}

test.describe('Keyboard shortcuts', () => {
  test('Cmd+T creates new terminal tab', async () => {
    const repoPath = createTestRepo('shortcut-t')
    const { app, window } = await launchApp()

    try {
      await setupWorkspaceWithTerminal(window, repoPath)
      await window.waitForTimeout(2000)

      const tabsBefore = await window.locator('[class*="tabTitle"]').count()
      expect(tabsBefore).toBe(1)

      // Press Cmd+T
      await window.keyboard.press('Meta+t')
      await window.waitForTimeout(2000)

      const tabsAfter = await window.locator('[class*="tabTitle"]').count()
      expect(tabsAfter).toBe(2)
    } finally {
      await app.close()
    }
  })

  test('Cmd+1/Cmd+2 switches between tabs', async () => {
    const repoPath = createTestRepo('shortcut-num')
    const { app, window } = await launchApp()

    try {
      await setupWorkspaceWithTerminal(window, repoPath)
      await window.waitForTimeout(2000)

      // Create a second terminal via Cmd+T
      await window.keyboard.press('Meta+t')
      await window.waitForTimeout(2000)

      // Should now have 2 tabs, with tab 2 active
      const tabCount = await window.locator('[class*="tabTitle"]').count()
      expect(tabCount).toBe(2)

      // Get active tab title
      const activeTitle2 = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        const tab = s.tabs.find((t: any) => t.id === s.activeTabId)
        return tab?.title
      })
      expect(activeTitle2).toBe('Terminal 2')

      // Press Cmd+1 — switch to first tab
      await window.keyboard.press('Meta+1')
      await window.waitForTimeout(500)

      const activeTitle1 = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        const tab = s.tabs.find((t: any) => t.id === s.activeTabId)
        return tab?.title
      })
      expect(activeTitle1).toBe('Terminal 1')

      // Press Cmd+2 — switch back to second tab
      await window.keyboard.press('Meta+2')
      await window.waitForTimeout(500)

      const activeTitleBack = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        const tab = s.tabs.find((t: any) => t.id === s.activeTabId)
        return tab?.title
      })
      expect(activeTitleBack).toBe('Terminal 2')
    } finally {
      await app.close()
    }
  })

  test('Ctrl+1/Ctrl+2 switches workspaces', async () => {
    const repoPath = createTestRepo('shortcut-workspace-default')
    const { app, window } = await launchApp()

    try {
      const { ws1Id, ws2Id } = await setupTwoWorkspacesWithTerminals(window, repoPath)
      await window.waitForTimeout(2000)

      // Second workspace is active after setup
      expect(await window.evaluate(() => (window as any).__store.getState().activeWorkspaceId)).toBe(ws2Id)

      await window.keyboard.press('Control+1')
      await window.waitForTimeout(500)
      expect(await window.evaluate(() => (window as any).__store.getState().activeWorkspaceId)).toBe(ws1Id)

      await window.keyboard.press('Control+2')
      await window.waitForTimeout(500)
      expect(await window.evaluate(() => (window as any).__store.getState().activeWorkspaceId)).toBe(ws2Id)
    } finally {
      await app.close()
    }
  })

  test('Custom workspace shortcut switches workspace', async () => {
    const repoPath = createTestRepo('shortcut-workspace-custom')
    const { app, window } = await launchApp()

    try {
      const { ws1Id, ws2Id } = await setupTwoWorkspacesWithTerminals(window, repoPath)
      await window.waitForTimeout(2000)

      await window.evaluate(() => {
        const store = (window as any).__store.getState()
        const shortcuts = store.settings.shortcuts
        const workspaceByIndex = [...shortcuts.workspaceByIndex]
        workspaceByIndex[0] = {
          code: 'Digit7',
          meta: false,
          ctrl: true,
          shift: false,
          alt: false,
        }
        store.updateSettings({
          shortcuts: {
            ...shortcuts,
            workspaceByIndex,
          },
        })
      })

      expect(await window.evaluate(() => (window as any).__store.getState().activeWorkspaceId)).toBe(ws2Id)

      await window.keyboard.press('Control+7')
      await window.waitForTimeout(500)
      expect(await window.evaluate(() => (window as any).__store.getState().activeWorkspaceId)).toBe(ws1Id)
    } finally {
      await app.close()
    }
  })

  test('collapsed project is excluded from workspace index shortcuts', async () => {
    const repoA = createTestRepo('shortcut-index-collapsed-a')
    const repoB = createTestRepo('shortcut-index-collapsed-b')
    const { app, window } = await launchApp()

    try {
      const { wsBId } = await setupTwoProjectsWithOneWorkspaceEach(window, repoA, repoB)
      await window.waitForTimeout(2000)

      const projectAlphaHeader = window.locator('[class*="projectHeader"]', { hasText: 'project-alpha' }).first()
      await projectAlphaHeader.click()
      await window.waitForTimeout(300)

      // Only project-beta workspace is visible; Ctrl+1 should target it.
      await window.keyboard.press('Control+1')
      await window.waitForTimeout(500)
      expect(await window.evaluate(() => (window as any).__store.getState().activeWorkspaceId)).toBe(wsBId)

      // With one visible workspace, Ctrl+2 should be a no-op.
      await window.keyboard.press('Control+2')
      await window.waitForTimeout(500)
      expect(await window.evaluate(() => (window as any).__store.getState().activeWorkspaceId)).toBe(wsBId)
    } finally {
      await app.close()
    }
  })

  test('Cmd+W closes active tab', async () => {
    const repoPath = createTestRepo('shortcut-w')
    const { app, window } = await launchApp()

    try {
      await setupWorkspaceWithTerminal(window, repoPath)
      await window.waitForTimeout(2000)

      // Create second tab
      await window.keyboard.press('Meta+t')
      await window.waitForTimeout(2000)
      expect(await window.locator('[class*="tabTitle"]').count()).toBe(2)

      // Press Cmd+W — close active tab
      await window.keyboard.press('Meta+w')
      await window.waitForTimeout(1000)

      expect(await window.locator('[class*="tabTitle"]').count()).toBe(1)
    } finally {
      await app.close()
    }
  })

  test('Cmd+B toggles sidebar', async () => {
    const { app, window } = await launchApp()

    try {
      // Sidebar should be visible initially
      const sidebar = window.locator('[class*="sidebar"]').first()
      await expect(sidebar).toBeVisible()

      // Press Cmd+B — hide sidebar
      await window.keyboard.press('Meta+b')
      await window.waitForTimeout(500)

      await expect(sidebar).not.toBeVisible()

      // Press Cmd+B again — show sidebar
      await window.keyboard.press('Meta+b')
      await window.waitForTimeout(500)

      await expect(sidebar).toBeVisible()
    } finally {
      await app.close()
    }
  })

  test('Cmd+Shift+[ and Cmd+Shift+] cycle tabs', async () => {
    const repoPath = createTestRepo('shortcut-brackets')
    const { app, window } = await launchApp()

    try {
      await setupWorkspaceWithTerminal(window, repoPath)
      await window.waitForTimeout(2000)

      // Create second tab
      await window.keyboard.press('Meta+t')
      await window.waitForTimeout(2000)

      // Active should be Terminal 2
      let active = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        return s.tabs.find((t: any) => t.id === s.activeTabId)?.title
      })
      expect(active).toBe('Terminal 2')

      // Cmd+Shift+[ — previous tab
      await window.keyboard.press('Meta+Shift+[')
      await window.waitForTimeout(500)

      active = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        return s.tabs.find((t: any) => t.id === s.activeTabId)?.title
      })
      expect(active).toBe('Terminal 1')

      // Cmd+Shift+] — next tab
      await window.keyboard.press('Meta+Shift+]')
      await window.waitForTimeout(500)

      active = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        return s.tabs.find((t: any) => t.id === s.activeTabId)?.title
      })
      expect(active).toBe('Terminal 2')
    } finally {
      await app.close()
    }
  })

  test('Cmd+J focuses terminal or creates one', async () => {
    const repoPath = createTestRepo('shortcut-j')
    const { app, window } = await launchApp()

    try {
      // Set up workspace with NO terminal (just project + workspace, no tab)
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = crypto.randomUUID()
        store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

        const worktreePath = await (window as any).api.git.createWorktree(repo, 'ws-j', 'branch-j', true)

        store.addWorkspace({
          id: crypto.randomUUID(), name: 'ws-j', branch: 'branch-j', worktreePath, projectId,
        })
      }, repoPath)
      await window.waitForTimeout(1000)

      // No tabs
      expect(await window.locator('[class*="tabTitle"]').count()).toBe(0)

      // Press Cmd+J — should create a terminal
      await window.keyboard.press('Meta+j')
      await window.waitForTimeout(2000)

      expect(await window.locator('[class*="tabTitle"]').count()).toBe(1)
    } finally {
      await app.close()
    }
  })

  test('Shift+Tab keeps focus in terminal', async () => {
    const repoPath = createTestRepo('shortcut-shifttab')
    const { app, window } = await launchApp()

    try {
      await setupWorkspaceWithTerminal(window, repoPath)
      await window.waitForTimeout(3000)

      // Focus the terminal
      const termInner = window.locator('[class*="terminalInner"]').first()
      await termInner.click()
      await window.waitForTimeout(500)

      expect(await window.evaluate(() =>
        !!document.activeElement?.closest('[class*="terminalInner"]')
      )).toBe(true)

      await window.keyboard.press('Shift+Tab')
      await window.waitForTimeout(500)

      // Focus should still be inside the terminal (not navigated away)
      expect(await window.evaluate(() =>
        !!document.activeElement?.closest('[class*="terminalInner"]')
      )).toBe(true)
    } finally {
      await app.close()
    }
  })
})
