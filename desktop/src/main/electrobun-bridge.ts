import { ApplicationMenu, BrowserView, Utils, type ApplicationMenuItemConfig, type RPCSchema } from 'electrobun/bun'
import type { BrowserWindow as ElectrobunWindow } from 'electrobun/bun'
import type { WebContentsLike, WindowRef } from './window-types'

interface IpcInvokeEvent {
  sender: WebContentsLike
}

interface IpcOnEvent extends IpcInvokeEvent {
  returnValue: unknown
}

type IpcInvokeHandler = (event: IpcInvokeEvent, ...args: any[]) => any
type IpcOnHandler = (event: IpcOnEvent, ...args: any[]) => void

const invokeHandlers = new Map<string, IpcInvokeHandler>()
const onHandlers = new Map<string, Set<IpcOnHandler>>()
const windows = new Map<number, WindowRef>()
const windowsByWebContentsId = new Map<number, WindowRef>()

let userDataPathOverride: string | null = null
let appName = 'Constellagent'

function emitToRenderer(webContents: WebContentsLike, channel: string, args: unknown[]): void {
  if (webContents.isDestroyed()) return
  webContents.send(channel, ...args)
}

function getDefaultWebContents(): WebContentsLike {
  const first = windows.values().next().value as WindowRef | undefined
  if (!first) {
    throw new Error('No renderer window available')
  }
  return first.webContents
}

async function dispatchInvoke(channel: string, args: any[]): Promise<any> {
  const handler = invokeHandlers.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  const sender = getDefaultWebContents()
  return handler({ sender }, ...args)
}

function dispatchSend(channel: string, args: any[]): any {
  const handlers = onHandlers.get(channel)
  if (!handlers || handlers.size === 0) return undefined
  const sender = getDefaultWebContents()
  const event: IpcOnEvent = { sender, returnValue: undefined }
  for (const handler of handlers) {
    handler(event, ...args)
  }
  return event.returnValue
}

export const ipcMain = {
  handle(channel: string, handler: IpcInvokeHandler): void {
    invokeHandlers.set(channel, handler)
  },
  on(channel: string, handler: IpcOnHandler): void {
    const listeners = onHandlers.get(channel) ?? new Set<IpcOnHandler>()
    listeners.add(handler)
    onHandlers.set(channel, listeners)
  },
}

export type IpcWebContents = WebContentsLike

type BridgeRPC = {
  bun: RPCSchema<{
    requests: {
      invoke: { params: { channel: string; args: any[] }; response: any }
      send: { params: { channel: string; args: unknown[] }; response: null }
      sendSync: { params: { channel: string; args: any[] }; response: any }
    }
    messages: {}
  }>
  webview: RPCSchema<{
    requests: {}
    messages: {
      ipcEvent: { channel: string; args: unknown[] }
    }
  }>
}

export function createMainRpc() {
  return BrowserView.defineRPC<BridgeRPC>({
    maxRequestTime: 120000,
    handlers: {
      requests: {
        invoke: async ({ channel, args }) => dispatchInvoke(channel, args),
        send: ({ channel, args }) => {
          dispatchSend(channel, args)
          return null
        },
        sendSync: ({ channel, args }) => dispatchSend(channel, args),
      },
      messages: {},
    },
  })
}

export function registerWindow(window: ElectrobunWindow<any>): WindowRef {
  let destroyed = false
  const webContents: WebContentsLike = {
    id: window.webview.id,
    send: (channel: string, ...args: unknown[]) => {
      if (destroyed) return
      ;(window.webview.rpc as any)?.send?.ipcEvent({ channel, args })
    },
    isDestroyed: () => destroyed,
  }

  const ref: WindowRef = {
    id: window.id,
    webContents,
    isDestroyed: () => destroyed,
  }

  windows.set(window.id, ref)
  windowsByWebContentsId.set(webContents.id, ref)

  window.on('close', () => {
    destroyed = true
    windows.delete(window.id)
    windowsByWebContentsId.delete(webContents.id)
  })

  return ref
}

export function getAllWindows(): WindowRef[] {
  return Array.from(windows.values())
}

export function getWindowFromWebContents(webContents: WebContentsLike): WindowRef | null {
  return windowsByWebContentsId.get(webContents.id) ?? null
}

export const app = {
  setName(name: string): void {
    appName = name
  },
  get name(): string {
    return appName
  },
  get isPackaged(): boolean {
    const env = process.env.ELECTROBUN_ENV
    return env === 'canary' || env === 'stable'
  },
  setPath(name: string, value: string): void {
    if (name === 'userData') {
      userDataPathOverride = value
    }
  },
  getPath(name: string): string {
    switch (name) {
      case 'userData':
        return userDataPathOverride ?? Utils.paths.userData
      case 'temp':
        return Utils.paths.temp
      case 'home':
        return Utils.paths.home
      case 'documents':
        return Utils.paths.documents
      case 'downloads':
        return Utils.paths.downloads
      default:
        throw new Error(`Unsupported app path: ${name}`)
    }
  },
}

export const dialog = {
  async showOpenDialog(options: { properties?: string[]; title?: string }) {
    const properties = options.properties ?? []
    const filePaths = (await Utils.openFileDialog({
      canChooseFiles: properties.includes('openFile') || !properties.includes('openDirectory'),
      canChooseDirectory: properties.includes('openDirectory'),
      allowsMultipleSelection: properties.includes('multiSelections'),
    })).filter((p) => p)
    return {
      canceled: filePaths.length === 0,
      filePaths,
    }
  },
}

export const clipboard = {
  readImage() {
    const pngData = Utils.clipboardReadImage()
    return {
      isEmpty: () => !pngData || pngData.length === 0,
      toPNG: () => Buffer.from(pngData ?? new Uint8Array()),
    }
  },
}

export const shell = {
  openExternal(url: string): void {
    Utils.openExternal(url)
  },
}

export type MenuItemConstructorOptions = {
  label?: string
  submenu?: MenuItemConstructorOptions[]
  role?: string
  type?: 'separator' | 'normal'
  accelerator?: string
  action?: string
}

function normalizeMenu(items: MenuItemConstructorOptions[]): ApplicationMenuItemConfig[] {
  return items.map((item) => {
    if (item.type === 'separator') return { type: 'divider' }
    return {
      type: 'normal',
      label: item.label,
      role: item.role,
      action: item.action,
      accelerator: item.accelerator,
      submenu: item.submenu ? normalizeMenu(item.submenu) : undefined,
    }
  })
}

export const Menu = {
  buildFromTemplate(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    return template
  },
  setApplicationMenu(template: MenuItemConstructorOptions[] | null): void {
    if (!template) {
      ApplicationMenu.setApplicationMenu([])
      return
    }
    ApplicationMenu.setApplicationMenu(normalizeMenu(template))
  },
}

export const powerMonitor = {
  on(_event: 'resume' | 'unlock-screen', _handler: () => void): void {},
}

export function sendToRenderer(channel: string, ...args: unknown[]): void {
  for (const win of windows.values()) {
    emitToRenderer(win.webContents, channel, args)
  }
}
