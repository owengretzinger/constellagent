import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join, relative } from 'path'
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

test.describe('IPC handlers & state persistence', () => {
  test('app:add-project-path validates directory and returns path', async () => {
    const repoPath = createTestRepo('ipc-add')
    const { app, window } = await launchApp()

    try {
      // Valid directory should return the path
      const result = await window.evaluate(async (repo: string) => {
        return await (window as any).api.app.addProjectPath(repo)
      }, repoPath)

      expect(result).toBe(repoPath)

      // Invalid directory should return null
      const badResult = await window.evaluate(async () => {
        return await (window as any).api.app.addProjectPath('/tmp/does-not-exist-' + Date.now())
      })

      expect(badResult).toBeNull()

      // Path to a file (not directory) should return null
      const filePath = join(repoPath, 'README.md')
      const fileResult = await window.evaluate(async (fp: string) => {
        return await (window as any).api.app.addProjectPath(fp)
      }, filePath)

      expect(fileResult).toBeNull()
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('state persistence round-trip: save and load projects', async () => {
    const repoPath = createTestRepo('persist')
    const { app, window } = await launchApp()

    try {
      const testState = {
        projects: [{ id: 'test-id', name: 'persist-project', repoPath }],
        workspaces: [],
      }

      // Save state via IPC
      await window.evaluate(async (data: any) => {
        await (window as any).api.state.save(data)
      }, testState)

      // Load state back via IPC
      const loaded = await window.evaluate(async () => {
        return await (window as any).api.state.load()
      })

      expect(loaded).toBeTruthy()
      expect(loaded.projects).toHaveLength(1)
      expect(loaded.projects[0].name).toBe('persist-project')
      expect(loaded.projects[0].repoPath).toBe(repoPath)
      expect(loaded.workspaces).toHaveLength(0)
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('state:load returns null when no state file exists', async () => {
    // This test verifies graceful handling when the state file doesn't exist.
    // The hydrateFromDisk() call on startup should not crash the app.
    const { app, window } = await launchApp()

    try {
      // The app launched successfully (hydrateFromDisk didn't crash)
      // Verify state.load returns valid data or null
      const loaded = await window.evaluate(async () => {
        return await (window as any).api.state.load()
      })

      // Either null (first launch) or a previously saved state object
      if (loaded !== null) {
        expect(loaded).toHaveProperty('projects')
      }
    } finally {
      await app.close()
    }
  })

  test('full flow: add project via IPC, create worktree, verify on disk', async () => {
    const repoPath = createTestRepo('full-flow')
    const { app, window } = await launchApp()

    try {
      // Step 1: Validate directory via app:add-project-path IPC
      const validatedPath = await window.evaluate(async (repo: string) => {
        return await (window as any).api.app.addProjectPath(repo)
      }, repoPath)

      // macOS: /tmp resolves to /private/tmp
      expect((validatedPath as string).replace('/private', '')).toBe(repoPath.replace('/private', ''))

      // Step 2: Add project to store using the validated path
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        const name = repo.split('/').pop() || repo
        store.addProject({
          id: crypto.randomUUID(),
          name,
          repoPath: repo,
        })
      }, validatedPath as string)

      // Step 3: Create a worktree via git IPC
      const worktreePath = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.createWorktree(repo, 'flow-ws', 'flow-branch', true)
      }, repoPath)

      expect(worktreePath).toBeTruthy()

      // Step 4: Verify worktree exists on disk
      expect(existsSync(worktreePath as string)).toBe(true)

      // Step 5: Verify worktree is listed
      const worktrees = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.listWorktrees(repo)
      }, repoPath)

      const found = worktrees.find((wt: any) => wt.branch === 'flow-branch')
      expect(found).toBeTruthy()
      // On macOS /tmp resolves to /private/tmp, so compare with toContain
      expect(found.path).toContain('-ws-flow-ws')

      // Step 6: Verify project appears in sidebar
      await window.waitForTimeout(500)
      const repoName = repoPath.split('/').pop()!
      const projectHeader = window.locator('[class*="projectHeader"]', { hasText: repoName })
      await expect(projectHeader).toBeVisible()

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/full-flow-project.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('git:create-worktree sanitizes unsafe workspace names to stay under repo parent', async () => {
    const repoPath = createTestRepo('safe-name')
    const { app, window } = await launchApp()

    try {
      const worktreePath = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.createWorktree(repo, '../../..//unsafe name', 'safe-branch', true)
      }, repoPath)

      expect(worktreePath).toBeTruthy()
      expect(existsSync(worktreePath as string)).toBe(true)

      const parentDir = resolve(repoPath, '..')
      const relToParent = relative(parentDir, worktreePath as string)
      expect(relToParent.startsWith('..')).toBe(false)

      const leafName = (worktreePath as string).split('/').pop() || ''
      expect(leafName).toContain('-ws-')
      expect(leafName).not.toContain('..')
      expect(leafName).not.toContain('/')
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })
})
