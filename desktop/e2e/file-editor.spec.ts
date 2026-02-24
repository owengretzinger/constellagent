import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync } from 'fs'
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
  writeFileSync(join(repoPath, 'src/index.ts'), 'console.log("hello world")\n')
  writeFileSync(join(repoPath, 'src/utils.ts'), 'export function add(a: number, b: number) { return a + b }\n')
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

/** Set up project + workspace in the app store, return worktree path */
async function setupWorkspace(window: Page, repoPath: string, suffix: string): Promise<string> {
  return await window.evaluate(async ({ repo, sfx }: { repo: string; sfx: string }) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })
    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const worktreePath = await (window as any).api.git.createWorktree(repo, `ws-${sfx}`, `branch-${sfx}`, true)
    const wsId = crypto.randomUUID()
    store.addWorkspace({
      id: wsId, name: `ws-${sfx}`, branch: `branch-${sfx}`, worktreePath, projectId,
    })
    return worktreePath
  }, { repo: repoPath, sfx: suffix })
}

test.describe('File tree & editor integration', () => {
  test('file tree loads and shows files when workspace is active', async () => {
    const repoPath = createTestRepo('ftree-1')
    const { app, window } = await launchApp()

    try {
      await setupWorkspace(window, repoPath, 'ftree')
      await window.waitForTimeout(1000)

      // Right panel should show file tree by default
      const filesBtn = window.locator('button', { hasText: 'Files' })
      const filesBtnClass = await filesBtn.getAttribute('class')
      expect(filesBtnClass).toContain('active')

      // Wait for tree to load
      await window.waitForTimeout(1000)

      // Should see src directory and README.md
      const readmeItem = window.locator('[class*="treeNode"]', { hasText: 'README.md' })
      await expect(readmeItem).toBeVisible()

      const srcItem = window.locator('[class*="treeNode"]', { hasText: 'src' })
      await expect(srcItem).toBeVisible()

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/file-tree-loaded.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('clicking file in tree opens editor tab with content', async () => {
    const repoPath = createTestRepo('editor-1')
    const { app, window } = await launchApp()

    try {
      await setupWorkspace(window, repoPath, 'editor')
      await window.waitForTimeout(1000)

      // Wait for file tree to load
      await window.waitForTimeout(2000)

      // Click README.md in file tree
      const readmeItem = window.locator('[class*="treeNode"]', { hasText: 'README.md' }).first()
      await expect(readmeItem).toBeVisible({ timeout: 5000 })
      await readmeItem.click()
      await window.waitForTimeout(3000)

      // A new tab should appear with README.md
      const tab = window.locator('[class*="tabTitle"]', { hasText: 'README.md' })
      await expect(tab).toBeVisible({ timeout: 5000 })

      // Monaco editor should be rendered
      const monacoEditor = window.locator('.monaco-editor').first()
      await expect(monacoEditor).toBeVisible({ timeout: 10000 })

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/editor-file-opened.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('editing file and saving with Cmd+S writes to disk', async () => {
    const repoPath = createTestRepo('save-1')
    const { app, window } = await launchApp()

    try {
      const worktreePath = await setupWorkspace(window, repoPath, 'save')
      await window.waitForTimeout(1000)

      // Open README.md via store (bypass file tree click)
      await window.evaluate(async (wt: string) => {
        const store = (window as any).__store.getState()
        const ws = store.workspaces[0]
        store.addTab({
          id: crypto.randomUUID(),
          workspaceId: ws.id,
          type: 'file',
          filePath: `${wt}/README.md`,
        })
      }, worktreePath)

      await window.waitForTimeout(2000)

      // Type new content into Monaco
      const monacoEditor = window.locator('.monaco-editor .view-lines').first()
      await monacoEditor.click()

      // Select all and type new content
      await window.keyboard.press('Meta+a')
      await window.keyboard.type('# Updated Content\n')
      await window.waitForTimeout(500)

      // Save with Cmd+S
      await window.keyboard.press('Meta+s')
      await window.waitForTimeout(1000)

      // Verify file on disk was updated (resolve symlinks for macOS)
      const realWt = realpathSync(worktreePath)
      const content = readFileSync(join(realWt, 'README.md'), 'utf-8')
      expect(content).toContain('Updated Content')

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/editor-file-saved.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })
})

test.describe('Changed files & diff viewer', () => {
  test('changes panel shows modified files', async () => {
    const repoPath = createTestRepo('changes-1')
    const { app, window } = await launchApp()

    try {
      const worktreePath = await setupWorkspace(window, repoPath, 'changes')
      await window.waitForTimeout(1000)

      // Modify a file in the worktree (resolve symlinks for macOS /tmp -> /private/tmp)
      const realWtPath = realpathSync(worktreePath)
      writeFileSync(join(realWtPath, 'README.md'), '# Modified Content\nNew line\n')

      // Switch to Changes panel
      const changesBtn = window.locator('button', { hasText: 'Changes' })
      await changesBtn.click()
      await window.waitForTimeout(2000)

      // Should show README.md as modified — use statusBadge parent to avoid matching the list container
      const changedFile = window.locator('[class*="statusBadge"]', { hasText: 'M' }).locator('..')
      await expect(changedFile).toBeVisible({ timeout: 5000 })
      await expect(changedFile).toContainText('README.md')

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/changes-panel-modified.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('clicking changed file opens diff viewer', async () => {
    const repoPath = createTestRepo('diff-view-1')
    const { app, window } = await launchApp()

    try {
      const worktreePath = await setupWorkspace(window, repoPath, 'diff')
      await window.waitForTimeout(1000)

      // Modify a file (resolve symlinks for macOS /tmp -> /private/tmp)
      const realWtPath = realpathSync(worktreePath)
      writeFileSync(join(realWtPath, 'README.md'), '# Completely Different\nNew content here\n')

      // Switch to Changes panel
      const changesBtn = window.locator('button', { hasText: 'Changes' })
      await changesBtn.click()
      await window.waitForTimeout(1500)

      // Click the changed file to open diff
      const changedFile = window.locator('[class*="statusBadge"]', { hasText: 'M' }).locator('..')
      await changedFile.click()
      await window.waitForTimeout(2000)

      // Diff tab should appear
      const diffTab = window.locator('[class*="tabTitle"]', { hasText: 'Changes' })
      await expect(diffTab).toBeVisible()

      // Diff toolbar should be visible
      const diffToolbar = window.locator('[class*="diffToolbar"]')
      await expect(diffToolbar).toBeVisible()

      // Side-by-side and Inline toggle buttons should exist
      const sideBtn = window.locator('[class*="diffToggleOption"]', { hasText: 'Side by side' })
      const inlineBtn = window.locator('[class*="diffToggleOption"]', { hasText: 'Inline' })
      await expect(sideBtn).toBeVisible()
      await expect(inlineBtn).toBeVisible()

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/diff-viewer-opened.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })

  test('diff viewer does not render diffs for non-text files', async () => {
    const repoPath = createTestRepo('diff-binary-1')
    const { app, window } = await launchApp()

    try {
      const worktreePath = await setupWorkspace(window, repoPath, 'bin')
      await window.waitForTimeout(1000)

      // Create an untracked binary file (resolve symlinks for macOS /tmp -> /private/tmp)
      const realWtPath = realpathSync(worktreePath)
      mkdirSync(join(realWtPath, 'assets'), { recursive: true })
      writeFileSync(join(realWtPath, 'assets/logo.png'), Buffer.from([0, 1, 2, 3, 4, 5, 0, 255]))

      // Switch to Changes panel
      const changesBtn = window.locator('button', { hasText: 'Changes' })
      await changesBtn.click()
      await window.waitForTimeout(1500)

      // Click the untracked file to open diff
      const untrackedFile = window.locator('[class*="statusBadge"]', { hasText: 'U' }).first().locator('..')
      await expect(untrackedFile).toBeVisible({ timeout: 5000 })
      await expect(untrackedFile).toContainText('logo.png')
      await untrackedFile.click()
      await window.waitForTimeout(2000)

      // Binary notice should be shown instead of an attempted text diff.
      const binaryNotice = window.locator('text=Non-text file. Diff not shown.')
      await expect(binaryNotice).toBeVisible({ timeout: 5000 })

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/diff-binary-notice.png'),
      })
    } finally {
      await app.close()
      cleanupTestRepo(repoPath)
    }
  })
})
