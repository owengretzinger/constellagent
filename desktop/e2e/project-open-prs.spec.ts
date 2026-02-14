import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
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

function createLocalRepo(name: string): string {
  const repoPath = join('/tmp', `test-repo-project-prs-${name}-${Date.now()}`)
  mkdirSync(repoPath, { recursive: true })
  execSync('git init', { cwd: repoPath })
  execSync('git checkout -b main', { cwd: repoPath })
  execSync('git config user.email "test@test.com"', { cwd: repoPath })
  execSync('git config user.name "Test"', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n')
  execSync('git add .', { cwd: repoPath })
  execSync('git commit -m "initial commit"', { cwd: repoPath })
  return repoPath
}

function createRepoWithPullRef(name: string, prNumber: number): { basePath: string; repoPath: string; prFile: string } {
  const basePath = join('/tmp', `test-repo-project-pr-pull-${name}-${Date.now()}`)
  const repoPath = join(basePath, 'repo')
  const remotePath = join(basePath, 'remote.git')
  const prFile = 'PR_FILE.txt'

  mkdirSync(basePath, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  execSync(`git init --bare "${remotePath}"`)

  execSync('git init', { cwd: repoPath })
  execSync('git checkout -b main', { cwd: repoPath })
  execSync('git config user.email "test@test.com"', { cwd: repoPath })
  execSync('git config user.name "Test"', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n')
  execSync('git add .', { cwd: repoPath })
  execSync('git commit -m "initial commit"', { cwd: repoPath })
  execSync(`git remote add origin "${remotePath}"`, { cwd: repoPath })
  execSync('git -c core.hooksPath=/dev/null push -u origin main', { cwd: repoPath })

  execSync('git checkout -b feature/test-pr-ref', { cwd: repoPath })
  writeFileSync(join(repoPath, prFile), 'from-pr\n')
  execSync(`git add ${prFile}`, { cwd: repoPath })
  execSync('git commit -m "pr commit"', { cwd: repoPath })
  execSync(`git -c core.hooksPath=/dev/null push origin HEAD:refs/pull/${prNumber}/head`, {
    cwd: repoPath,
  })
  execSync('git checkout main', { cwd: repoPath })

  return { basePath, repoPath, prFile }
}

function cleanupPath(path: string): void {
  try {
    if (existsSync(path)) rmSync(path, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

test.describe('Project open PR modal', () => {
  test('project PR button opens modal and shows unavailable state for local repo', async () => {
    const repoPath = createLocalRepo('popover-open')
    const { app, window } = await launchApp()

    try {
      await window.evaluate((repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })
        store.addProject({ id: 'proj-pr-popover', name: 'project-pr-popover', repoPath: repo })
      }, repoPath)

      const header = window.locator('[class*="projectHeader"]').first()
      await header.hover()

      const prButton = header.locator('button:has-text("PR")')
      await expect(prButton).toBeVisible()
      await prButton.click()

      const modal = window.locator('[data-project-pr-modal]')
      await expect(modal).toBeVisible()
      await expect(modal).toContainText(
        /(GitHub CLI is not installed|Origin remote is not a GitHub repo|GitHub CLI is not authenticated)/,
      )
    } finally {
      await app.close()
      cleanupPath(repoPath)
    }
  })

  test('project PR modal closes on escape and outside click', async () => {
    const repoPath = createLocalRepo('popover-close')
    const { app, window } = await launchApp()

    try {
      await window.evaluate((repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })
        store.addProject({ id: 'proj-pr-close', name: 'project-pr-close', repoPath: repo })
      }, repoPath)

      const header = window.locator('[class*="projectHeader"]').first()
      const prButton = header.locator('button:has-text("PR")')
      const modal = window.locator('[data-project-pr-modal]')

      await header.hover()
      await prButton.click()
      await expect(modal).toBeVisible()

      await window.keyboard.press('Escape')
      await expect(modal).not.toBeVisible()

      await header.hover()
      await prButton.click()
      await expect(modal).toBeVisible()
      await window.locator('[class*="projectPrModalOverlay"]').click({ position: { x: 8, y: 8 } })
      await expect(modal).not.toBeVisible()
    } finally {
      await app.close()
      cleanupPath(repoPath)
    }
  })

  test('git.createWorktreeFromPr checks out pull ref into a workspace', async () => {
    const prNumber = 42
    const { basePath, repoPath, prFile } = createRepoWithPullRef('create-worktree', prNumber)
    const { app, window } = await launchApp()

    try {
      const result = await window.evaluate(
        async ({ repo, pr }) => {
          return await (window as any).api.git.createWorktreeFromPr(
            repo,
            'pull-pr-locally',
            pr,
            'pr/42-feature-test',
          )
        },
        { repo: repoPath, pr: prNumber },
      )

      expect(result.worktreePath).toContain('-ws-pull-pr-locally')
      expect(result.branch).toBe('pr/42-feature-test')

      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: result.worktreePath,
      })
        .toString()
        .trim()
      expect(currentBranch).toBe(result.branch)
      expect(existsSync(join(result.worktreePath, prFile))).toBe(true)
    } finally {
      await app.close()
      cleanupPath(basePath)
    }
  })
})
