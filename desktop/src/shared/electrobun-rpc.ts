import type { RPCSchema } from 'electrobun/bun'

export interface RuntimeInvokePayload {
  channel: string
  args: unknown[]
}

export interface RuntimeEventPayload {
  channel: string
  args: unknown[]
}

export type DesktopRuntimeRPC = {
  bun: RPCSchema<{
    requests: {
      invoke: {
        params: RuntimeInvokePayload
        response: unknown
      }
      send: {
        params: RuntimeInvokePayload
        response: void
      }
    }
    messages: {}
  }>
  webview: RPCSchema<{
    requests: {}
    messages: {
      event: RuntimeEventPayload
    }
  }>
}
