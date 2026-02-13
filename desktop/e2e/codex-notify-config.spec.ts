import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const appPath = resolve(__dirname, '../out/main/index.js')

async function launchAppWithHome(homeDir: string): Promise<{ app: ElectronApplication; window: Page }> {
  const app = await electron.launch({
    args: [appPath],
    env: { ...process.env, CI_TEST: '1', HOME: homeDir },
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  return { app, window }
}

test.describe('Codex notify config', () => {
  test('installs top-level notify entry (not nested under table) and uninstalls cleanly', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'constellagent-codex-home-'))
    const codexDir = join(homeDir, '.codex')
    const configPath = join(codexDir, 'config.toml')
    mkdirSync(codexDir, { recursive: true })
    writeFileSync(
      configPath,
      [
        'model = "gpt-5.3-codex"',
        '',
        '[projects."/tmp/my-repo"]',
        'trust_level = "trusted"',
        '',
      ].join('\n'),
      'utf-8'
    )

    const { app, window } = await launchAppWithHome(homeDir)
    try {
      const installResult = await window.evaluate(async () => {
        const result = await (window as any).api.codex.installNotify()
        const check = await (window as any).api.codex.checkNotify()
        return { result, check }
      })
      expect(installResult.result.success).toBe(true)
      expect(installResult.check.installed).toBe(true)

      const installed = readFileSync(configPath, 'utf-8')
      const notifyIndex = installed.indexOf('notify = [')
      const projectsIndex = installed.indexOf('[projects.')
      expect(notifyIndex).toBeGreaterThanOrEqual(0)
      expect(projectsIndex).toBeGreaterThanOrEqual(0)
      expect(notifyIndex).toBeLessThan(projectsIndex)

      const uninstallResult = await window.evaluate(async () => {
        const result = await (window as any).api.codex.uninstallNotify()
        const check = await (window as any).api.codex.checkNotify()
        return { result, check }
      })
      expect(uninstallResult.result.success).toBe(true)
      expect(uninstallResult.check.installed).toBe(false)

      const removed = readFileSync(configPath, 'utf-8')
      expect(removed.includes('codex-hooks/notify.sh')).toBe(false)
      expect(removed.includes('[projects."/tmp/my-repo"]')).toBe(true)
    } finally {
      await app.close()
    }
  })
})
