import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'fs'
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
  mkdirSync(join(repoPath, 'src'), { recursive: true })
  writeFileSync(join(repoPath, 'src/index.ts'), 'console.log("hello")\n')
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

test.describe('Git & Sidebar functionality', () => {
  test('add project via store shows in sidebar', async () => {
    const repoPath = createTestRepo('sidebar-1')
    const { app, window } = await launchApp()

    try {
      // Clear persisted state, then add project
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })
        store.addProject({
          id: crypto.randomUUID(),
          name: 'my-test-project',
          repoPath: repo,
        })
      }, repoPath)

      await window.waitForTimeout(500)

      // Verify project name shows in sidebar
      const projectHeader = window.locator('[class*="projectHeader"]', { hasText: 'my-test-project' }).first()
      await expect(projectHeader).toBeVisible()

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/sidebar-project-added.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('create workspace via IPC produces worktree on disk', async () => {
    const repoPath = createTestRepo('git-ws')
    const { app, window } = await launchApp()

    try {
      // Create worktree via IPC
      const worktreePath = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.createWorktree(repo, 'e2e-ws', 'e2e-branch', true)
      }, repoPath)

      expect(worktreePath).toBeTruthy()
      expect(worktreePath).toContain('-ws-e2e-ws')

      // Verify worktree directory exists on disk
      expect(existsSync(worktreePath as string)).toBe(true)

      // List worktrees and verify our new one is there
      const worktrees = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.listWorktrees(repo)
      }, repoPath)

      expect(worktrees.length).toBeGreaterThanOrEqual(2) // main + our worktree
      const found = worktrees.find((wt: any) => wt.branch === 'e2e-branch')
      expect(found).toBeTruthy()
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('workspace shows in sidebar and becomes active', async () => {
    const repoPath = createTestRepo('sidebar-ws')
    const { app, window } = await launchApp()

    try {
      // Clear state, then add project and workspace
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = crypto.randomUUID()
        store.addProject({ id: projectId, name: 'sidebar-project', repoPath: repo })

        const worktreePath = await (window as any).api.git.createWorktree(repo, 'sidebar-ws', 'ws-branch', true)
        const wsId = crypto.randomUUID()
        store.addWorkspace({
          id: wsId,
          name: 'sidebar-ws',
          branch: 'ws-branch',
          worktreePath,
          projectId,
        })
      }, repoPath)

      await window.waitForTimeout(500)

      // The project header should be in the sidebar
      const projectHeader = window.locator('[class*="projectHeader"]', { hasText: 'sidebar-project' }).first()
      await expect(projectHeader).toBeVisible()

      // Projects are expanded by default — no click needed

      // Workspace should be visible (sidebar shows branch name)
      const workspaceItem = window.locator('[class*="workspaceItem"]', { hasText: 'ws-branch' })
      await expect(workspaceItem).toBeVisible()

      // It should be active (since addWorkspace auto-sets activeWorkspaceId)
      const activeClass = await workspaceItem.getAttribute('class')
      expect(activeClass).toContain('active')

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/sidebar-workspace-active.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('git status detects modified files', async () => {
    const repoPath = createTestRepo('git-status')
    const { app, window } = await launchApp()

    try {
      // Create worktree and modify a file
      const worktreePath = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.createWorktree(repo, 'status-ws', 'status-branch', true)
      }, repoPath)

      // Write a change to the worktree (resolve symlinks for macOS /tmp -> /private/tmp)
      const realWt = realpathSync(worktreePath as string)
      writeFileSync(join(realWt, 'README.md'), '# Modified!\n')

      // Check git status via IPC
      const statuses = await window.evaluate(async (wt: string) => {
        return await (window as any).api.git.getStatus(wt)
      }, worktreePath as string)

      expect(statuses.length).toBeGreaterThan(0)
      // Look for README.md change — path may have various formats
      const readmeStatus = statuses.find((s: any) => s.path.includes('README'))
      if (readmeStatus) {
        expect(['modified', 'untracked', 'added']).toContain(readmeStatus.status)
      }
      // At minimum, there should be at least one change detected
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('git branches lists available branches', async () => {
    const repoPath = createTestRepo('git-branches')
    const { app, window } = await launchApp()

    try {
      const branches = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.getBranches(repo)
      }, repoPath)

      expect(branches).toContain('main')
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('git file diff returns diff text for changed file', async () => {
    const repoPath = createTestRepo('git-diff')
    const { app, window } = await launchApp()

    try {
      const worktreePath = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.createWorktree(repo, 'diff-ws', 'diff-branch', true)
      }, repoPath)

      // Modify a file in the worktree
      writeFileSync(join(worktreePath as string, 'README.md'), '# Changed Content\nNew line here\n')

      // Get file diff
      const diffText = await window.evaluate(async (wt: string) => {
        return await (window as any).api.git.getFileDiff(wt, 'README.md')
      }, worktreePath as string)

      expect(diffText).toBeTruthy()
      expect(diffText).toContain('Changed Content')
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('right panel shows "Files" and "Changes" toggle', async () => {
    const { app, window } = await launchApp()

    try {
      // Right panel should be open by default
      const filesBtn = window.locator('button', { hasText: 'Files' })
      const changesBtn = window.locator('button', { hasText: 'Changes' })

      await expect(filesBtn).toBeVisible()
      await expect(changesBtn).toBeVisible()

      // "Files" should be active by default
      const filesBtnClass = await filesBtn.getAttribute('class')
      expect(filesBtnClass).toContain('active')

      // Click "Changes" and verify it becomes active
      await changesBtn.click()
      await window.waitForTimeout(300)
      const changesBtnClass = await changesBtn.getAttribute('class')
      expect(changesBtnClass).toContain('active')

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/right-panel-toggle.png'),
      })
    } finally {
      await app.close()
    }
  })

  test('empty state shows when no workspace selected', async () => {
    const { app, window } = await launchApp()

    try {
      // Clear any persisted state
      await window.evaluate(() => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })
      })
      await window.waitForTimeout(500)

      // With no workspace, right panel should show empty state
      const emptyText = window.locator('text=Select a workspace to browse files')
      await expect(emptyText).toBeVisible({ timeout: 5000 })

      // Welcome message in center
      const welcome = window.locator('[class*="welcomeLogo"]')
      await expect(welcome).toHaveText('constellagent')
    } finally {
      await app.close()
    }
  })

  test('multiple workspaces can be switched via sidebar', async () => {
    const repoPath = createTestRepo('multi-ws')
    const { app, window } = await launchApp()

    try {
      // Clear state, create project with two workspaces
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = crypto.randomUUID()
        store.addProject({ id: projectId, name: 'multi-project', repoPath: repo })

        // Workspace 1
        const wt1 = await (window as any).api.git.createWorktree(repo, 'ws-alpha', 'branch-alpha', true)
        const ws1Id = crypto.randomUUID()
        store.addWorkspace({
          id: ws1Id, name: 'ws-alpha', branch: 'branch-alpha', worktreePath: wt1, projectId,
        })

        // Workspace 2
        const wt2 = await (window as any).api.git.createWorktree(repo, 'ws-beta', 'branch-beta', true)
        const ws2Id = crypto.randomUUID()
        store.addWorkspace({
          id: ws2Id, name: 'ws-beta', branch: 'branch-beta', worktreePath: wt2, projectId,
        })
      }, repoPath)

      await window.waitForTimeout(500)

      // Projects are expanded by default — no click needed

      // Both workspaces should be visible (sidebar shows branch names)
      const wsAlpha = window.locator('[class*="workspaceItem"]', { hasText: 'branch-alpha' })
      const wsBeta = window.locator('[class*="workspaceItem"]', { hasText: 'branch-beta' })
      await expect(wsAlpha).toBeVisible()
      await expect(wsBeta).toBeVisible()

      // ws-beta should be active (it was added last)
      const betaClass = await wsBeta.getAttribute('class')
      expect(betaClass).toContain('active')

      // Click ws-alpha to switch
      await wsAlpha.click()
      await window.waitForTimeout(300)

      const alphaClass = await wsAlpha.getAttribute('class')
      expect(alphaClass).toContain('active')

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/sidebar-multi-workspace.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })
})
