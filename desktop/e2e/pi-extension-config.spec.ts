import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { resolve, join } from 'path'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
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

test.describe('Pi extension config', () => {
  test('installs and uninstalls interactive activity extension', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'constellagent-pi-home-'))
    const extensionPath = join(homeDir, '.pi', 'agent', 'extensions', 'constellagent-activity.ts')

    const { app, window } = await launchAppWithHome(homeDir)
    try {
      const installResult = await window.evaluate(async () => {
        const result = await (window as any).api.pi.installActivityExtension()
        const check = await (window as any).api.pi.checkActivityExtension()
        return { result, check }
      })

      expect(installResult.result?.success).toBe(true)
      expect(installResult.check?.installed).toBe(true)
      expect(existsSync(extensionPath)).toBe(true)

      const installed = readFileSync(extensionPath, 'utf-8')
      expect(installed.includes('Constellagent pi-mono activity extension')).toBe(true)

      const uninstallResult = await window.evaluate(async () => {
        const result = await (window as any).api.pi.uninstallActivityExtension()
        const check = await (window as any).api.pi.checkActivityExtension()
        return { result, check }
      })

      expect(uninstallResult.result?.success).toBe(true)
      expect(uninstallResult.check?.installed).toBe(false)
      expect(existsSync(extensionPath)).toBe(false)
    } finally {
      await app.close()
    }
  })
})
