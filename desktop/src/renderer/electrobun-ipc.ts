import Electrobun, { Electroview, type RPCSchema } from 'electrobun/view'

export interface IpcRendererEvent {
  sender: null
}

type IpcListener = (event: IpcRendererEvent, ...args: any[]) => void

type BridgeRPC = {
  bun: RPCSchema<{
    requests: {
      invoke: { params: { channel: string; args: any[] }; response: any }
      send: { params: { channel: string; args: any[] }; response: null }
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

const listeners = new Map<string, Set<IpcListener>>()

const rpc = Electroview.defineRPC<BridgeRPC>({
  maxRequestTime: 120000,
  handlers: {
    requests: {},
    messages: {
      ipcEvent: ({ channel, args }) => {
        const channelListeners = listeners.get(channel)
        if (!channelListeners) return
        for (const listener of channelListeners) {
          listener({ sender: null }, ...args)
        }
      },
    },
  },
})

const electrobun = new Electrobun.Electroview({ rpc })

export const ipcRenderer = {
  invoke: (channel: string, ...args: any[]): Promise<any> =>
    electrobun.rpc!.request.invoke({ channel, args }),
  send: (channel: string, ...args: any[]): void => {
    void electrobun.rpc!.request.send({ channel, args })
  },
  sendSync: (channel: string, ...args: any[]): Promise<any> =>
    electrobun.rpc!.request.sendSync({ channel, args }),
  on: (channel: string, listener: IpcListener) => {
    const channelListeners = listeners.get(channel) ?? new Set<IpcListener>()
    channelListeners.add(listener)
    listeners.set(channel, channelListeners)
  },
  removeListener: (channel: string, listener: IpcListener) => {
    const channelListeners = listeners.get(channel)
    if (!channelListeners) return
    channelListeners.delete(listener)
    if (channelListeners.size === 0) listeners.delete(channel)
  },
}

export const contextBridge = {
  exposeInMainWorld: (key: string, api: unknown) => {
    ;(window as unknown as Record<string, unknown>)[key] = api
  },
}
