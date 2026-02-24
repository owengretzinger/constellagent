import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchAppWithHome(homeDir: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      CI_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      HOME: homeDir,
    },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  return { app, window }
}

function readSettings(settingsPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
}

function ourHookCommands(settings: Record<string, unknown>): string[] {
  const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command?: string }> }>> | undefined
  if (!hooks) return []

  const events = ['Stop', 'Notification', 'UserPromptSubmit', 'PreToolUse']
  const cmds: string[] = []
  for (const event of events) {
    for (const rule of hooks[event] ?? []) {
      for (const hook of rule.hooks ?? []) {
        const cmd = hook.command
        if (cmd && (
          cmd.includes('claude-hooks/notify.sh') ||
          cmd.includes('claude-hooks/activity.sh') ||
          cmd.includes('claude-hooks/question-notify.sh')
        )) {
          cmds.push(cmd)
        }
      }
    }
  }
  return cmds
}

test.describe('Claude hooks config', () => {
  test('installs shell-quoted hook commands and uninstalls cleanly', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'constellagent claude-home-'))
    const claudeDir = join(homeDir, '.claude')
    const settingsPath = join(claudeDir, 'settings.json')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'echo keep-me' }] },
          ],
        },
      }, null, 2),
      'utf-8'
    )

    const { app, window } = await launchAppWithHome(homeDir)
    try {
      const installResult = await window.evaluate(async () => {
        const result = await (window as any).api.claude.installHooks()
        const check = await (window as any).api.claude.checkHooks()
        return { result, check }
      })
      expect(installResult.result.success).toBe(true)
      expect(installResult.check.installed).toBe(true)

      const installed = readSettings(settingsPath)
      const commands = ourHookCommands(installed)
      expect(commands.length).toBe(4)
      for (const cmd of commands) {
        expect(cmd.startsWith("'")).toBe(true)
        expect(cmd.endsWith("'")).toBe(true)
      }

      const uninstallResult = await window.evaluate(async () => {
        const result = await (window as any).api.claude.uninstallHooks()
        const check = await (window as any).api.claude.checkHooks()
        return { result, check }
      })
      expect(uninstallResult.result.success).toBe(true)
      expect(uninstallResult.check.installed).toBe(false)

      const removed = readSettings(settingsPath)
      expect(ourHookCommands(removed).length).toBe(0)
      const hooks = removed.hooks as Record<string, unknown[]> | undefined
      expect((hooks?.Stop ?? []).length).toBe(1)
    } finally {
      await app.close()
    }
  })
})
