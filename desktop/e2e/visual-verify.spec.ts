import { test, expect, _electron as electron } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, realpathSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')

test('Full visual verification: project + workspace + terminal + file tree + changes', async () => {
  // Create test repo
  const repoPath = join('/tmp', `visual-verify-${Date.now()}`)
  mkdirSync(repoPath, { recursive: true })
  execSync('git init', { cwd: repoPath })
  execSync('git checkout -b main', { cwd: repoPath })
  mkdirSync(join(repoPath, 'src'), { recursive: true })
  writeFileSync(join(repoPath, 'README.md'), '# Constellagent\nA Mac app for running AI agents.\n')
  writeFileSync(join(repoPath, 'src/index.ts'), 'console.log("hello world")\n')
  writeFileSync(join(repoPath, 'src/utils.ts'), 'export function add(a: number, b: number) { return a + b }\n')
  writeFileSync(join(repoPath, 'package.json'), '{"name":"test","version":"1.0.0"}\n')
  execSync('git add .', { cwd: repoPath })
  execSync('git commit -m "initial commit"', { cwd: repoPath })

  const app = await electron.launch({ args: [appPath], env: { ...process.env, CI_TEST: '1', ELECTRON_RENDERER_URL: '' } })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(2000)

  try {
    // Step 1: Set up project + workspace + terminal
    await window.evaluate(async (repo: string) => {
      const store = (window as any).__store.getState()
      store.hydrateState({ projects: [], workspaces: [] })

      const projectId = crypto.randomUUID()
      store.addProject({ id: projectId, name: 'constellagent', repoPath: repo })

      const wt = await (window as any).api.git.createWorktree(repo, 'feature-auth', 'feature/auth', true)
      const wsId = crypto.randomUUID()
      store.addWorkspace({
        id: wsId, name: 'feature-auth', branch: 'feature/auth', worktreePath: wt, projectId,
      })

      const ptyId = await (window as any).api.pty.create(wt)
      store.addTab({
        id: crypto.randomUUID(), workspaceId: wsId, type: 'terminal', title: 'Terminal 1', ptyId,
      })
    }, repoPath)

    await window.waitForTimeout(3000)

    // Screenshot 1: Terminal view
    await window.screenshot({
      path: resolve(__dirname, 'screenshots/verify-1-terminal.png'),
    })

    // Step 2: Modify a file to create changes
    const worktreePath = await window.evaluate(() => {
      const store = (window as any).__store.getState()
      return store.workspaces[0]?.worktreePath
    })
    if (worktreePath) {
      const realWt = realpathSync(worktreePath as string)
      writeFileSync(join(realWt, 'README.md'), '# Constellagent\nModified for testing.\n\nNew features added.\n')
      writeFileSync(join(realWt, 'src/index.ts'), 'console.log("updated")\nimport { add } from "./utils"\n')
    }

    // Step 3: Switch to Changes panel
    const changesBtn = window.locator('button', { hasText: 'Changes' })
    await changesBtn.click()
    await window.waitForTimeout(2000)

    // Screenshot 2: Changes view
    await window.screenshot({
      path: resolve(__dirname, 'screenshots/verify-2-changes.png'),
    })

    // Step 4: Expand sidebar project
    const projectHeader = window.locator('[class*="projectHeader"]').first()
    await projectHeader.click()
    await window.waitForTimeout(500)

    // Screenshot 3: With sidebar expanded
    await window.screenshot({
      path: resolve(__dirname, 'screenshots/verify-3-sidebar-expanded.png'),
    })

    // Step 5: Switch to Files panel
    const filesBtn = window.locator('button', { hasText: 'Files' })
    await filesBtn.click()
    await window.waitForTimeout(1000)

    // Screenshot 4: File tree
    await window.screenshot({
      path: resolve(__dirname, 'screenshots/verify-4-files.png'),
    })

    // Step 6: Open a file in editor
    await window.evaluate(async () => {
      const store = (window as any).__store.getState()
      const ws = store.workspaces[0]
      if (ws) {
        store.addTab({
          id: crypto.randomUUID(),
          workspaceId: ws.id,
          type: 'file',
          filePath: `${ws.worktreePath}/src/index.ts`,
        })
      }
    })
    await window.waitForTimeout(3000)

    // Screenshot 5: Editor view
    await window.screenshot({
      path: resolve(__dirname, 'screenshots/verify-5-editor.png'),
    })

    // Step 7: Open diff view
    await window.evaluate(async () => {
      const store = (window as any).__store.getState()
      const ws = store.workspaces[0]
      if (ws) {
        store.addTab({
          id: crypto.randomUUID(),
          workspaceId: ws.id,
          type: 'diff',
        })
      }
    })
    await window.waitForTimeout(3000)

    // Screenshot 6: Diff view
    await window.screenshot({
      path: resolve(__dirname, 'screenshots/verify-6-diff.png'),
    })

    console.log('All visual verification screenshots taken successfully!')
  } finally {
    await app.close()
  }
})
