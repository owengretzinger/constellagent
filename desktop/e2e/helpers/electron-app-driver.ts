import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join, resolve } from 'path'

const appPath = resolve(__dirname, '../../out/main/index.js')
const TMP_DIR = '/tmp'

export interface ControlledElectronApp {
  app: ElectronApplication
  window: Page
  eventDir: string
}

export async function launchControlledApp(label: string): Promise<ControlledElectronApp> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const eventDir = join(TMP_DIR, `constellagent-agent-events-${suffix}`)

  const app = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      CI_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      CONSTELLAGENT_AGENT_EVENT_DIR: eventDir,
    },
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(1500)

  return { app, window, eventDir }
}
