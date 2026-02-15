import * as pty from 'node-pty'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { Socket } from 'net'
import type {
  TerminalHostCreateOrAttachRequest,
  TerminalHostCreateOrAttachResponse,
  TerminalHostDetachRequest,
  TerminalHostEventEnvelope,
  TerminalHostKillRequest,
  TerminalHostListSessionsResponse,
  TerminalHostResizeRequest,
  TerminalHostWriteRequest,
} from '../lib/terminal-host/types'

const DEFAULT_ACTIVITY_DIR = '/tmp/constellagent-activity'
const CODEX_MARKER_SEGMENT = '.codex.'
const CODEX_PROMPT_BUFFER_MAX = 4096
const CODEX_QUESTION_HEADER_RE = /Question\s+\d+\s*\/\s*\d+\s*\(\s*\d+\s+unanswered\s*\)/i
const CODEX_QUESTION_HINT_RE = /enter to submit answer/i
const MAX_SNAPSHOT_BYTES = 2_000_000

function stripAnsiSequences(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP.*?\x1b\\/g, '')
}

function getActivityDir(): string {
  return process.env.CONSTELLAGENT_ACTIVITY_DIR || DEFAULT_ACTIVITY_DIR
}

interface Session {
  id: string
  workspaceId: string
  process: pty.IPty
  attachedSockets: Set<Socket>
  cols: number
  rows: number
  snapshot: string
  codexPromptBuffer: string
  codexAwaitingAnswer: boolean
}

export class TerminalHost {
  private sessions = new Map<string, Session>()

