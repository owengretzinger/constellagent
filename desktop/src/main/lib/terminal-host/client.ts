import { spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { app } from 'electron'
import { connect, Socket } from 'net'
import { join } from 'path'
import {
  TERMINAL_HOST_PROTOCOL_VERSION,
  type TerminalHostCreateOrAttachRequest,
  type TerminalHostCreateOrAttachResponse,
  type TerminalHostDetachRequest,
  type TerminalHostEventEnvelope,
  type TerminalHostKillRequest,
  type TerminalHostListSessionsResponse,
  type TerminalHostRequest,
  type TerminalHostResizeRequest,
  type TerminalHostResponse,
  type TerminalHostWriteRequest,
} from './types'

const CONNECT_TIMEOUT_MS = 2000
const REQUEST_TIMEOUT_MS = 15000
const SPAWN_WAIT_TIMEOUT_MS = 15000
const SPAWN_LOCK_TIMEOUT_MS = 10_000

enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
}

interface PendingRequest {
  resolve: (payload: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface Paths {
  home: string
  socketPath: string
  tokenPath: string
  pidPath: string
  spawnLockPath: string
}

function resolveSocketPath(home: string): string {
  const defaultPath = join(home, 'terminal-host.sock')
  if (Buffer.byteLength(defaultPath, 'utf8') <= 96) {
    return defaultPath
  }

  const baseTmp = process.env.TMPDIR || '/tmp'
  const hash = createHash('sha1').update(home).digest('hex').slice(0, 16)
  return join(baseTmp, `constellagent-th-${hash}.sock`)
}

function daemonHome(): string {
  return process.env.CONSTELLAGENT_DAEMON_HOME || join(app.getPath('userData'), 'terminal-host')
}

function daemonPaths(): Paths {
  const home = daemonHome()
  return {
    home,
    socketPath: resolveSocketPath(home),
    tokenPath: join(home, 'terminal-host.token'),
    pidPath: join(home, 'terminal-host.pid'),
    spawnLockPath: join(home, 'terminal-host.spawn.lock'),
  }
}

function ensureDaemonHome(paths: Paths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 })
  try {
    chmodSync(paths.home, 0o700)
  } catch {
    // Best effort.
  }
}

class NdjsonParser {
  private buffer = ''

  parse(chunk: string): Array<TerminalHostResponse | TerminalHostEventEnvelope> {
    this.buffer += chunk
    const out: Array<TerminalHostResponse | TerminalHostEventEnvelope> = []
    let idx = this.buffer.indexOf('\n')
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.trim()) {
        try {
          out.push(JSON.parse(line) as TerminalHostResponse | TerminalHostEventEnvelope)
        } catch {
          // Ignore malformed frame.
        }
      }
      idx = this.buffer.indexOf('\n')
    }
    return out
  }
}

export class TerminalHostClient extends EventEmitter {
  private controlSocket: Socket | null = null
  private streamSocket: Socket | null = null
  private state: ConnectionState = ConnectionState.Disconnected
  private controlParser = new NdjsonParser()
  private streamParser = new NdjsonParser()
  private pending = new Map<string, PendingRequest>()
  private reqSeq = 0
  private readonly clientId = randomUUID()

