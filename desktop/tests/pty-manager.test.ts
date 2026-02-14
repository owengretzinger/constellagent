import { describe, expect, mock, test } from 'bun:test'

const spawnMock = mock((_file: string, _args: string[], _options: Record<string, unknown>) => {
  let onDataHandler: ((data: string) => void) | undefined
  let onExitHandler: ((event: { exitCode: number }) => void) | undefined

  return {
    pid: 99999,
    onData: (handler: (data: string) => void) => {
      onDataHandler = handler
      return undefined
    },
    onExit: (handler: (event: { exitCode: number }) => void) => {
      onExitHandler = handler
      return undefined
    },
    write: (_data: string) => undefined,
    resize: (_cols: number, _rows: number) => undefined,
    kill: () => {
      onExitHandler?.({ exitCode: 0 })
      return undefined
    },
    __emitData: (data: string) => onDataHandler?.(data),
  }
})

mock.module('node-pty', () => ({
  spawn: spawnMock,
}))

mock.module('electron', () => ({
  WebContents: class WebContents {},
}))

const { PtyManager } = await import('../src/main/pty-manager')

describe('PtyManager shell launch', () => {
  const webContents = {
    isDestroyed: () => false,
    send: () => undefined,
  }

  test('uses login shell args by default', () => {
    spawnMock.mockClear()

    const manager = new PtyManager()

    manager.create('/tmp', webContents as never)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const call = spawnMock.mock.calls[0]
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual(['-l'])
  })

  test('can disable login shell args', () => {
    spawnMock.mockClear()

    const manager = new PtyManager()

    manager.create('/tmp', webContents as never, undefined, undefined, undefined, undefined, false)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const call = spawnMock.mock.calls[0]
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual([])
  })

  test('does not prepend login args for explicit command launch', () => {
    spawnMock.mockClear()

    const manager = new PtyManager()

    manager.create('/tmp', webContents as never, undefined, ['git', 'status'], undefined, undefined, true)

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const call = spawnMock.mock.calls[0]
    expect(call).toBeDefined()
    expect(call?.[0]).toBe('git')
    expect(call?.[1]).toEqual(['status'])
  })
})
