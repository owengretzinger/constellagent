import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, realpathSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({ args: [appPath], env: { ...process.env, CI_TEST: '1' } })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(1500)
  return { app, window }
}

function createTestRepo(name: string): string {
  const raw = join('/tmp', `test-repo-${name}-${Date.now()}`)
  mkdirSync(raw, { recursive: true })
  const repoPath = realpathSync(raw)
  execSync('git init', { cwd: repoPath })
  execSync('git checkout -b main', { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# Test Repo\n')
  execSync('git add .', { cwd: repoPath })
  execSync('git commit -m "initial commit"', { cwd: repoPath })
  return repoPath
}

/** Collect PTY output for a duration after optionally writing a command. */
async function capturePtyOutput(window: Page, ptyId: string, command: string, ms = 3000): Promise<string> {
  return window.evaluate(
    async ({ id, cmd, timeout }) => {
      return new Promise<string>((resolve) => {
        let buffer = ''
        const unsub = (window as any).api.pty.onData(id, (data: string) => {
          buffer += data
        })
        if (cmd) (window as any).api.pty.write(id, cmd + '\n')
        setTimeout(() => {
          unsub()
          resolve(buffer)
        }, timeout)
      })
    },
    { id: ptyId, cmd: command, timeout: ms },
  )
}

/**
 * Set up a project + workspace via the store, then call createTerminalForActiveWorkspace.
 * Uses the repo path directly as worktreePath (no git worktree IPC) to avoid fetch issues.
 */
async function setupProjectAndWorkspace(
  window: Page,
  repoPath: string,
  hooks?: Array<{ type: string; command: string }>,
) {
  return await window.evaluate(
    async (data) => {
      const store = (window as any).__store.getState()
      store.hydrateState({ projects: [], workspaces: [] })

      const projectId = crypto.randomUUID()
      store.addProject({
        id: projectId,
        name: 'test-repo',
        repoPath: data.repoPath,
        ...(data.hooks && { hooks: data.hooks }),
      })

      const wsId = crypto.randomUUID()
      store.addWorkspace({
        id: wsId,
        name: 'test-ws',
        branch: 'main',
        worktreePath: data.repoPath,
        projectId,
      })
      store.setActiveWorkspace(wsId)

      // Uses the store action which internally calls ptyEnv()
      await store.createTerminalForActiveWorkspace()

      const tabs = (window as any).__store.getState().tabs
      const termTab = tabs.find((t: any) => t.type === 'terminal' && t.workspaceId === wsId)

      return { projectId, wsId, worktreePath: data.repoPath, ptyId: termTab?.ptyId as string }
    },
    { repoPath, hooks },
  )
}

test.describe('PTY environment variables', () => {
  test('AGENT_ORCH env vars are set in terminal created via store action', async () => {
    const repoPath = createTestRepo('env-vars')
    const { app, window } = await launchApp()

    try {
      const { ptyId, worktreePath } = await setupProjectAndWorkspace(window, repoPath)
      expect(ptyId).toBeTruthy()

      // Give shell time to initialize
      await window.waitForTimeout(1000)

      const envOutput = await capturePtyOutput(window, ptyId, 'env | grep AGENT_ORCH')

      expect(envOutput).toContain('AGENT_ORCH_WS_ID=')
      expect(envOutput).toContain(`AGENT_ORCH_WS_PATH=${worktreePath}`)
      expect(envOutput).toContain(`AGENT_ORCH_PRJ_PATH=${repoPath}`)
    } finally {
      await app.close()
    }
  })

  test('new terminal tab button also injects env vars', async () => {
    const repoPath = createTestRepo('env-new-tab')
    const { app, window } = await launchApp()

    try {
      const { wsId } = await setupProjectAndWorkspace(window, repoPath)
      await window.waitForTimeout(2000)

      // Click "+" for new terminal — goes through createTerminalForActiveWorkspace
      const newTabBtn = window.locator('[class*="newTabButton"]')
      await expect(newTabBtn).toBeVisible()
      await newTabBtn.click()
      await window.waitForTimeout(2000)

      // Get the ptyId of the newest terminal tab
      const secondPtyId = await window.evaluate((wsId: string) => {
        const store = (window as any).__store.getState()
        const tabs = store.tabs.filter((t: any) => t.type === 'terminal' && t.workspaceId === wsId)
        return tabs[tabs.length - 1]?.ptyId
      }, wsId)
      expect(secondPtyId).toBeTruthy()

      const envOutput = await capturePtyOutput(window, secondPtyId, 'env | grep AGENT_ORCH')

      expect(envOutput).toContain('AGENT_ORCH_WS_PATH=')
      expect(envOutput).toContain('AGENT_ORCH_PRJ_PATH=')
    } finally {
      await app.close()
    }
  })
})

test.describe('Run hook', () => {
  test('executeRunHook creates a Run tab and fires the command', async () => {
    const repoPath = createTestRepo('run-hook')
    const { app, window } = await launchApp()

    try {
      await setupProjectAndWorkspace(window, repoPath, [
        { type: 'run', command: 'echo RUN_HOOK_FIRED' },
      ])

      // Execute the run hook and immediately start listening on the new PTY
      // so we don't miss the delayed write output
      const output = await window.evaluate(async () => {
        const store = (window as any).__store.getState()
        await store.executeRunHook()

        const tab = (window as any).__store.getState().tabs.find(
          (t: any) => t.type === 'terminal' && t.title === 'Run'
        )
        if (!tab) return ''

        return new Promise<string>((resolve) => {
          let buffer = ''
          const unsub = (window as any).api.pty.onData(tab.ptyId, (data: string) => {
            buffer += data
            if (buffer.includes('RUN_HOOK_FIRED')) {
              unsub()
              resolve(buffer)
            }
          })
          // Timeout fallback
          setTimeout(() => { unsub(); resolve(buffer) }, 5000)
        })
      })

      // Verify a "Run" tab was created
      const runTab = window.locator('[class*="tabTitle"]', { hasText: 'Run' }).first()
      await expect(runTab).toBeVisible()

      expect(output).toContain('RUN_HOOK_FIRED')
    } finally {
      await app.close()
    }
  })

  test('executeRunHook reuses existing Run tab on second invocation', async () => {
    const repoPath = createTestRepo('run-reuse')
    const { app, window } = await launchApp()

    try {
      await setupProjectAndWorkspace(window, repoPath, [
        { type: 'run', command: 'echo RUN_AGAIN' },
      ])

      // First invocation
      await window.evaluate(async () => {
        await (window as any).__store.getState().executeRunHook()
      })
      await window.waitForTimeout(1500)

      // Second invocation — should reuse the same tab
      await window.evaluate(async () => {
        await (window as any).__store.getState().executeRunHook()
      })
      await window.waitForTimeout(1000)

      // Only one "Run" tab should exist
      const runTabCount = await window.evaluate(() => {
        const store = (window as any).__store.getState()
        return store.tabs.filter((t: any) => t.title === 'Run').length
      })
      expect(runTabCount).toBe(1)
    } finally {
      await app.close()
    }
  })

  test('run hook terminal receives AGENT_ORCH env vars', async () => {
    const repoPath = createTestRepo('run-env')
    const { app, window } = await launchApp()

    try {
      await setupProjectAndWorkspace(window, repoPath, [
        { type: 'run', command: 'echo done' },
      ])

      await window.evaluate(async () => {
        await (window as any).__store.getState().executeRunHook()
      })
      await window.waitForTimeout(2000)

      const runPtyId = await window.evaluate(() => {
        const store = (window as any).__store.getState()
        const tab = store.tabs.find((t: any) => t.type === 'terminal' && t.title === 'Run')
        return tab?.ptyId as string
      })

      const envOutput = await capturePtyOutput(window, runPtyId, 'env | grep AGENT_ORCH')

      expect(envOutput).toContain('AGENT_ORCH_WS_PATH=')
      expect(envOutput).toContain('AGENT_ORCH_PRJ_PATH=')
    } finally {
      await app.close()
    }
  })
})
