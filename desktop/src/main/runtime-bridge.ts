import type { RuntimeEventPayload } from '../shared/electrobun-rpc'

export interface RendererConnection {
  id: number
  send: (channel: string, ...args: unknown[]) => void
  isDestroyed: () => boolean
}

let nextRendererId = 1
let activeRenderer: RendererConnection | null = null

export function registerRenderer(
  emit: (payload: RuntimeEventPayload) => void,
): RendererConnection {
  const id = nextRendererId++
  const renderer: RendererConnection = {
    id,
    send: (channel, ...args) => emit({ channel, args }),
    isDestroyed: () => activeRenderer?.id !== id,
  }
  activeRenderer = renderer
  return renderer
}

export function unregisterRenderer(rendererId?: number): void {
  if (!activeRenderer) return
  if (rendererId && activeRenderer.id !== rendererId) return
  activeRenderer = null
}

export function getRendererConnection(): RendererConnection | null {
  return activeRenderer
}

export function requireRendererConnection(): RendererConnection {
  if (!activeRenderer) {
    throw new Error('Renderer connection is not ready')
  }
  return activeRenderer
}

export function broadcastToRenderer(channel: string, ...args: unknown[]): void {
  if (!activeRenderer || activeRenderer.isDestroyed()) return
  activeRenderer.send(channel, ...args)
}
