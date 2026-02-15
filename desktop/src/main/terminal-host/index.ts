import { randomBytes } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createServer, Socket, type Server } from 'net'
import { join } from 'path'
import {
  TERMINAL_HOST_PROTOCOL_VERSION,
  type TerminalHostCreateOrAttachRequest,
  type TerminalHostDetachRequest,
  type TerminalHostHelloRequest,
  type TerminalHostKillRequest,
  type TerminalHostRequest,
  type TerminalHostResizeRequest,
  type TerminalHostShutdownRequest,
  type TerminalHostWriteRequest,
} from '../lib/terminal-host/types'
import { TerminalHost } from './terminal-host'

interface ClientState {
  authenticated: boolean
  clientId: string | null
  role: 'control' | 'stream' | null
}

interface ClientSockets {
  control?: Socket
  stream?: Socket
}

const host = new TerminalHost()
const clients = new Map<string, ClientSockets>()

const daemonHome = process.env.CONSTELLAGENT_DAEMON_HOME || join(process.env.HOME || '/tmp', '.constellagent')
const socketPath = process.env.CONSTELLAGENT_DAEMON_SOCKET || join(daemonHome, 'terminal-host.sock')
const tokenPath = join(daemonHome, 'terminal-host.token')
const pidPath = join(daemonHome, 'terminal-host.pid')

let authToken = ''
let server: Server | null = null

function ensureHomeDir(): void {
  mkdirSync(daemonHome, { recursive: true, mode: 0o700 })
  try {
    chmodSync(daemonHome, 0o700)
  } catch {
    // Best effort.
  }
}

function ensureToken(): string {
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf8').trim()
  }
  const token = randomBytes(32).toString('hex')
  writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

function send(socket: Socket, payload: unknown): void {
  socket.write(`${JSON.stringify(payload)}\n`)
}

function sendOk(socket: Socket, id: string, payload: unknown): void {
  send(socket, { id, ok: true, payload })
}

function sendError(socket: Socket, id: string, code: string, message: string): void {
  send(socket, { id, ok: false, error: { code, message } })
}

function tryCleanupStaleSocket(): void {
  if (!existsSync(socketPath)) return

  const probe = new Socket()
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try {
      probe.destroy()
    } catch {
      // Ignore probe cleanup failures.
    }
  }

  probe.setTimeout(300)
  probe.on('connect', cleanup)
  probe.on('timeout', () => {
    cleanup()
    try {
      unlinkSync(socketPath)
    } catch {
      // Ignore stale unlink failures.
    }
  })
  probe.on('error', () => {
    cleanup()
    try {
      unlinkSync(socketPath)
    } catch {
      // Ignore stale unlink failures.
    }
  })
  probe.connect(socketPath)
}

function cleanupClient(state: ClientState, socket: Socket): void {
  host.detachFromAllSessions(socket)
  if (!state.clientId || !state.role) return
  const sockets = clients.get(state.clientId)
  if (!sockets) return

  if (state.role === 'control' && sockets.control === socket) delete sockets.control
  if (state.role === 'stream' && sockets.stream === socket) delete sockets.stream

  if (!sockets.control && !sockets.stream) {
    clients.delete(state.clientId)
  } else {
    clients.set(state.clientId, sockets)
  }
}

function handleHello(socket: Socket, id: string, payload: unknown, state: ClientState): void {
  const req = payload as TerminalHostHelloRequest
  if (req.protocolVersion !== TERMINAL_HOST_PROTOCOL_VERSION) {
    sendError(socket, id, 'PROTOCOL_MISMATCH', 'Protocol version mismatch')
    return
  }
  if (req.token !== authToken) {
    sendError(socket, id, 'AUTH_FAILED', 'Invalid auth token')
    return
  }
  if (!req.clientId || (req.role !== 'control' && req.role !== 'stream')) {
    sendError(socket, id, 'INVALID_HELLO', 'Invalid hello payload')
    return
  }

  state.authenticated = true
  state.clientId = req.clientId
  state.role = req.role

  const current = clients.get(req.clientId) || {}
  if (req.role === 'control') {
    if (current.control && current.control !== socket) current.control.destroy()
    current.control = socket
  } else {
    if (current.stream && current.stream !== socket) current.stream.destroy()
    current.stream = socket
  }
  clients.set(req.clientId, current)

  sendOk(socket, id, {
    protocolVersion: TERMINAL_HOST_PROTOCOL_VERSION,
    daemonPid: process.pid,
  })
}

