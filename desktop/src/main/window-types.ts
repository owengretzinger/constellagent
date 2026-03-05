export interface WebContentsLike {
  id: number
  send: (channel: string, ...args: unknown[]) => void
  isDestroyed: () => boolean
}

export interface WindowRef {
  id: number
  webContents: WebContentsLike
  isDestroyed: () => boolean
}
