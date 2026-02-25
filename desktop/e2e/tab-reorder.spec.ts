import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
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

async function setupWorkspaceWith3Tabs(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const worktreePath = await (window as any).api.git.createWorktree(repo, 'ws-reorder', 'branch-reorder', true)

    const wsId = crypto.randomUUID()
    store.addWorkspace({
      id: wsId, name: 'ws-reorder', branch: 'branch-reorder', worktreePath, projectId,
    })

    const ptyId1 = await (window as any).api.pty.create(worktreePath)
    const tab1Id = crypto.randomUUID()
    store.addTab({ id: tab1Id, workspaceId: wsId, type: 'terminal', title: 'alpha', ptyId: ptyId1 })

    const ptyId2 = await (window as any).api.pty.create(worktreePath)
    const tab2Id = crypto.randomUUID()
    store.addTab({ id: tab2Id, workspaceId: wsId, type: 'terminal', title: 'beta', ptyId: ptyId2 })

    const ptyId3 = await (window as any).api.pty.create(worktreePath)
    const tab3Id = crypto.randomUUID()
    store.addTab({ id: tab3Id, workspaceId: wsId, type: 'terminal', title: 'gamma', ptyId: ptyId3 })

    return { wsId, tab1Id, tab2Id, tab3Id }
  }, repoPath)
}

test.describe('Tab reorder', () => {
  test('programmatic reorderTab changes tab order in store and UI', async () => {
    const repoPath = createTestRepo('reorder-prog')
    const { app, window } = await launchApp()

    try {
      const { wsId, tab1Id, tab2Id, tab3Id } = await setupWorkspaceWith3Tabs(window, repoPath)
      await window.waitForTimeout(1000)

      // Verify initial order: alpha, beta, gamma
      const before = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        return s.tabs.filter((t: any) => t.workspaceId === s.activeWorkspaceId).map((t: any) => t.title)
      })
      expect(before).toEqual(['alpha', 'beta', 'gamma'])

      // Verify UI shows 3 tabs
      const tabCount = await window.locator('[data-tab-index]').count()
      expect(tabCount).toBe(3)

      // Reorder: move gamma (index 2) to position 0
      await window.evaluate((wsId: string) => {
        ;(window as any).__store.getState().reorderTab(wsId, 2, 0)
      }, wsId)
      await window.waitForTimeout(500)

      // Verify store order changed
      const after = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        return s.tabs.filter((t: any) => t.workspaceId === s.activeWorkspaceId).map((t: any) => t.title)
      })
      expect(after).toEqual(['gamma', 'alpha', 'beta'])

      // Verify UI tab order matches
      const tabTitles = await window.locator('[data-tab-index]').evaluateAll((els: Element[]) =>
        els.map(el => el.querySelector('[class*="tabTitle"]')?.textContent ?? '')
      )
      expect(tabTitles).toEqual(['gamma', 'alpha', 'beta'])

      // Verify Cmd+1 now activates gamma (the new first tab)
      await window.keyboard.press('Meta+1')
      await window.waitForTimeout(500)
      const activeAfterCmd1 = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        return s.tabs.find((t: any) => t.id === s.activeTabId)?.title
      })
      expect(activeAfterCmd1).toBe('gamma')
    } finally {
      await app.close()
    }
  })

  test('mouse drag reorders tabs', async () => {
    const repoPath = createTestRepo('reorder-drag')
    const { app, window } = await launchApp()

    try {
      const { tab1Id, tab2Id, tab3Id } = await setupWorkspaceWith3Tabs(window, repoPath)
      await window.waitForTimeout(1000)

      // Verify initial order by ID
      const before = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        return s.tabs.filter((t: any) => t.workspaceId === s.activeWorkspaceId).map((t: any) => t.id)
      })
      expect(before).toEqual([tab1Id, tab2Id, tab3Id])

      // Get tab positions
      const tab3 = window.locator('[data-tab-index="2"]')
      const tab1 = window.locator('[data-tab-index="0"]')
      const box3 = await tab3.boundingBox()
      const box1 = await tab1.boundingBox()
      expect(box3).not.toBeNull()
      expect(box1).not.toBeNull()

      // Drag tab 3 (gamma) to tab 1 (alpha) position
      const startX = box3!.x + box3!.width / 2
      const startY = box3!.y + box3!.height / 2
      const endX = box1!.x + box1!.width / 4
      const endY = box1!.y + box1!.height / 2

      await window.mouse.move(startX, startY)
      await window.mouse.down()
      const steps = 8
      for (let i = 1; i <= steps; i++) {
        const x = startX + (endX - startX) * (i / steps)
        const y = startY + (endY - startY) * (i / steps)
        await window.mouse.move(x, y)
        await window.waitForTimeout(50)
      }
      await window.mouse.up()
      await window.waitForTimeout(500)

      // Verify store order changed by ID
      const after = await window.evaluate(() => {
        const s = (window as any).__store.getState()
        return s.tabs.filter((t: any) => t.workspaceId === s.activeWorkspaceId).map((t: any) => t.id)
      })
      expect(after).toEqual([tab3Id, tab1Id, tab2Id])
    } finally {
      await app.close()
    }
  })
})
