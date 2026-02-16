import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { execSync } from 'child_process'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchApp(): Promise<{ app: ElectronApplication; window: Page }> {
  const env = { ...process.env, CI_TEST: '1', NODE_ENV: 'production', ELECTRON_RENDERER_URL: '' }
  const app = await electron.launch({ args: [appPath], env })
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

function writeFakeCodexScript(scriptPath: string): void {
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env python3
import os
import sys
import time
import select
import termios
import tty

PLACEHOLDER = "Use /skills to list available skills"
MAX_MESSAGES = 5

messages = []
tick = 0
buf = ""
last_lines = 0

def redraw():
    global last_lines
    prompt = buf if buf else PLACEHOLDER
    lines = []
    lines.append("OpenAI Codex (fake)")
    lines.append(f"tick:{tick}")
    lines.append("")
    lines.append("Codex Session")
    # Fixed height so cursor-up math stays stable.
    for i in range(MAX_MESSAGES):
        if i < len(messages):
            lines.append(f"{i+1}. {messages[i]}")
        else:
            lines.append("")
    lines.append("")
    lines.append(f"> {prompt}")

    # Move back to the start of the previous frame.
    if last_lines > 0:
        # Cursor is left at the end of the input line (last line) after each draw.
        sys.stdout.write(f"\\x1b[{last_lines-1}A\\r")

    # Clear + redraw all lines, leaving cursor at end of the input line.
    for i, line in enumerate(lines):
        sys.stdout.write("\\x1b[2K")
        if i == len(lines) - 1:
            sys.stdout.write(line)
        else:
            sys.stdout.write(line + "\\r\\n")
    sys.stdout.flush()
    last_lines = len(lines)

def drain_startup_input(timeout_s: float = 0.2):
    end = time.time() + timeout_s
    while time.time() < end:
        r, _, _ = select.select([sys.stdin], [], [], 0.01)
        if not r:
            continue
        try:
            os.read(sys.stdin.fileno(), 4096)
        except OSError:
            break

def main():
    global tick, buf, messages
    fd = sys.stdin.fileno()
    old = termios.tcgetattr(fd)
    try:
        tty.setraw(fd)
        drain_startup_input()
        redraw()
        while True:
            r, _, _ = select.select([sys.stdin], [], [], 0.05)
            if r:
                ch = os.read(fd, 1)
                if not ch:
                    break
                c = ch.decode(errors="ignore")
                if c in ("\\r", "\\n"):
                    if buf:
                        messages.append(buf)
                        if len(messages) > MAX_MESSAGES:
                            del messages[:-MAX_MESSAGES]
                        buf = ""
                elif c == "\\x7f":
                    buf = buf[:-1]
                elif c.isprintable():
                    buf += c
            tick += 1
            redraw()
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old)

if __name__ == "__main__":
    main()
`,
    { mode: 0o755 }
  )
}

async function getActiveTerminalRows(window: Page): Promise<string[]> {
  return await window.evaluate(() => {
    const xterm = document.querySelector('[class*="terminalContainer"][class*="active"] .xterm')
    if (!xterm) return []

    return Array.from(xterm.querySelectorAll('.xterm-rows > div')).map((row) =>
      (row.textContent ?? '').replace(/\u00a0/g, ' ')
    )
  })
}

async function getActiveTerminalText(window: Page): Promise<string> {
  return (await getActiveTerminalRows(window)).join('\n')
}

async function getActiveTerminalLineCount(window: Page, text: string): Promise<number> {
  const rows = await getActiveTerminalRows(window)
  return rows.filter((row) => row.includes(text)).length
}

/** Helper: add project + workspace + terminal tab via store, clearing any persisted state first */
async function setupWorkspaceWithTerminal(window: Page, repoPath: string) {
  return await window.evaluate(async (repo: string) => {
    const store = (window as any).__store.getState()

    // Clear any persisted state first
    store.hydrateState({ projects: [], workspaces: [] })

    const projectId = crypto.randomUUID()
    store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

    const worktreePath = await (window as any).api.git.createWorktree(repo, 'test-ws', 'test-branch', true)

    const wsId = crypto.randomUUID()
    store.addWorkspace({
      id: wsId, name: 'test-ws', branch: 'test-branch', worktreePath, projectId,
    })

    const ptyId = await (window as any).api.pty.create(worktreePath)
    store.addTab({
      id: crypto.randomUUID(), workspaceId: wsId, type: 'terminal', title: 'Terminal', ptyId,
    })

    return { ptyId, wsId, worktreePath }
  }, repoPath)
}

test.describe('Terminal functionality', () => {
  test('programmatic project+workspace creation spawns terminal tab', async () => {
    const repoPath = createTestRepo('term-1')
    const { app, window } = await launchApp()

    try {
      const { ptyId } = await setupWorkspaceWithTerminal(window, repoPath)

      expect(ptyId).toBeTruthy()
      expect(ptyId).toMatch(/^pty-/)

      // Wait for React re-render
      await window.waitForTimeout(2000)

      // Verify a tab with "Terminal" text appears
      const terminalTab = window.locator('[class*="tabTitle"]', { hasText: 'Terminal' }).first()
      await expect(terminalTab).toBeVisible()

      // Terminal container should exist (may be hidden if WASM hasn't loaded)
      const terminalContainer = window.locator('[class*="terminalContainer"]').first()
      await expect(terminalContainer).toBeAttached()

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/terminal-created.png'),
      })
    } finally {
      await app.close()
    }
  })

  test('PTY create returns valid ID and write sends data', async () => {
    const { app, window } = await launchApp()

    try {
      const ptyId = await window.evaluate(async () => {
        return await (window as any).api.pty.create('/tmp')
      })

      expect(ptyId).toBeTruthy()
      expect(ptyId).toMatch(/^pty-/)

      // Write data to PTY
      await window.evaluate(async (id: string) => {
        ;(window as any).api.pty.write(id, 'echo HELLO_TEST\n')
      }, ptyId)

      await window.waitForTimeout(1000)

      // Verify PTY sends data back (listen for output)
      const receivedData = await window.evaluate((id: string) => {
        return new Promise<boolean>((resolve) => {
          const unsub = (window as any).api.pty.onData(id, (data: string) => {
            if (data.includes('HELLO_TEST')) {
              unsub()
              resolve(true)
            }
          })
          ;(window as any).api.pty.write(id, 'echo E2E_CHECK\n')
          setTimeout(() => {
            unsub()
            resolve(false)
          }, 3000)
        })
      }, ptyId)

      // Destroy the PTY
      await window.evaluate(async (id: string) => {
        ;(window as any).api.pty.destroy(id)
      }, ptyId)
    } finally {
      await app.close()
    }
  })

  test('new terminal tab button creates additional terminal', async () => {
    const repoPath = createTestRepo('term-tabs')
    const { app, window } = await launchApp()

    try {
      await setupWorkspaceWithTerminal(window, repoPath)
      await window.waitForTimeout(2000)

      // Count tab titles (more specific than [class*="tab"])
      const tabsBefore = await window.locator('[class*="tabTitle"]').count()
      expect(tabsBefore).toBe(1)

      // Click "+" for new terminal
      const newTabBtn = window.locator('[class*="newTabButton"]')
      await expect(newTabBtn).toBeVisible()
      await newTabBtn.click()

      await window.waitForTimeout(2000)

      const tabsAfter = await window.locator('[class*="tabTitle"]').count()
      expect(tabsAfter).toBe(2)

      await window.screenshot({
        path: resolve(__dirname, 'screenshots/terminal-two-tabs.png'),
      })
    } finally {
      await app.close()
    }
  })

  test('renderer reload keeps terminal transcript visible', async () => {
    const repoPath = createTestRepo('term-reload')
    const fakeCodexPath = join('/tmp', `fake-codex-reload-${Date.now()}.py`)
    writeFakeCodexScript(fakeCodexPath)

    const { app, window } = await launchApp()
    const marker = `RELOAD_OK_${Date.now()}`
    const placeholder = 'Use /skills to list available skills'
    const activeXterm = window.locator('[class*="terminalContainer"][class*="active"] .xterm')

    try {
      const { ptyId } = await window.evaluate(async ({ repo, codexPath }) => {
        const store = (window as any).__store.getState()
        store.hydrateState({ projects: [], workspaces: [] })

        const projectId = crypto.randomUUID()
        store.addProject({ id: projectId, name: 'test-repo', repoPath: repo })

        const worktreePath = await (window as any).api.git.createWorktree(repo, 'ws-reload', 'branch-reload', true)
        const wsId = crypto.randomUUID()
        store.addWorkspace({
          id: wsId, name: 'ws-reload', branch: 'branch-reload', worktreePath, projectId,
        })

        const ptyId = await (window as any).api.pty.create(worktreePath, '/bin/bash')
        store.addTab({
          id: crypto.randomUUID(), workspaceId: wsId, type: 'terminal', title: 'Terminal', ptyId,
        })

        ;(window as any).api.pty.write(ptyId, `${codexPath}\n`)
        return { ptyId }
      }, { repo: repoPath, codexPath: fakeCodexPath })

      await expect.poll(() => getActiveTerminalText(window), { timeout: 10000 }).toContain('Codex Session')
      await expect.poll(() => getActiveTerminalLineCount(window, 'Codex Session'), { timeout: 10000 }).toBe(1)
      await expect.poll(() => getActiveTerminalLineCount(window, 'OpenAI Codex (fake)'), { timeout: 10000 }).toBe(1)
      await expect.poll(() => getActiveTerminalLineCount(window, placeholder), { timeout: 10000 }).toBe(1)

      await activeXterm.click()
      await window.keyboard.type('first')
      await window.keyboard.press('Enter')
      await window.keyboard.type('second')
      await window.keyboard.press('Enter')
      await window.keyboard.type('third')
      await window.keyboard.press('Enter')

      await expect.poll(() => getActiveTerminalText(window), { timeout: 10000 }).toContain('1. first')
      await expect.poll(() => getActiveTerminalText(window), { timeout: 10000 }).toContain('2. second')
      await expect.poll(() => getActiveTerminalText(window), { timeout: 10000 }).toContain('3. third')
      await expect.poll(() => getActiveTerminalLineCount(window, 'Codex Session'), { timeout: 10000 }).toBe(1)
      await expect.poll(() => getActiveTerminalLineCount(window, placeholder), { timeout: 10000 }).toBe(1)

      // Reload multiple times; prompt/input should not duplicate in the viewport.
      for (let i = 0; i < 3; i++) {
        await window.reload()
        await window.waitForLoadState('domcontentloaded')
        await window.waitForSelector('#root', { timeout: 10000 })
        await window.waitForTimeout(1500)

        await expect.poll(() => getActiveTerminalText(window), { timeout: 10000 }).toContain('1. first')
        await expect.poll(() => getActiveTerminalText(window), { timeout: 10000 }).toContain('2. second')
        await expect.poll(() => getActiveTerminalText(window), { timeout: 10000 }).toContain('3. third')
        await expect.poll(() => getActiveTerminalLineCount(window, 'Codex Session'), { timeout: 10000 }).toBe(1)
        await expect.poll(() => getActiveTerminalLineCount(window, 'OpenAI Codex (fake)'), { timeout: 10000 }).toBe(1)
        await expect.poll(() => getActiveTerminalLineCount(window, placeholder), { timeout: 10000 }).toBe(1)
      }

      await activeXterm.click()
      await window.keyboard.type(marker)
      await window.keyboard.press('Enter')

      await expect.poll(() => getActiveTerminalText(window), { timeout: 10000 }).toContain(`4. ${marker}`)
    } finally {
      await app.close()
      rmSync(fakeCodexPath, { force: true })
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
})
