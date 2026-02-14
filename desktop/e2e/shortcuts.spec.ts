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