  createOrAttach(socket: Socket, request: TerminalHostCreateOrAttachRequest): TerminalHostCreateOrAttachResponse {
    const existing = this.sessions.get(request.sessionId)
    if (existing) {
      existing.cols = request.cols
      existing.rows = request.rows
      existing.attachedSockets.add(socket)
      try {
        existing.process.resize(request.cols, request.rows)
      } catch {
        // Ignore resize errors for stale sessions.
      }
      this.sendSnapshot(socket, existing)
      return {
        isNew: false,
        snapshot: {
          snapshotAnsi: existing.snapshot,
          cols: existing.cols,
          rows: existing.rows,
        },
        pid: existing.process.pid,
      }
    }

    const shell = (request.shell && request.shell.trim()) || process.env.SHELL || '/bin/zsh'
    const useLoginShell = request.useLoginShell ?? true
    const args = useLoginShell ? ['-l'] : []

    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: request.cols,
      rows: request.rows,
      cwd: request.cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        AGENT_ORCH_WS_ID: request.workspaceId,
        ...request.env,
      } as Record<string, string>,
    })

    const session: Session = {
      id: request.sessionId,
      workspaceId: request.workspaceId,
      process: proc,
      attachedSockets: new Set([socket]),
      cols: request.cols,
      rows: request.rows,
      snapshot: '',
      codexPromptBuffer: '',
      codexAwaitingAnswer: false,
    }

    proc.onData((data) => {
      this.appendSnapshot(session, data)
      this.handleCodexQuestionPrompt(session, data)

      const event: TerminalHostEventEnvelope = {
        type: 'event',
        event: 'data',
        sessionId: session.id,
        payload: { type: 'data', data },
      }
      this.broadcast(session, event)
    })

    proc.onExit(({ exitCode }) => {
      this.clearCodexWorkspaceActivity(session.workspaceId, session.process.pid)

      const event: TerminalHostEventEnvelope = {
        type: 'event',
        event: 'exit',
        sessionId: session.id,
        payload: { type: 'exit', exitCode },
      }
      this.broadcast(session, event)
      this.sessions.delete(session.id)
    })

    this.sessions.set(session.id, session)

    return {
      isNew: true,
      snapshot: {
        snapshotAnsi: session.snapshot,
        cols: session.cols,
        rows: session.rows,
      },
      pid: session.process.pid,
    }
  }

  write(request: TerminalHostWriteRequest): void {
    const session = this.sessions.get(request.sessionId)
    if (!session) throw new Error(`Session not found: ${request.sessionId}`)

    if (/[\r\n]/.test(request.data)) {
      session.codexPromptBuffer = ''
      session.codexAwaitingAnswer = false
      this.markCodexWorkspaceActive(session.workspaceId, session.process.pid)
    }

    session.process.write(request.data)
  }

  resize(request: TerminalHostResizeRequest): void {
    const session = this.sessions.get(request.sessionId)
    if (!session) return
    session.cols = request.cols
    session.rows = request.rows
    try {
      session.process.resize(request.cols, request.rows)
    } catch {
      // Ignore late resize errors.
    }
  }

  detach(socket: Socket, request: TerminalHostDetachRequest): void {
    const session = this.sessions.get(request.sessionId)
    if (!session) return
    session.attachedSockets.delete(socket)
  }

  kill(request: TerminalHostKillRequest): void {
    const session = this.sessions.get(request.sessionId)
    if (!session) return
    this.clearCodexWorkspaceActivity(session.workspaceId, session.process.pid)
    session.process.kill()
    this.sessions.delete(request.sessionId)
  }

  detachFromAllSessions(socket: Socket): void {
    for (const session of this.sessions.values()) {
      session.attachedSockets.delete(socket)
    }
  }

  listSessions(): TerminalHostListSessionsResponse {
    return {
      sessions: Array.from(this.sessions.values()).map((session) => ({
        sessionId: session.id,
        workspaceId: session.workspaceId,
        cols: session.cols,
        rows: session.rows,
        pid: session.process.pid,
        attachedClients: session.attachedSockets.size,
      })),
    }
  }

  dispose(killSessions = true): void {
    if (!killSessions) return
    for (const session of this.sessions.values()) {
      try {
        session.process.kill()
      } catch {
        // Ignore shutdown failures.
      }
    }
    this.sessions.clear()
  }

  private broadcast(session: Session, event: TerminalHostEventEnvelope): void {
    const frame = `${JSON.stringify(event)}\n`
    for (const socket of session.attachedSockets) {
      if (socket.destroyed) {
        session.attachedSockets.delete(socket)
        continue
      }
      try {
        socket.write(frame)
      } catch {
        session.attachedSockets.delete(socket)
      }
    }
  }

  private appendSnapshot(session: Session, data: string): void {
    session.snapshot = `${session.snapshot}${data}`
    if (Buffer.byteLength(session.snapshot, 'utf8') <= MAX_SNAPSHOT_BYTES) {
      return
    }
    const buf = Buffer.from(session.snapshot, 'utf8')
    session.snapshot = buf.subarray(buf.length - MAX_SNAPSHOT_BYTES).toString('utf8')
  }

  private sendSnapshot(socket: Socket, session: Session): void {
    if (!session.snapshot) return
    const frame: TerminalHostEventEnvelope = {
      type: 'event',
      event: 'data',
      sessionId: session.id,
      payload: { type: 'data', data: session.snapshot },
    }
    try {
      socket.write(`${JSON.stringify(frame)}\n`)
    } catch {
      session.attachedSockets.delete(socket)
    }
  }

  private codexMarkerPath(workspaceId: string, ptyPid: number): string {
    return `${getActivityDir()}/${workspaceId}${CODEX_MARKER_SEGMENT}${ptyPid}`
  }

  private markCodexWorkspaceActive(workspaceId: string, ptyPid: number): void {
    try {
      const activityDir = getActivityDir()
      mkdirSync(activityDir, { recursive: true })
      writeFileSync(this.codexMarkerPath(workspaceId, ptyPid), '')
    } catch {
      // Best-effort marker write.
    }
  }

  private clearCodexWorkspaceActivity(workspaceId: string, ptyPid: number): void {
    try {
      unlinkSync(this.codexMarkerPath(workspaceId, ptyPid))
    } catch {
      // Best-effort marker cleanup.
    }
  }

  private handleCodexQuestionPrompt(session: Session, data: string): void {
    if (session.codexAwaitingAnswer) return

    const normalized = stripAnsiSequences(data)
    if (!normalized) return

    session.codexPromptBuffer = `${session.codexPromptBuffer}${normalized}`.slice(-CODEX_PROMPT_BUFFER_MAX)
    if (!CODEX_QUESTION_HEADER_RE.test(session.codexPromptBuffer)) return
    if (!CODEX_QUESTION_HINT_RE.test(session.codexPromptBuffer)) return
    if (!this.isCodexActivityMarked(session.workspaceId, session.process.pid)) return

    session.codexAwaitingAnswer = true
    session.codexPromptBuffer = ''
    this.clearCodexWorkspaceActivity(session.workspaceId, session.process.pid)
  }

  private isCodexActivityMarked(workspaceId: string, ptyPid: number): boolean {
    try {
      return existsSync(this.codexMarkerPath(workspaceId, ptyPid))
    } catch {
      return false
    }
  }
}