  async ensureConnected(): Promise<void> {
    if (this.state === ConnectionState.Connected && this.controlSocket && this.streamSocket) {
      return
    }
    if (this.state === ConnectionState.Connecting) {
      await new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const timer = setInterval(() => {
          if (this.state === ConnectionState.Connected) {
            clearInterval(timer)
            resolve()
            return
          }
          if (this.state === ConnectionState.Disconnected) {
            clearInterval(timer)
            reject(new Error('Connection failed'))
            return
          }
          if (Date.now() - start > REQUEST_TIMEOUT_MS) {
            clearInterval(timer)
            reject(new Error('Timed out while waiting for daemon connection'))
          }
        }, 50)
      })
      return
    }

    this.state = ConnectionState.Connecting
    try {
      await this.connectAndAuthenticate()
      this.state = ConnectionState.Connected
    } catch (error) {
      this.resetConnection(false)
      throw error
    }
  }

  async createOrAttach(request: TerminalHostCreateOrAttachRequest): Promise<TerminalHostCreateOrAttachResponse> {
    await this.ensureConnected()
    return this.sendRequest<TerminalHostCreateOrAttachResponse>('createOrAttach', request)
  }

  async write(request: TerminalHostWriteRequest): Promise<void> {
    await this.ensureConnected()
    await this.sendRequest('write', request)
  }

  async resize(request: TerminalHostResizeRequest): Promise<void> {
    await this.ensureConnected()
    await this.sendRequest('resize', request)
  }

  async detach(request: TerminalHostDetachRequest): Promise<void> {
    await this.ensureConnected()
    await this.sendRequest('detach', request)
  }

  async kill(request: TerminalHostKillRequest): Promise<void> {
    await this.ensureConnected()
    await this.sendRequest('kill', request)
  }

  async listSessions(): Promise<TerminalHostListSessionsResponse> {
    await this.ensureConnected()
    return this.sendRequest<TerminalHostListSessionsResponse>('listSessions', {})
  }

  async shutdownIfRunning(killSessions = false): Promise<void> {
    const connected = await this.tryConnectControl()
    if (!connected) return

    try {
      const token = this.readToken()
      await this.sendRawRequestOnControl('hello', {
        token,
        protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
        clientId: this.clientId,
        role: 'control',
      })
      await this.sendRawRequestOnControl('shutdown', { killSessions })
    } catch {
      // Ignore shutdown failures.
    } finally {
      this.resetConnection(false)
    }
  }

  disconnect(): void {
    this.resetConnection(false)
  }

  dispose(): void {
    this.disconnect()
    this.removeAllListeners()
  }

  private async connectAndAuthenticate(): Promise<void> {
    const paths = daemonPaths()
    ensureDaemonHome(paths)

    let controlConnected = await this.tryConnectControl()
    if (!controlConnected) {
      await this.spawnDaemon(paths)
      controlConnected = await this.tryConnectControl()
      if (!controlConnected) throw new Error('Failed to connect to terminal host daemon')
    }

    const token = this.readToken()
    await this.sendRawRequestOnControl('hello', {
      token,
      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
      clientId: this.clientId,
      role: 'control',
    })

    const streamConnected = await this.tryConnectStream()
    if (!streamConnected) throw new Error('Failed to connect stream socket')

    await this.sendRawRequestOnStream('hello', {
      token,
      protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
      clientId: this.clientId,
      role: 'stream',
    })
  }

  private async tryConnectControl(): Promise<boolean> {
    const { socketPath } = daemonPaths()
    if (!existsSync(socketPath)) return false

    return new Promise((resolve) => {
      const socket = connect(socketPath)
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      socket.setTimeout(CONNECT_TIMEOUT_MS)
      socket.on('connect', () => {
        this.controlSocket = socket
        socket.setEncoding('utf8')
        socket.unref()
        socket.on('data', (chunk: string) => {
          for (const message of this.controlParser.parse(chunk)) {
            this.handleIncoming(message)
          }
        })
        socket.on('error', () => this.handleDisconnect())
        socket.on('close', () => this.handleDisconnect())
        finish(true)
      })
      socket.on('timeout', () => {
        socket.destroy()
        finish(false)
      })
      socket.on('error', () => finish(false))
    })
  }

  private async tryConnectStream(): Promise<boolean> {
    const { socketPath } = daemonPaths()
    if (!existsSync(socketPath)) return false

    return new Promise((resolve) => {
      const socket = connect(socketPath)
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        resolve(ok)
      }

      socket.setTimeout(CONNECT_TIMEOUT_MS)
      socket.on('connect', () => {
        this.streamSocket = socket
        socket.setEncoding('utf8')
        socket.unref()
        socket.on('data', (chunk: string) => {
          for (const message of this.streamParser.parse(chunk)) {
            this.handleIncoming(message)
          }
        })
        socket.on('error', () => this.handleDisconnect())
        socket.on('close', () => this.handleDisconnect())
        finish(true)
      })
      socket.on('timeout', () => {
        socket.destroy()
        finish(false)
      })
      socket.on('error', () => finish(false))
    })
  }

  private handleIncoming(message: TerminalHostResponse | TerminalHostEventEnvelope): void {
    if ('id' in message) {
      const pending = this.pending.get(message.id)
      if (!pending) return

      this.pending.delete(message.id)
      clearTimeout(pending.timeout)

      if (message.ok) {
        pending.resolve(message.payload)
      } else {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`))
      }
      return
    }

    if (message.type !== 'event') return
    if (message.event === 'data' && message.payload.type === 'data') {
      this.emit('data', message.sessionId, message.payload.data)
      return
    }
    if (message.event === 'exit' && message.payload.type === 'exit') {
      this.emit('exit', message.sessionId, message.payload.exitCode)
      return
    }
    if (message.event === 'error' && message.payload.type === 'error') {
      this.emit('terminal-error', message.sessionId, message.payload.error)
    }
  }

  private sendRequest<T = unknown>(type: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.controlSocket) {
        reject(new Error('Control socket not connected'))
        return
      }

      const id = `req_${++this.reqSeq}`
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${type}`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timeout,
      })

      const frame: TerminalHostRequest = { id, type, payload }
      this.controlSocket.write(`${JSON.stringify(frame)}\n`)
    })
  }

  private sendRawRequestOnControl(type: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.controlSocket) {
        reject(new Error('Control socket not connected'))
        return
      }
      const id = `raw_${++this.reqSeq}`
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${type}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timeout })
      this.controlSocket.write(`${JSON.stringify({ id, type, payload })}\n`)
    })
  }

  private sendRawRequestOnStream(type: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.streamSocket) {
        reject(new Error('Stream socket not connected'))
        return
      }
      const id = `raw_${++this.reqSeq}`
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Request timeout: ${type}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timeout })
      this.streamSocket.write(`${JSON.stringify({ id, type, payload })}\n`)
    })
  }

  private readToken(): string {
    const { tokenPath } = daemonPaths()
    if (!existsSync(tokenPath)) {
      throw new Error('Terminal host token not found')
    }
    return readFileSync(tokenPath, 'utf8').trim()
  }

  private handleDisconnect(): void {
    if (this.state === ConnectionState.Disconnected) return
    this.resetConnection(true)
  }

  private resetConnection(emitDisconnected: boolean): void {
    if (this.controlSocket) {
      try {
        this.controlSocket.destroy()
      } catch {
        // Ignore socket cleanup failure.
      }
    }
    if (this.streamSocket) {
      try {
        this.streamSocket.destroy()
      } catch {
        // Ignore socket cleanup failure.
      }
    }

    this.controlSocket = null
    this.streamSocket = null
    this.controlParser = new NdjsonParser()
    this.streamParser = new NdjsonParser()
    this.state = ConnectionState.Disconnected

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('Terminal host disconnected'))
      this.pending.delete(id)
    }

    if (emitDisconnected) this.emit('disconnected')
  }

  private async spawnDaemon(paths: Paths): Promise<void> {
    ensureDaemonHome(paths)
    this.cleanupStaleFiles(paths)

    if (!this.acquireSpawnLock(paths)) {
      await this.waitForDaemon(paths)
      return
    }

    try {
      const scriptPath = app.isPackaged
        ? join(process.resourcesPath, 'app.asar', 'out', 'main', 'index.js')
        : join(__dirname, 'index.js')

      let startupFailure: Error | null = null
      const child = spawn(process.execPath, [scriptPath, '--terminal-host-daemon'], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          CONSTELLAGENT_DAEMON_HOME: paths.home,
          CONSTELLAGENT_DAEMON_SOCKET: paths.socketPath,
          CI_TEST: process.env.CI_TEST || '',
        },
      })
      child.once('error', (error) => {
        startupFailure = error
      })
      child.once('exit', (code, signal) => {
        if (existsSync(paths.socketPath)) return
        startupFailure = new Error(`Terminal host daemon exited before startup (code=${code ?? 'null'}, signal=${signal ?? 'null'})`)
      })
      child.unref()

      try {
        await this.waitForDaemon(paths)
      } catch (error) {
        if (startupFailure) {
          throw new Error(`${startupFailure.message}; scriptPath=${scriptPath}; daemonHome=${paths.home}`)
        }
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message}; scriptPath=${scriptPath}; daemonHome=${paths.home}`)
      }
    } finally {
      this.releaseSpawnLock(paths)
    }
  }

  private cleanupStaleFiles(paths: Paths): void {
    if (existsSync(paths.socketPath)) {
      try {
        const probe = connect(paths.socketPath)
        probe.setTimeout(200)
        probe.on('connect', () => {
          probe.destroy()
        })
        probe.on('timeout', () => {
          probe.destroy()
          try {
            unlinkSync(paths.socketPath)
          } catch {
            // Ignore stale socket cleanup errors.
          }
        })
        probe.on('error', () => {
          try {
            unlinkSync(paths.socketPath)
          } catch {
            // Ignore stale socket cleanup errors.
          }
        })
      } catch {
        try {
          unlinkSync(paths.socketPath)
        } catch {
          // Ignore stale socket cleanup errors.
        }
      }
    }

    if (existsSync(paths.pidPath)) {
      try {
        const pid = Number.parseInt(readFileSync(paths.pidPath, 'utf8').trim(), 10)
        if (!Number.isNaN(pid)) {
          try {
            process.kill(pid, 0)
          } catch {
            unlinkSync(paths.pidPath)
          }
        }
      } catch {
        // Ignore pid parsing issues.
      }
    }
  }

  private acquireSpawnLock(paths: Paths): boolean {
    try {
      if (existsSync(paths.spawnLockPath)) {
        const last = Number.parseInt(readFileSync(paths.spawnLockPath, 'utf8').trim(), 10)
        if (!Number.isNaN(last) && Date.now() - last < SPAWN_LOCK_TIMEOUT_MS) {
          return false
        }
        unlinkSync(paths.spawnLockPath)
      }
      writeFileSync(paths.spawnLockPath, String(Date.now()), { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  private releaseSpawnLock(paths: Paths): void {
    try {
      if (existsSync(paths.spawnLockPath)) unlinkSync(paths.spawnLockPath)
    } catch {
      // Ignore lock cleanup failures.
    }
  }

  private async waitForDaemon(paths: Paths): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < SPAWN_WAIT_TIMEOUT_MS) {
      if (existsSync(paths.socketPath)) {
        try {
          const stats = statSync(paths.socketPath)
          if (stats.isSocket()) {
            await new Promise((resolve) => setTimeout(resolve, 100))
            return
          }
        } catch {
          // Continue waiting.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error('Timed out waiting for terminal host daemon startup')
  }
}

let singleton: TerminalHostClient | null = null

export function getTerminalHostClient(): TerminalHostClient {
  if (!singleton) singleton = new TerminalHostClient()
  return singleton
}

export function disposeTerminalHostClient(): void {
  if (!singleton) return
  singleton.dispose()
  singleton = null
}
