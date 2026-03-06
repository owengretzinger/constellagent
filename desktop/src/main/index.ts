import Electrobun, { ApplicationMenu, BrowserView, BrowserWindow } from 'electrobun/bun'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { handleInvoke, handleSend, registerIpcHandlers } from './ipc'
import { NotificationWatcher } from './notification-watcher'
import type { DesktopRuntimeRPC, RuntimeEventPayload } from '../shared/electrobun-rpc'
import { registerRenderer, unregisterRenderer } from './runtime-bridge'

let mainWindow: BrowserWindow | null = null
let notificationWatcher: NotificationWatcher | null = null
let rendererId: number | null = null

async function getMainViewUrl(): Promise<string> {
  return process.env.ELECTROBUN_RENDERER_URL || 'views://mainview/index.html'
}

function setApplicationMenu(): void {
  ApplicationMenu.setApplicationMenu([
    {
      label: 'Constellagent',
      submenu: [
        { role: 'about' },
        { type: 'divider' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'divider' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'divider' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }],
    },
  ])
}

async function createWindow(): Promise<void> {
  const rpc = BrowserView.defineRPC<DesktopRuntimeRPC>({
    maxRequestTime: 120_000,
    handlers: {
      requests: {
        invoke: async ({ channel, args }) => handleInvoke(channel, args),
        send: async ({ channel, args }) => {
          await handleSend(channel, args)
        },
      },
      messages: {},
    },
  })

  const url = await getMainViewUrl()
  mainWindow = new BrowserWindow({
    title: 'Constellagent',
    url,
    frame: {
      x: 100,
      y: 80,
      width: 1400,
      height: 900,
    },
    titleBarStyle: 'hiddenInset',
    rpc,
  })

  const renderer = registerRenderer((payload) => {
    const rpc = mainWindow?.webview.rpc as { send?: (name: 'event', payload: RuntimeEventPayload) => void } | undefined
    rpc?.send?.('event', payload)
  })
  rendererId = renderer.id

  mainWindow.on('close', () => {
    if (rendererId) unregisterRenderer(rendererId)
    rendererId = null
    mainWindow = null
  })
}

process.env.CONSTELLAGENT_RESOURCE_ROOT ||= process.cwd()

if (process.env.CI_TEST) {
  const testData = mkdtempSync(join(tmpdir(), 'constellagent-test-'))
  process.env.CONSTELLAGENT_USER_DATA_DIR ||= testData
  process.env.CONSTELLAGENT_AGENT_EVENT_DIR ||= join(testData, 'agent-events')
}

registerIpcHandlers()
setApplicationMenu()
notificationWatcher = new NotificationWatcher()
notificationWatcher.start()
await createWindow()

Electrobun.events.on('before-quit', () => {
  notificationWatcher?.stop()
})
