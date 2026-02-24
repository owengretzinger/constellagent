import { test, expect, _electron as electron } from '@playwright/test'
import { resolve } from 'path'

const appPath = resolve(__dirname, '../out/main/index.js')

test('Phase 1: app launches with 3-panel layout', async () => {
  const app = await electron.launch({
    args: [appPath],
    env: { ...process.env, CI_TEST: '1', ELECTRON_RENDERER_URL: '' },
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  // Wait for React to render
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(2000)

  // Take screenshot
  await window.screenshot({
    path: resolve(__dirname, 'screenshots/phase1-layout.png'),
  })

  // Check 3-panel layout exists
  const sidebar = await window.locator('[class*="sidebar"]').count()
  const rightPanel = await window.locator('[class*="rightPanel"]').count()

  expect(sidebar).toBeGreaterThan(0)
  expect(rightPanel).toBeGreaterThan(0)

  // Check welcome message renders
  const welcomeText = await window.locator('[class*="welcomeLogo"]').textContent()
  expect(welcomeText).toContain('constellagent')

  await app.close()
})
