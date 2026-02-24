import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { join, resolve } from 'path'

const appPath = resolve(__dirname, '../../out/main/index.js')
const TMP_DIR = '/tmp'

export interface ControlledElectronApp {
  app: ElectronApplication
  window: Page
  notifyDir: string
  activityDir: string
  eventDir: string
}

export async function launchControlledApp(label: string): Promise<ControlledElectronApp> {
  const suffix = `${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const notifyDir = join(TMP_DIR, `constellagent-notify-${suffix}`)
  const activityDir = join(TMP_DIR, `constellagent-activity-${suffix}`)
  const eventDir = join(TMP_DIR, `constellagent-agent-events-${suffix}`)

  const app = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      CI_TEST: '1',
      ELECTRON_RENDERER_URL: '',
      CONSTELLAGENT_NOTIFY_DIR: notifyDir,
      CONSTELLAGENT_ACTIVITY_DIR: activityDir,
      CONSTELLAGENT_AGENT_EVENT_DIR: eventDir,
    },
  })

  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('#root', { timeout: 10000 })
  await window.waitForTimeout(1500)

  return { app, window, notifyDir, activityDir, eventDir }
}
