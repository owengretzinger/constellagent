import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: [appPath], env: { ...process.env, CI_TEST: '1', ELECTRON_RENDERER_URL: '' } })
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

function cleanupTestRepo(repoPath: string): void {
  try {
    if (existsSync(repoPath)) {
      rmSync(repoPath, { recursive: true, force: true })
    }
    const parentDir = resolve(repoPath, '..')
    const repoName = repoPath.split('/').pop()
    if (repoName) {
      const entries = readdirSync(parentDir)
      for (const entry of entries) {
        if (entry.startsWith(`${repoName}-ws-`)) {
          rmSync(join(parentDir, entry), { recursive: true, force: true })
        }
      }
    }
  } catch {
    // best effort
  }
}

test.describe('Workspace project sections should not auto-collapse', () => {
  test('switching workspaces across projects keeps both projects expanded', async () => {
    const repoA = createTestRepo('collapse-a')
    const repoB = createTestRepo('collapse-b')
    const { app, window } = await launchApp()

    try {
      // Set up two projects, each with a workspace
      await window.evaluate(async ({ repoA, repoB }: { repoA: string; repoB: string }) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projAId = crypto.randomUUID()
        store.addProject({ id: projAId, name: 'project-alpha', repoPath: repoA })
        const wtA = await (window as any).api.git.createWorktree(repoA, 'ws-a1', 'branch-a1', true)
        store.addWorkspace({
          id: crypto.randomUUID(), name: 'ws-a1', branch: 'branch-a1', worktreePath: wtA, projectId: projAId,
        })

        const projBId = crypto.randomUUID()
        store.addProject({ id: projBId, name: 'project-beta', repoPath: repoB })
        const wtB = await (window as any).api.git.createWorktree(repoB, 'ws-b1', 'branch-b1', true)
        store.addWorkspace({
          id: crypto.randomUUID(), name: 'ws-b1', branch: 'branch-b1', worktreePath: wtB, projectId: projBId,
        })
      }, { repoA, repoB })

      await window.waitForTimeout(1000)

      // Both projects should be expanded (all projects default to expanded)
      // Use branch names for locators since that's what appears in the DOM text
      const wsA = window.locator('[class*="workspaceItem"]', { hasText: 'branch-a1' })
      const wsB = window.locator('[class*="workspaceItem"]', { hasText: 'branch-b1' })
      await expect(wsA).toBeVisible()
      await expect(wsB).toBeVisible()

      // Click ws-a1 to activate project-alpha
      await wsA.click()
      await window.waitForTimeout(300)

      // Both projects should still be expanded
      await expect(wsA).toBeVisible()
      await expect(wsB).toBeVisible()

      // Now click ws-b1 to switch to project-beta
      await wsB.click()
      await window.waitForTimeout(300)

      // CRITICAL: project-alpha should NOT have collapsed — ws-a1 must still be visible
      await expect(wsA).toBeVisible()
      await expect(wsB).toBeVisible()
    } finally {
      await app.close()
      cleanupTestRepo(repoA)
      cleanupTestRepo(repoB)
    }
  })

  test('keyboard workspace cycling keeps all projects expanded', async () => {
    const repoA = createTestRepo('collapse-kb-a')
    const repoB = createTestRepo('collapse-kb-b')
    const { app, window } = await launchApp()

    try {
      // Set up two projects, each with a workspace
      await window.evaluate(async ({ repoA, repoB }: { repoA: string; repoB: string }) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projAId = crypto.randomUUID()
        store.addProject({ id: projAId, name: 'project-alpha', repoPath: repoA })
        const wtA = await (window as any).api.git.createWorktree(repoA, 'ws-kb-a', 'branch-kb-a', true)
        store.addWorkspace({
          id: crypto.randomUUID(), name: 'ws-kb-a', branch: 'branch-kb-a', worktreePath: wtA, projectId: projAId,
        })

        const projBId = crypto.randomUUID()
        store.addProject({ id: projBId, name: 'project-beta', repoPath: repoB })
        const wtB = await (window as any).api.git.createWorktree(repoB, 'ws-kb-b', 'branch-kb-b', true)
        store.addWorkspace({
          id: crypto.randomUUID(), name: 'ws-kb-b', branch: 'branch-kb-b', worktreePath: wtB, projectId: projBId,
        })
      }, { repoA, repoB })

      await window.waitForTimeout(1000)

      // Both workspaces visible (use branch names for locators)
      const wsA = window.locator('[class*="workspaceItem"]', { hasText: 'branch-kb-a' })
      const wsB = window.locator('[class*="workspaceItem"]', { hasText: 'branch-kb-b' })
      await expect(wsA).toBeVisible()
      await expect(wsB).toBeVisible()

      // ws-kb-b is active (added last). Use Ctrl+Shift+ArrowUp to go to previous workspace
      await window.keyboard.press('Control+Shift+ArrowUp')
      await window.waitForTimeout(300)

      // Verify active workspace changed
      const activeWsName = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        const ws = s.workspaces.find((w: any) => w.id === s.activeWorkspaceId)
        return ws?.name
      })
      expect(activeWsName).toBe('ws-kb-a')

      // CRITICAL: both projects should still be expanded
      await expect(wsA).toBeVisible()
      await expect(wsB).toBeVisible()

      // Cycle forward
      await window.keyboard.press('Control+Shift+ArrowDown')
      await window.waitForTimeout(300)

      // Still both visible
      await expect(wsA).toBeVisible()
      await expect(wsB).toBeVisible()
    } finally {
      await app.close()
      cleanupTestRepo(repoA)
      cleanupTestRepo(repoB)
    }
  })

  test('manually collapsed project stays collapsed when switching workspaces', async () => {
    const repoA = createTestRepo('collapse-manual-a')
    const repoB = createTestRepo('collapse-manual-b')
    const { app, window } = await launchApp()

    try {
      await window.evaluate(async ({ repoA, repoB }: { repoA: string; repoB: string }) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projAId = crypto.randomUUID()
        store.addProject({ id: projAId, name: 'project-alpha', repoPath: repoA })
        const wtA = await (window as any).api.git.createWorktree(repoA, 'ws-man-a', 'branch-man-a', true)
        store.addWorkspace({
          id: crypto.randomUUID(), name: 'ws-man-a', branch: 'branch-man-a', worktreePath: wtA, projectId: projAId,
        })

        const projBId = crypto.randomUUID()
        store.addProject({ id: projBId, name: 'project-beta', repoPath: repoB })
        const wtB = await (window as any).api.git.createWorktree(repoB, 'ws-man-b', 'branch-man-b', true)
        store.addWorkspace({
          id: crypto.randomUUID(), name: 'ws-man-b', branch: 'branch-man-b', worktreePath: wtB, projectId: projBId,
        })
      }, { repoA, repoB })

      await window.waitForTimeout(1000)

      // Click project-alpha header to collapse it
      const projAlphaHeader = window.locator('[class*="projectHeader"]', { hasText: 'project-alpha' }).first()
      await projAlphaHeader.click()
      await window.waitForTimeout(300)

      // ws-man-a should now be hidden, ws-man-b still visible (use branch names)
      const wsA = window.locator('[class*="workspaceItem"]', { hasText: 'branch-man-a' })
      const wsB = window.locator('[class*="workspaceItem"]', { hasText: 'branch-man-b' })
      await expect(wsA).not.toBeVisible()
      await expect(wsB).toBeVisible()

      // Use keyboard to cycle workspaces (this will activate ws-man-a)
      await window.keyboard.press('Control+Shift+ArrowUp')
      await window.waitForTimeout(300)

      // project-alpha should stay collapsed since user manually collapsed it
      await expect(wsA).not.toBeVisible()
      await expect(wsB).toBeVisible()
    } finally {
      await app.close()
      cleanupTestRepo(repoA)
      cleanupTestRepo(repoB)
    }
  })
})
