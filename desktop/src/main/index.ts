import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'

const isTerminalHostDaemon = process.argv.includes('--terminal-host-daemon')

if (isTerminalHostDaemon) {
  void import('./terminal-host/index')
}

if (!isTerminalHostDaemon) {
  void startMainProcess()
}

async function startMainProcess(): Promise<void> {
  const { app, BrowserWindow, Menu, shell } = await import('electron')

  let mainWindow: BrowserWindow | null = null
  let notificationWatcher: { start: () => void; stop: () => void } | null = null

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 900,
      minHeight: 600,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 12 },
      backgroundColor: '#13141b',
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // needed for node-pty IPC
      },
    })

    // Show window when ready to avoid white flash (skip in tests)
    if (!process.env.CI_TEST) {
      mainWindow.on('ready-to-show', () => {
        mainWindow?.show()
      })
    }

    // Open external links in browser
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    // Load renderer
    if (process.env.ELECTRON_RENDERER_URL) {
      mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  app.setName('Constellagent')

  // Isolate test data so e2e tests never touch real app state
  if (process.env.CI_TEST) {
    const { mkdtempSync } = require('fs')
    const { join } = require('path')
    const testData = process.env.CONSTELLAGENT_TEST_USER_DATA || mkdtempSync(join(require('os').tmpdir(), 'constellagent-test-'))
    app.setPath('userData', testData)
    process.env.CONSTELLAGENT_NOTIFY_DIR ||= join(testData, 'notify')
    process.env.CONSTELLAGENT_ACTIVITY_DIR ||= join(testData, 'activity')
    process.env.CONSTELLAGENT_DAEMON_HOME ||= join(testData, 'terminal-host')
  }

  app.whenReady().then(async () => {
    const isDev = !!process.env.ELECTRON_RENDERER_URL
    const [{ registerIpcHandlers }, { NotificationWatcher }] = await Promise.all([
      import('./ipc'),
      import('./notification-watcher'),
    ])

    // Custom menu: keep standard Edit shortcuts (copy/paste/undo) but remove
    // Cmd+W (close window) and Cmd+N (new window) so they reach the renderer
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
    ...(isDev
      ? [{
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { type: 'separator' },
            { role: 'toggleDevTools' },
          ],
        }]
      : []),
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }],
    },
    ]
    const menu = Menu.buildFromTemplate(menuTemplate)
    Menu.setApplicationMenu(menu)

    registerIpcHandlers()
    if (!process.env.CI_TEST) {
      void import('./terminal-reconcile').then((m) => m.reconcileTerminalSessionsOnStartup())
    }
    notificationWatcher = new NotificationWatcher()
    notificationWatcher.start()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('before-quit', () => {
    notificationWatcher?.stop()
  })
}
