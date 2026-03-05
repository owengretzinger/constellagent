import Electrobun, { BrowserWindow } from 'electrobun/bun'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { registerIpcHandlers } from './ipc'
import { NotificationWatcher } from './notification-watcher'
import { Menu, app, createMainRpc, registerWindow, shell, type MenuItemConstructorOptions } from './electrobun-bridge'

let notificationWatcher: NotificationWatcher | null = null

async function getMainViewUrl(): Promise<string> {
  try {
    await fetch('http://localhost:5173', { method: 'HEAD' })
    return 'http://localhost:5173'
  } catch {
    return 'views://mainview/index.html'
  }
}

async function createWindow(): Promise<void> {
  const url = await getMainViewUrl()
  const mainWindow = new BrowserWindow({
    titleBarStyle: 'hiddenInset',
    title: 'Constellagent',
    url,
    frame: {
      width: 1400,
      height: 900,
      x: 80,
      y: 80,
    },
    rpc: createMainRpc(),
  })
  registerWindow(mainWindow)

  ;(mainWindow.webview as any).on('new-window-open', (event: unknown) => {
    const detail = (event as { data?: { detail?: unknown } })?.data?.detail
    const url =
      typeof detail === 'string'
        ? detail
        : (detail && typeof detail === 'object' && 'url' in detail)
          ? String((detail as { url: unknown }).url)
          : null
    if (url) shell.openExternal(url)
  })
}

app.setName('Constellagent')

// Isolate test data so e2e tests never touch real app state
if (process.env.CI_TEST) {
  const testData = mkdtempSync(join(tmpdir(), 'constellagent-test-'))
  app.setPath('userData', testData)
  process.env.CONSTELLAGENT_AGENT_EVENT_DIR ||= join(testData, 'agent-events')
}

// Custom menu: keep standard Edit shortcuts but avoid native new-window actions.
const menuTemplate: MenuItemConstructorOptions[] = [
  {
    label: app.name,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  },
]
Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))

registerIpcHandlers()
notificationWatcher = new NotificationWatcher()
notificationWatcher.start()
void createWindow()

Electrobun.events.on('before-quit', () => {
  notificationWatcher?.stop()
})
