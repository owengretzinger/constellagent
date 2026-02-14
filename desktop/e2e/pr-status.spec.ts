import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const { ELECTRON_RENDERER_URL: _ignoredRendererUrl, ...env } = process.env
  const app = await electron.launch({ args: [appPath], env: { ...env, CI_TEST: '1' } })
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

test.describe('PR status indicators', () => {
  test('getPrStatuses returns unavailable for local-only repo', async () => {
    const repoPath = createTestRepo('pr-local')
    const { app, window } = await launchApp()

    try {
      // Local test repo has no GitHub remote — should gracefully return unavailable
      const result = await window.evaluate(async (repo: string) => {
        return await (window as any).api.github.getPrStatuses(repo, ['main'])
      }, repoPath)

      expect(result.available).toBe(false)
      // Should be one of: gh_not_installed or not_github_repo
      expect(['gh_not_installed', 'not_github_repo']).toContain(result.error)
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('store setPrStatuses populates prStatusMap', async () => {
    const { app, window } = await launchApp()

    try {
      const prNumber = await window.evaluate(() => {
        const store = (window as any).__store.getState()
        store.setPrStatuses('proj-1', {
          'feature-branch': {
            number: 42,
            state: 'open',
            title: 'Add feature',
            url: 'https://github.com/test/repo/pull/42',
            checkStatus: 'passing',
            hasPendingComments: false,
            pendingCommentCount: 0,
            isBlockedByCi: false,
            isApproved: false,
            isChangesRequested: false,
            updatedAt: new Date().toISOString(),
          },
        })

        const updated = (window as any).__store.getState()
        const pr = updated.prStatusMap.get('proj-1:feature-branch')
        return pr?.number ?? null
      })

      expect(prNumber).toBe(42)
    } finally {
      await app.close()
    }
  })

  test('store setGhAvailability tracks per-project availability', async () => {
    const { app, window } = await launchApp()

    try {
      const result = await window.evaluate(() => {
        const store = (window as any).__store.getState()
        store.setGhAvailability('proj-1', true)
        store.setGhAvailability('proj-2', false)

        const updated = (window as any).__store.getState()
        return {
          proj1: updated.ghAvailability.get('proj-1'),
          proj2: updated.ghAvailability.get('proj-2'),
        }
      })

      expect(result.proj1).toBe(true)
      expect(result.proj2).toBe(false)
    } finally {
      await app.close()
    }
  })

  test('PR badge renders in sidebar when store has PR data', async () => {
    const repoPath = createTestRepo('pr-badge')
    const { app, window } = await launchApp()

    try {
      // Set up project and workspace first
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = 'test-proj-id'
        store.addProject({ id: projectId, name: 'pr-test-project', repoPath: repo })

        store.addWorkspace({
          id: crypto.randomUUID(),
          name: 'main-ws',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })
      }, repoPath)

      // Wait for the poller's initial run to settle so injected state isn't immediately overwritten.
      await window.waitForTimeout(2500)

      // Now inject PR data after the poller has settled
      await window.evaluate(() => {
        const store = (window as any).__store.getState()
        const ws = store.workspaces.find((w: { projectId: string }) => w.projectId === 'test-proj-id')
        const branch = ws?.branch ?? 'main'
        store.setGhAvailability('test-proj-id', true)
        store.setPrStatuses('test-proj-id', {
          [branch]: {
            number: 99,
            state: 'open',
            title: 'My cool PR',
            url: 'https://github.com/test/repo/pull/99',
            checkStatus: 'passing',
            hasPendingComments: false,
            pendingCommentCount: 0,
            isBlockedByCi: false,
            isApproved: false,
            isChangesRequested: false,
            updatedAt: new Date().toISOString(),
          },
        })
      })

      await window.waitForTimeout(500)

      // PR badge should be visible in sidebar with #99
      const prBadge = window.locator('[class*="prInline"]')
      await expect(prBadge).toBeVisible({ timeout: 3000 })

      const prText = await prBadge.textContent()
      expect(prText).toContain('#99')

      // Badge should carry open-state styling.
      await expect(prBadge).toHaveClass(/pr_open/)
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('PR badge does not render when ghAvailability is false', async () => {
    const repoPath = createTestRepo('pr-no-gh')
    const { app, window } = await launchApp()

    try {
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = 'test-proj-nope'
        store.addProject({ id: projectId, name: 'no-gh-project', repoPath: repo })
        store.addWorkspace({
          id: crypto.randomUUID(),
          name: 'main',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })

        // Set gh as unavailable — PR badge should not render
        store.setGhAvailability(projectId, false)
        store.setPrStatuses(projectId, {
          main: {
            number: 50,
            state: 'open',
            title: 'Should not show',
            url: 'https://github.com/test/repo/pull/50',
            checkStatus: 'passing',
            hasPendingComments: false,
            pendingCommentCount: 0,
            isBlockedByCi: false,
            isApproved: false,
            isChangesRequested: false,
            updatedAt: new Date().toISOString(),
          },
        })
      }, repoPath)

      await window.waitForTimeout(500)

      const prBadge = window.locator('[class*="prInline"]')
      await expect(prBadge).not.toBeVisible()
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('open PR shows pending comments and CI blocked badges', async () => {
    const repoPath = createTestRepo('pr-signals-blocked')
    const { app, window } = await launchApp()

    try {
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = 'test-proj-signals-blocked'
        store.addProject({ id: projectId, name: 'signals-project', repoPath: repo })
        store.addWorkspace({
          id: crypto.randomUUID(),
          name: 'main',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })
      }, repoPath)

      await window.waitForTimeout(4000)

      await window.evaluate(() => {
        const store = (window as any).__store.getState()
        store.setGhAvailability('test-proj-signals-blocked', true)
        store.setPrStatuses('test-proj-signals-blocked', {
          main: {
            number: 123,
            state: 'open',
            title: 'Blocked PR',
            url: 'https://github.com/test/repo/pull/123',
            checkStatus: 'failing',
            hasPendingComments: true,
            pendingCommentCount: 12,
            isBlockedByCi: true,
            isApproved: false,
            isChangesRequested: false,
            updatedAt: new Date().toISOString(),
          },
        })
      })

      await window.waitForTimeout(500)

      await expect(window.locator('[class*="prPendingComments"]')).toBeVisible()
      await expect(window.locator('[class*="prBlockedCi"]')).toBeVisible()
      await expect(window.locator('[class*="prCiPending"]')).not.toBeVisible()
      await expect(window.locator('[class*="prApproved"]')).not.toBeVisible()
      await expect(window.locator('[class*="prCiPassing"]')).not.toBeVisible()
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('open PR shows pending CI badge without red failure badge', async () => {
    const repoPath = createTestRepo('pr-signals-pending')
    const { app, window } = await launchApp()

    try {
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = 'test-proj-signals-pending'
        store.addProject({ id: projectId, name: 'pending-project', repoPath: repo })
        store.addWorkspace({
          id: crypto.randomUUID(),
          name: 'main',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })
      }, repoPath)

      await window.waitForTimeout(4000)

      await window.evaluate(() => {
        const store = (window as any).__store.getState()
        store.setGhAvailability('test-proj-signals-pending', true)
        store.setPrStatuses('test-proj-signals-pending', {
          main: {
            number: 125,
            state: 'open',
            title: 'Pending CI PR',
            url: 'https://github.com/test/repo/pull/125',
            checkStatus: 'pending',
            hasPendingComments: false,
            pendingCommentCount: 0,
            // Keep true to ensure UI no longer renders this as red while running.
            isBlockedByCi: true,
            isApproved: false,
            updatedAt: new Date().toISOString(),
          },
        })
      })

      await window.waitForTimeout(500)

      await expect(window.locator('[class*="prCiPending"]')).toBeVisible()
      await expect(window.locator('[class*="prBlockedCi"]')).not.toBeVisible()
      await expect(window.locator('[class*="prCiPassing"]')).not.toBeVisible()
      await expect(window.locator('[class*="prApproved"]')).not.toBeVisible()
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('open PR shows approved badge', async () => {
    const repoPath = createTestRepo('pr-signals-approved')
    const { app, window } = await launchApp()

    try {
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = 'test-proj-signals-approved'
        store.addProject({ id: projectId, name: 'approved-project', repoPath: repo })
        store.addWorkspace({
          id: crypto.randomUUID(),
          name: 'main',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })
      }, repoPath)

      await window.waitForTimeout(4000)

      await window.evaluate(() => {
        const store = (window as any).__store.getState()
        store.setGhAvailability('test-proj-signals-approved', true)
        store.setPrStatuses('test-proj-signals-approved', {
          main: {
            number: 124,
            state: 'open',
            title: 'Approved PR',
            url: 'https://github.com/test/repo/pull/124',
            checkStatus: 'passing',
            hasPendingComments: false,
            pendingCommentCount: 0,
            isBlockedByCi: false,
            isApproved: true,
            isChangesRequested: false,
            updatedAt: new Date().toISOString(),
          },
        })
      })

      await window.waitForTimeout(500)

      await expect(window.locator('[class*="prApproved"]')).toBeVisible()
      await expect(window.locator('[class*="prChangesRequested"]')).not.toBeVisible()
      await expect(window.locator('[class*="prPendingComments"]')).not.toBeVisible()
      await expect(window.locator('[class*="prBlockedCi"]')).not.toBeVisible()
      await expect(window.locator('[class*="prCiPassing"]')).toBeVisible()
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('open PR shows changes requested icon', async () => {
    const repoPath = createTestRepo('pr-signals-changes-requested')
    const { app, window } = await launchApp()

    try {
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = 'test-proj-signals-changes-requested'
        store.addProject({ id: projectId, name: 'changes-requested-project', repoPath: repo })
        store.addWorkspace({
          id: crypto.randomUUID(),
          name: 'main',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })
      }, repoPath)

      await window.waitForTimeout(4000)

      await window.evaluate(() => {
        const store = (window as any).__store.getState()
        store.setGhAvailability('test-proj-signals-changes-requested', true)
        store.setPrStatuses('test-proj-signals-changes-requested', {
          main: {
            number: 125,
            state: 'open',
            title: 'Changes Requested PR',
            url: 'https://github.com/test/repo/pull/125',
            checkStatus: 'passing',
            hasPendingComments: false,
            pendingCommentCount: 0,
            isBlockedByCi: false,
            isApproved: false,
            isChangesRequested: true,
            updatedAt: new Date().toISOString(),
          },
        })
      })

      await window.waitForTimeout(500)

      await expect(window.locator('[class*="prChangesRequested"]')).toBeVisible()
      await expect(window.locator('[class*="prApproved"]')).not.toBeVisible()
      await expect(window.locator('[class*="prPendingComments"]')).not.toBeVisible()
      await expect(window.locator('[class*="prBlockedCi"]')).not.toBeVisible()
      await expect(window.locator('[class*="prCiPassing"]')).toBeVisible()
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('merged PR shows without check indicator', async () => {
    const repoPath = createTestRepo('pr-merged')
    const { app, window } = await launchApp()

    try {
      // Set up project and workspace
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = 'test-proj-merged'
        store.addProject({ id: projectId, name: 'merged-project', repoPath: repo })
        store.addWorkspace({
          id: crypto.randomUUID(),
          name: 'merged-ws',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })
      }, repoPath)

      // Wait for poller to settle before injecting PR data
      await window.waitForTimeout(2500)

      await window.evaluate(() => {
        const store = (window as any).__store.getState()
        const ws = store.workspaces.find((w: { projectId: string }) => w.projectId === 'test-proj-merged')
        const branch = ws?.branch ?? 'main'
        store.setGhAvailability('test-proj-merged', true)
        store.setPrStatuses('test-proj-merged', {
          [branch]: {
            number: 77,
            state: 'merged',
            title: 'Already merged',
            url: 'https://github.com/test/repo/pull/77',
            checkStatus: 'passing',
            hasPendingComments: false,
            pendingCommentCount: 0,
            isBlockedByCi: false,
            isApproved: false,
            isChangesRequested: false,
            updatedAt: new Date().toISOString(),
          },
        })
      })

      await window.waitForTimeout(500)

      // PR number should show
      const prBadge = window.locator('[class*="prInline"]')
      await expect(prBadge).toBeVisible({ timeout: 3000 })
      const prText = await prBadge.textContent()
      expect(prText).toContain('#77')

      // Badge should carry merged-state styling.
      await expect(prBadge).toHaveClass(/pr_merged/)
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })
})
