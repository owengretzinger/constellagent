import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')

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

async function launchApp(env: Record<string, string>): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      ...env,
      CI_TEST: '1',
    },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForSelector('[class*="layout"]', { timeout: 15000 })
  return { app, window }
}

async function waitForPtyOutput(window: Page, ptyId: string, needle: string): Promise<boolean> {
  return window.evaluate(({ id, text }) => {
    return new Promise<boolean>((resolve) => {
      const unsub = (window as any).api.pty.onData(id, (chunk: string) => {
        if (chunk.includes(text)) {
          unsub()
          resolve(true)
        }
      })
      setTimeout(() => {
        unsub()
        resolve(false)
      }, 8000)
    })
  }, { id: ptyId, text: needle })
}

test.describe('Terminal session persistence', () => {
  test('reattaches same terminal session after app relaunch', async () => {
    const repoPath = createTestRepo('terminal-persist')
    const testData = join('/tmp', `constellagent-test-persist-${Date.now()}`)
    const daemonHome = join(testData, 'terminal-host')
    const env = {
      CONSTELLAGENT_TEST_USER_DATA: testData,
      CONSTELLAGENT_DAEMON_HOME: daemonHome,
    }

    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null

    try {
      const first = await launchApp(env)
      firstApp = first.app
      const firstWindow = first.window

      const setup = await firstWindow.evaluate(async (repo: string) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = crypto.randomUUID()
        store.addProject({ id: projectId, name: 'persist-repo', repoPath: repo })

        const worktreePath = await (window as any).api.git.createWorktree(repo, 'persist-ws', 'persist-branch', true)
        const workspaceId = crypto.randomUUID()
        store.addWorkspace({
          id: workspaceId,
          name: 'persist-ws',
          branch: 'persist-branch',
          worktreePath,
          projectId,
        })

        const ptyId = await (window as any).api.pty.create(
          worktreePath,
          undefined,
          { AGENT_ORCH_WS_ID: workspaceId },
          true,
        )

        store.addTab({
          id: crypto.randomUUID(),
          workspaceId,
          type: 'terminal',
          title: 'Terminal',
          ptyId,
        })

        return { ptyId }
      }, repoPath)

      const marker = `persist_${Date.now()}`
      const primedPromise = waitForPtyOutput(firstWindow, setup.ptyId, marker)
      await firstWindow.evaluate(({ ptyId, markerValue }) => {
        ;(window as any).api.pty.write(
          ptyId,
          `export CONSTELLAGENT_PERSIST_TEST=${markerValue}\necho $CONSTELLAGENT_PERSIST_TEST\n`,
        )
      }, { ptyId: setup.ptyId, markerValue: marker })
      await expect(primedPromise).resolves.toBe(true)

      await firstApp.close()
      firstApp = null

      const second = await launchApp(env)
      secondApp = second.app
      const secondWindow = second.window

      const ptyId = await secondWindow.evaluate(() => {
        const store = (window as any).__store.getState()
        const tab = store.tabs.find((t: any) => t.type === 'terminal')
        return tab?.ptyId || null
      })

      expect(ptyId).toBeTruthy()

      const expectedLine = marker
      const outputPromise = waitForPtyOutput(secondWindow, ptyId as string, expectedLine)
      await secondWindow.evaluate((id: string) => {
        ;(window as any).api.pty.write(id, 'echo $CONSTELLAGENT_PERSIST_TEST\n')
      }, ptyId)

      await expect(outputPromise).resolves.toBe(true)
    } finally {
      if (firstApp) await firstApp.close()
      if (secondApp) await secondApp.close()
      rmSync(testData, { recursive: true, force: true })
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
})
