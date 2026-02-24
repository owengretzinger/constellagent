import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync, readFileSync } from 'fs'
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
  execSync('git config user.email "test@test.com"', { cwd: repoPath })
  execSync('git config user.name "Test"', { cwd: repoPath })
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

test.describe('Git staging functionality', () => {
  test('stage and unstage a file via IPC', async () => {
    const repoPath = createTestRepo('staging-ipc')
    const realRepo = realpathSync(repoPath)
    const { app, window } = await launchApp()

    try {
      // Modify a tracked file
      writeFileSync(join(realRepo, 'README.md'), '# Modified\n')

      // Status should show unstaged change
      const before = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.getStatus(repo)
      }, realRepo)

      const unstaged = before.filter((f: any) => !f.staged && f.path === 'README.md')
      expect(unstaged.length).toBe(1)

      // Stage the file
      await window.evaluate(async (repo: string) => {
        await (window as any).api.git.stage(repo, ['README.md'])
      }, realRepo)

      // Now it should be staged
      const after = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.getStatus(repo)
      }, realRepo)

      const staged = after.filter((f: any) => f.staged && f.path === 'README.md')
      expect(staged.length).toBe(1)

      // Unstage it
      await window.evaluate(async (repo: string) => {
        await (window as any).api.git.unstage(repo, ['README.md'])
      }, realRepo)

      const final = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.getStatus(repo)
      }, realRepo)

      const unstagedFinal = final.filter((f: any) => !f.staged && f.path === 'README.md')
      expect(unstagedFinal.length).toBe(1)
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('commit staged changes via IPC', async () => {
    const repoPath = createTestRepo('staging-commit')
    const realRepo = realpathSync(repoPath)
    const { app, window } = await launchApp()

    try {
      // Modify and stage
      writeFileSync(join(realRepo, 'README.md'), '# Committed change\n')
      await window.evaluate(async (repo: string) => {
        await (window as any).api.git.stage(repo, ['README.md'])
      }, realRepo)

      // Commit
      await window.evaluate(async (repo: string) => {
        await (window as any).api.git.commit(repo, 'test commit message')
      }, realRepo)

      // Status should be clean
      const after = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.getStatus(repo)
      }, realRepo)

      expect(after.length).toBe(0)

      // Verify commit exists in log
      const log = execSync('git log --oneline -1', { cwd: realRepo }).toString().trim()
      expect(log).toContain('test commit message')
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('discard unstaged changes via IPC', async () => {
    const repoPath = createTestRepo('staging-discard')
    const realRepo = realpathSync(repoPath)
    const { app, window } = await launchApp()

    try {
      // Modify a tracked file
      writeFileSync(join(realRepo, 'README.md'), '# Will be discarded\n')

      // Discard
      await window.evaluate(async (repo: string) => {
        await (window as any).api.git.discard(repo, ['README.md'], [])
      }, realRepo)

      // File should be back to original
      const content = readFileSync(join(realRepo, 'README.md'), 'utf-8')
      expect(content).toBe('# Test Repo\n')

      // Status should be clean
      const after = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.getStatus(repo)
      }, realRepo)

      expect(after.length).toBe(0)
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('discard untracked file via IPC', async () => {
    const repoPath = createTestRepo('staging-discard-untracked')
    const realRepo = realpathSync(repoPath)
    const { app, window } = await launchApp()

    try {
      // Create untracked file
      writeFileSync(join(realRepo, 'newfile.txt'), 'untracked\n')
      expect(existsSync(join(realRepo, 'newfile.txt'))).toBe(true)

      // Discard (clean)
      await window.evaluate(async (repo: string) => {
        await (window as any).api.git.discard(repo, [], ['newfile.txt'])
      }, realRepo)

      // File should be gone
      expect(existsSync(join(realRepo, 'newfile.txt'))).toBe(false)
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('dual status entries for file that is both staged and unstaged', async () => {
    const repoPath = createTestRepo('staging-dual')
    const realRepo = realpathSync(repoPath)
    const { app, window } = await launchApp()

    try {
      // Modify file, stage it, then modify again
      writeFileSync(join(realRepo, 'README.md'), '# Staged version\n')
      execSync('git add README.md', { cwd: realRepo })
      writeFileSync(join(realRepo, 'README.md'), '# Unstaged version\n')

      const statuses = await window.evaluate(async (repo: string) => {
        return await (window as any).api.git.getStatus(repo)
      }, realRepo)

      // Should have two entries for README.md: one staged, one unstaged
      const readmeEntries = statuses.filter((s: any) => s.path === 'README.md')
      expect(readmeEntries.length).toBe(2)

      const stagedEntry = readmeEntries.find((s: any) => s.staged)
      const unstagedEntry = readmeEntries.find((s: any) => !s.staged)
      expect(stagedEntry).toBeTruthy()
      expect(unstagedEntry).toBeTruthy()
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('changes panel shows staged and unstaged sections', async () => {
    const repoPath = createTestRepo('staging-ui')
    const realRepo = realpathSync(repoPath)
    const { app, window } = await launchApp()

    try {
      // Set up project + workspace pointing to the repo directly
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = crypto.randomUUID()
        store.addProject({ id: projectId, name: 'staging-test', repoPath: repo })

        const wsId = crypto.randomUUID()
        store.addWorkspace({
          id: wsId,
          name: 'main',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })
      }, realRepo)

      await window.waitForTimeout(500)

      // Create changes: one staged, one unstaged
      writeFileSync(join(realRepo, 'README.md'), '# Staged\n')
      execSync('git add README.md', { cwd: realRepo })
      writeFileSync(join(realRepo, 'newfile.txt'), 'unstaged\n')

      // Switch to Changes mode
      const changesBtn = window.locator('button', { hasText: 'Changes' })
      await changesBtn.click()
      await window.waitForTimeout(1000)

      // Should see both sections
      const stagedHeader = window.locator('[class*="sectionLabel"]', { hasText: 'Staged Changes' })
      const unstagedHeader = window.locator('[class*="sectionLabel"]', { hasText: 'Changes' }).last()

      await expect(stagedHeader).toBeVisible({ timeout: 5000 })
      await expect(unstagedHeader).toBeVisible({ timeout: 5000 })

      // Staged section should show README.md
      const stagedSection = window.locator('[class*="changeSection"]').first()
      await expect(stagedSection.locator('[class*="changePath"]', { hasText: 'README.md' })).toBeVisible()

      // Unstaged section should show newfile.txt
      const unstagedSection = window.locator('[class*="changeSection"]').last()
      await expect(unstagedSection.locator('[class*="changePath"]', { hasText: 'newfile.txt' })).toBeVisible()

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/staging-sections.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('stage file via + button in UI', async () => {
    const repoPath = createTestRepo('staging-ui-stage')
    const realRepo = realpathSync(repoPath)
    const { app, window } = await launchApp()

    try {
      await window.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = crypto.randomUUID()
        store.addProject({ id: projectId, name: 'stage-btn-test', repoPath: repo })

        const wsId = crypto.randomUUID()
        store.addWorkspace({
          id: wsId,
          name: 'main',
          branch: 'main',
          worktreePath: repo,
          projectId,
        })
      }, realRepo)

      await window.waitForTimeout(500)

      // Create an unstaged change
      writeFileSync(join(realRepo, 'README.md'), '# Stage me\n')

      // Switch to Changes tab
      await window.locator('button', { hasText: 'Changes' }).click()
      await window.waitForTimeout(1000)

      // Should see file in "Changes" section (unstaged)
      // Use :not() to exclude the container (.changedFilesList) which also matches [class*="changedFile"]
      const fileRow = window.locator('[class*="changedFile"]:not([class*="changedFilesList"])', { hasText: 'README.md' })
      await expect(fileRow).toBeVisible({ timeout: 5000 })

      // Hover to reveal action buttons and click +
      await fileRow.hover()
      const stageBtn = fileRow.locator('button', { hasText: '+' })
      await stageBtn.click()
      await window.waitForTimeout(1000)

      // File should now be in Staged Changes section
      const stagedHeader = window.locator('[class*="sectionLabel"]', { hasText: 'Staged Changes' })
      await expect(stagedHeader).toBeVisible({ timeout: 5000 })

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/staging-file-staged.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })
})