function getStreamSocketFor(state: ClientState): Socket | null {
  if (!state.clientId) return null
  return clients.get(state.clientId)?.stream || null
}

function assertAuth(socket: Socket, id: string, state: ClientState, role: 'control' | 'stream' = 'control'): boolean {
  if (!state.authenticated) {
    sendError(socket, id, 'NOT_AUTHENTICATED', 'Must authenticate first')
    return false
  }
  if (state.role !== role) {
    sendError(socket, id, 'INVALID_ROLE', `Request requires ${role} role`)
    return false
  }
  return true
}

function handleRequest(socket: Socket, req: TerminalHostRequest, state: ClientState): void {
  try {
    switch (req.type) {
      case 'hello':
        handleHello(socket, req.id, req.payload, state)
        return
      case 'createOrAttach': {
        if (!assertAuth(socket, req.id, state)) return
        const stream = getStreamSocketFor(state)
        if (!stream) {
          sendError(socket, req.id, 'STREAM_NOT_CONNECTED', 'Stream socket not connected')
          return
        }
        const result = host.createOrAttach(stream, req.payload as TerminalHostCreateOrAttachRequest)
        sendOk(socket, req.id, result)
        return
      }
      case 'write':
        if (!assertAuth(socket, req.id, state)) return
        host.write(req.payload as TerminalHostWriteRequest)
        sendOk(socket, req.id, { success: true })
        return
      case 'resize':
        if (!assertAuth(socket, req.id, state)) return
        host.resize(req.payload as TerminalHostResizeRequest)
        sendOk(socket, req.id, { success: true })
        return
      case 'detach': {
        if (!assertAuth(socket, req.id, state)) return
        const stream = getStreamSocketFor(state)
        if (!stream) {
          sendError(socket, req.id, 'STREAM_NOT_CONNECTED', 'Stream socket not connected')
          return
        }
        host.detach(stream, req.payload as TerminalHostDetachRequest)
        sendOk(socket, req.id, { success: true })
        return
      }
      case 'kill':
        if (!assertAuth(socket, req.id, state)) return
        host.kill(req.payload as TerminalHostKillRequest)
        sendOk(socket, req.id, { success: true })
        return
      case 'listSessions':
        if (!assertAuth(socket, req.id, state)) return
        sendOk(socket, req.id, host.listSessions())
        return
      case 'shutdown': {
        if (!assertAuth(socket, req.id, state)) return
        const payload = (req.payload || {}) as TerminalHostShutdownRequest
        sendOk(socket, req.id, { success: true })
        setTimeout(() => {
          host.dispose(payload.killSessions ?? false)
          server?.close()
          process.exit(0)
        }, 20)
        return
      }
      default:
        sendError(socket, req.id, 'UNKNOWN_REQUEST', `Unknown request type: ${req.type}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendError(socket, req.id, 'INTERNAL_ERROR', message)
  }
}

class NdjsonParser {
  private buffer = ''

  parse(chunk: string): TerminalHostRequest[] {
    this.buffer += chunk
    const out: TerminalHostRequest[] = []
    let idx = this.buffer.indexOf('\n')
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (line.trim()) {
        try {
          out.push(JSON.parse(line) as TerminalHostRequest)
        } catch {
          // Ignore malformed frames.
        }
      }
      idx = this.buffer.indexOf('\n')
    }
    return out
  }
}

function startDaemon(): void {
  ensureHomeDir()
  authToken = ensureToken()
  tryCleanupStaleSocket()

  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath)
    } catch {
      // Ignore stale socket cleanup errors.
    }
  }

  server = createServer((socket) => {
    socket.setEncoding('utf8')
    const parser = new NdjsonParser()
    const state: ClientState = {
      authenticated: false,
      clientId: null,
      role: null,
    }

    socket.on('data', (data: string) => {
      const frames = parser.parse(data)
      for (const frame of frames) {
        handleRequest(socket, frame, state)
      }
    })

    socket.on('close', () => cleanupClient(state, socket))
    socket.on('error', () => cleanupClient(state, socket))
  })

  server.listen(socketPath, () => {
    try {
      chmodSync(socketPath, 0o600)
      writeFileSync(pidPath, String(process.pid), { mode: 0o600 })
    } catch {
      // Ignore chmod/pid write failures.
    }
  })
}

process.on('SIGINT', () => {
  host.dispose(true)
  process.exit(0)
})

process.on('SIGTERM', () => {
  host.dispose(true)
  process.exit(0)
})

startDaemon()
