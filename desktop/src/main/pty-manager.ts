import * as pty from 'node-pty'
import { execFileSync } from 'child_process'
import { WebContents } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AgentTurnEventType, AgentTurnOutcome } from '../shared/agent-events'
import { emitAgentTurnEvent } from './agent-events'

interface PtyInstance {
  process: pty.IPty
  webContents: WebContents
  onExitCallbacks: Array<(exitCode: number) => void>
  cols: number
  rows: number
  outputSeq: number
  replayChunks: string[]
  replayChars: number
  workspaceId?: string
  agentSessionId: string
  codexPromptBuffer: string
  codexAwaitingAnswer: boolean
  codexTurnActive: boolean
  agentEventLineBuffer: string
  piMonoJsonDetected: boolean
  piMonoTurnActive: boolean
  crushTurnActive: boolean
  crushSilenceTimer: ReturnType<typeof setTimeout> | null
  crushLastTurnEndedAt: number
  crushLastRearmCheck: number
  crushPrevDataSize: number
}

interface ProcessEntry {
  pid: number
  ppid: number
  command: string
}

function parseProcessTable(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    })
  }
  return entries
}

function isLikelyCodexCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  if (tokens.length === 0) return false

  const first = tokens[0].toLowerCase()
  const second = (tokens[1] ?? '').toLowerCase()

  const isCodexPathToken = (token: string): boolean => {
    if (!token) return false
    const clean = token.replace(/^['"]|['"]$/g, '')
    const basename = clean.split('/').pop() ?? clean
    return basename === 'codex' || basename === 'codex.js' || basename.startsWith('codex-')
  }

  if (isCodexPathToken(first)) return true

  const nodeOrBun = first === 'node' || first.endsWith('/node') || first === 'bun' || first.endsWith('/bun')
  const shellOrInterpreter =
    nodeOrBun ||
    first === 'bash' ||
    first.endsWith('/bash') ||
    first === 'sh' ||
    first.endsWith('/sh') ||
    first === 'zsh' ||
    first.endsWith('/zsh') ||
    first === 'python' ||
    first.endsWith('/python')

  if (shellOrInterpreter && isCodexPathToken(second)) return true

  return first.includes('/codex/') && first.endsWith('/codex')
}

function isLikelyCrushCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/)
  if (tokens.length === 0) return false

  const isCrushToken = (token: string): boolean => {
    if (!token) return false
    const clean = token.replace(/^['"]|['"]$/g, '').toLowerCase()
    const base = clean.split('/').pop() ?? clean
    return base === 'crush'
  }

  if (isCrushToken(tokens[0])) return true

  // Handle shell-invoked scripts: bash /path/to/crush, sh crush, etc.
  const first = tokens[0].toLowerCase()
  const firstBase = first.split('/').pop() ?? first
  const isShell =
    firstBase === 'bash' || firstBase === 'sh' || firstBase === 'zsh' ||
    firstBase === 'dash' || firstBase === 'fish'
  if (isShell && isCrushToken(tokens[1] ?? '')) return true

  return false
}

const CODEX_PROMPT_BUFFER_MAX = 4096
const PTY_REPLAY_BUFFER_MAX_CHARS = 8_000_000
const CODEX_QUESTION_HEADER_RE = /Question\s+\d+\s*\/\s*\d+\s*\(\s*\d+\s+unanswered\s*\)/i
const CODEX_QUESTION_HINT_RE = /enter to submit answer/i
const AGENT_EVENT_LINE_BUFFER_MAX = 32_768
const CRUSH_SILENCE_MS = 5_000
const CRUSH_REARM_GRACE_MS = 3_000
const CRUSH_REARM_CHECK_INTERVAL_MS = 3_000
const CRUSH_REARM_MIN_DATA_LEN = 8

function stripAnsiSequences(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP.*?\x1b\\/g, '')
}

function appendReplayChunk(instance: PtyInstance, chunk: string): void {
  if (!chunk) return

  if (chunk.length >= PTY_REPLAY_BUFFER_MAX_CHARS) {
    const tail = chunk.slice(chunk.length - PTY_REPLAY_BUFFER_MAX_CHARS)
    instance.replayChunks = [tail]
    instance.replayChars = tail.length
    return
  }

  instance.replayChunks.push(chunk)
  instance.replayChars += chunk.length

  while (instance.replayChars > PTY_REPLAY_BUFFER_MAX_CHARS && instance.replayChunks.length > 0) {
    const removed = instance.replayChunks.shift()
    if (!removed) break
    instance.replayChars -= removed.length
  }
}

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()
  private nextId = 0

  create(workingDir: string, webContents: WebContents, shell?: string, command?: string[], initialWrite?: string, extraEnv?: Record<string, string>): string {
    const id = `pty-${++this.nextId}`

    let file: string
    let args: string[]
    if (command && command.length > 0) {
      file = command[0]
      args = command.slice(1)
    } else {
      file = (shell && shell.trim()) || process.env.SHELL || '/bin/zsh'
      args = []
    }

    const agentSessionId = extraEnv?.AGENT_ORCH_SESSION_ID || id

    const proc = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: workingDir,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...extraEnv,
        AGENT_ORCH_SESSION_ID: agentSessionId,
        AGENT_ORCH_PTY_ID: id,
      } as Record<string, string>,
    })

    const instance: PtyInstance = {
      process: proc,
      webContents,
      onExitCallbacks: [],
      cols: 80,
      rows: 24,
      outputSeq: 0,
      replayChunks: [],
      replayChars: 0,
      workspaceId: extraEnv?.AGENT_ORCH_WS_ID,
      agentSessionId,
      codexPromptBuffer: '',
      codexAwaitingAnswer: false,
      codexTurnActive: false,
      agentEventLineBuffer: '',
      piMonoJsonDetected: false,
      piMonoTurnActive: false,
      crushTurnActive: false,
      crushSilenceTimer: null,
      crushLastTurnEndedAt: 0,
      crushLastRearmCheck: 0,
      crushPrevDataSize: -1,
    }

    let pendingWrite = initialWrite
    proc.onData((data) => {
      const startSeq = instance.outputSeq
      instance.outputSeq += data.length
      appendReplayChunk(instance, data)
      if (!instance.webContents.isDestroyed()) {
        instance.webContents.send(`${IPC.PTY_DATA}:${id}`, startSeq, data)
      }
      this.handlePiMonoJsonOutput(instance, data)
      this.handleCodexQuestionPrompt(instance, data)
      this.handleCodexProcessCompletion(instance)
      this.handleCrushTurnSilence(instance, data)
      // Write initial command on first output (shell is ready)
      if (pendingWrite) {
        const toWrite = pendingWrite
        pendingWrite = undefined
        proc.write(toWrite)
      }
    })

    proc.onExit(({ exitCode }) => {
      if (instance.codexTurnActive) {
        instance.codexTurnActive = false
        this.emitTurnEvent(
          instance.workspaceId,
          'codex',
          'awaiting_user',
          instance.agentSessionId,
          exitCode === 0 ? 'success' : 'failed',
        )
      }

      if (instance.crushTurnActive) {
        instance.crushTurnActive = false
        if (instance.crushSilenceTimer) {
          clearTimeout(instance.crushSilenceTimer)
          instance.crushSilenceTimer = null
        }
        this.emitTurnEvent(
          instance.workspaceId,
          'crush',
          'awaiting_user',
          instance.agentSessionId,
          exitCode === 0 ? 'success' : 'failed',
        )
      }

      for (const cb of instance.onExitCallbacks) cb(exitCode)
      this.ptys.delete(id)
    })

    this.ptys.set(id, instance)
    return id
  }

  onExit(ptyId: string, callback: (exitCode: number) => void): void {
    const instance = this.ptys.get(ptyId)
    if (instance) instance.onExitCallbacks.push(callback)
  }

  write(ptyId: string, data: string): void {
    const instance = this.ptys.get(ptyId)
    if (!instance) return

    // Codex doesn't expose a prompt-submit hook, so mark the workspace active
    // when Enter is sent while a Codex process is already running in this PTY.
    // Crush (by Charm) is a TUI agent with no hook system — use the same
    // process-tree detection approach.
    if (instance.workspaceId && /[\r\n]/.test(data)) {
      if (this.isCodexRunningUnder(instance.process.pid)) {
        instance.codexPromptBuffer = ''
        instance.codexAwaitingAnswer = false
        if (!instance.codexTurnActive) {
          instance.codexTurnActive = true
          this.emitTurnEvent(instance.workspaceId, 'codex', 'turn_started', instance.agentSessionId)
        }
      } else if (!instance.crushTurnActive && this.isCrushRunningUnder(instance.process.pid)) {
        instance.crushTurnActive = true
        this.emitTurnEvent(instance.workspaceId, 'crush', 'turn_started', instance.agentSessionId)
      }
    }

    instance.process.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      if (instance.cols === cols && instance.rows === rows) return
      instance.cols = cols
      instance.rows = rows
      instance.process.resize(cols, rows)
    }
  }

  destroy(ptyId: string): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      instance.codexTurnActive = false
      instance.crushTurnActive = false
      if (instance.crushSilenceTimer) {
        clearTimeout(instance.crushSilenceTimer)
        instance.crushSilenceTimer = null
      }
      instance.process.kill()
      this.ptys.delete(ptyId)
    }
  }

  /** Return IDs of all live PTY processes */
  list(): string[] {
    return Array.from(this.ptys.keys())
  }

  private isAgentRunningUnder(
    rootPid: number,
    matcher: (command: string) => boolean,
  ): boolean {
    let processTable = ''
    try {
      processTable = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf-8' })
    } catch {
      return false
    }

    const entries = parseProcessTable(processTable)
    if (entries.length === 0) return false

    const childrenByParent = new Map<number, ProcessEntry[]>()
    for (const entry of entries) {
      const children = childrenByParent.get(entry.ppid)
      if (children) children.push(entry)
      else childrenByParent.set(entry.ppid, [entry])
    }

    const stack = [rootPid]
    const seen = new Set<number>()
    while (stack.length > 0) {
      const pid = stack.pop()!
      if (seen.has(pid)) continue
      seen.add(pid)

      const children = childrenByParent.get(pid)
      if (!children) continue

      for (const child of children) {
        if (matcher(child.command)) {
          return true
        }
        stack.push(child.pid)
      }
    }
    return false
  }

  private isCodexRunningUnder(rootPid: number): boolean {
    return this.isAgentRunningUnder(rootPid, isLikelyCodexCommand)
  }

  private isCrushRunningUnder(rootPid: number): boolean {
    return this.isAgentRunningUnder(rootPid, isLikelyCrushCommand)
  }

  private emitTurnEvent(
    workspaceId: string | undefined,
    agent: string,
    type: AgentTurnEventType,
    sessionId?: string,
    outcome?: AgentTurnOutcome,
  ): void {
    if (!workspaceId) return
    emitAgentTurnEvent({ workspaceId, agent, type, sessionId, outcome })
  }

  private handlePiMonoJsonOutput(instance: PtyInstance, data: string): void {
    if (!instance.workspaceId || !data) return

    instance.agentEventLineBuffer = `${instance.agentEventLineBuffer}${data}`
    if (instance.agentEventLineBuffer.length > AGENT_EVENT_LINE_BUFFER_MAX) {
      instance.agentEventLineBuffer = instance.agentEventLineBuffer.slice(-AGENT_EVENT_LINE_BUFFER_MAX)
    }

    const lines = instance.agentEventLineBuffer.split(/\r?\n/)
    instance.agentEventLineBuffer = lines.pop() ?? ''

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line || line[0] !== '{') continue

      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      const type = typeof parsed.type === 'string' ? parsed.type : ''
      if (!type) continue

      if (!instance.piMonoJsonDetected) {
        const isSessionHeader =
          type === 'session' &&
          typeof parsed.id === 'string' &&
          typeof parsed.cwd === 'string' &&
          typeof parsed.version === 'number'
        if (!isSessionHeader) continue

        instance.piMonoJsonDetected = true
        const sessionId = (parsed.id as string).trim()
        if (sessionId) {
          instance.agentSessionId = sessionId
        }
        continue
      }

      if (type === 'turn_start') {
        instance.piMonoTurnActive = true
        this.emitTurnEvent(instance.workspaceId, 'pi-mono', 'turn_started', instance.agentSessionId)
        continue
      }

      if (type === 'turn_end') {
        instance.piMonoTurnActive = false
        this.emitTurnEvent(instance.workspaceId, 'pi-mono', 'awaiting_user', instance.agentSessionId, 'success')
        continue
      }

      if (type === 'agent_end' && instance.piMonoTurnActive) {
        instance.piMonoTurnActive = false
        this.emitTurnEvent(instance.workspaceId, 'pi-mono', 'awaiting_user', instance.agentSessionId, 'success')
      }
    }
  }

  private handleCodexQuestionPrompt(instance: PtyInstance, data: string): void {
    if (!instance.workspaceId) return
    if (instance.codexAwaitingAnswer) return

    const normalized = stripAnsiSequences(data)
    if (!normalized) return

    instance.codexPromptBuffer = `${instance.codexPromptBuffer}${normalized}`.slice(-CODEX_PROMPT_BUFFER_MAX)
    if (!CODEX_QUESTION_HEADER_RE.test(instance.codexPromptBuffer)) return
    if (!CODEX_QUESTION_HINT_RE.test(instance.codexPromptBuffer)) return
    if (!instance.codexTurnActive) return

    // Codex is explicitly waiting on user input: clear running state and
    // emit a generalized "awaiting user" turn event.
    instance.codexAwaitingAnswer = true
    instance.codexPromptBuffer = ''
    instance.codexTurnActive = false
    this.emitTurnEvent(instance.workspaceId, 'codex', 'awaiting_user', instance.agentSessionId)
  }

  private handleCodexProcessCompletion(instance: PtyInstance): void {
    if (!instance.workspaceId) return
    if (!instance.codexTurnActive) return
    if (this.isCodexRunningUnder(instance.process.pid)) return

    instance.codexTurnActive = false
    this.emitTurnEvent(instance.workspaceId, 'codex', 'awaiting_user', instance.agentSessionId, 'success')
  }

  /** Crush is a persistent Bubbletea TUI that renders continuously even when
   *  idle (spinner animation, cursor updates — always ~300B frames).  A plain
   *  silence timer never fires.  Instead, detect turn completion by watching
   *  for *novel* output: when crush is actively streaming a response, data
   *  sizes vary (tokens, tool output, TUI layout changes).  When idle, the
   *  TUI emits fixed-size animation frames that repeat at a steady cadence.
   *  Only reset the timer on varied-size output; repeated frames are ignored.
   *
   *  If the timer fires prematurely (e.g. during a long API spinner) and
   *  varied output resumes, the turn is automatically re-armed. */
  private handleCrushTurnSilence(instance: PtyInstance, data: string): void {
    if (!instance.workspaceId) return

    if (instance.crushTurnActive) {
      const prev = instance.crushPrevDataSize
      instance.crushPrevDataSize = data.length

      // Repeating same-size output (±2 bytes) = TUI animation frame.
      // Don't reset the timer — only novel (varied-size) output counts.
      if (prev >= 0 && Math.abs(data.length - prev) <= 2) return

      // Novel output — crush is actively producing new content.
      if (instance.crushSilenceTimer) clearTimeout(instance.crushSilenceTimer)
      instance.crushSilenceTimer = setTimeout(() => {
        if (!instance.crushTurnActive) return
        instance.crushTurnActive = false
        instance.crushSilenceTimer = null
        instance.crushPrevDataSize = -1
        instance.crushLastTurnEndedAt = Date.now()
        this.emitTurnEvent(instance.workspaceId, 'crush', 'awaiting_user', instance.agentSessionId, 'success')
      }, CRUSH_SILENCE_MS)
      return
    }

    // Not in an active turn.  If we see varied-size output while crush is
    // still in the process tree, a new turn likely started (e.g. the timer
    // fired prematurely during a long API spinner and streaming just began).
    const prev = instance.crushPrevDataSize
    instance.crushPrevDataSize = data.length
    if (prev >= 0 && Math.abs(data.length - prev) <= 2) return
    if (data.length < CRUSH_REARM_MIN_DATA_LEN) return

    const now = Date.now()
    if (now - instance.crushLastTurnEndedAt < CRUSH_REARM_GRACE_MS) return
    if (now - instance.crushLastRearmCheck < CRUSH_REARM_CHECK_INTERVAL_MS) return
    instance.crushLastRearmCheck = now

    if (!this.isCrushRunningUnder(instance.process.pid)) return

    instance.crushTurnActive = true
    this.emitTurnEvent(instance.workspaceId, 'crush', 'turn_started', instance.agentSessionId)
  }

  /** Update the webContents reference for an existing PTY (e.g. after renderer reload) */
  reattach(
    ptyId: string,
    webContents: WebContents,
    sinceSeq?: number
  ): { ok: boolean; replay?: string; baseSeq: number; endSeq: number; truncated: boolean; cols: number; rows: number } {
    const instance = this.ptys.get(ptyId)
    if (!instance) return { ok: false, baseSeq: 0, endSeq: 0, truncated: false, cols: 0, rows: 0 }
    instance.webContents = webContents

    const endSeq = instance.outputSeq
    const baseSeq = Math.max(0, endSeq - instance.replayChars)
    const requestedSince = typeof sinceSeq === 'number' && Number.isFinite(sinceSeq) ? Math.max(0, Math.floor(sinceSeq)) : baseSeq
    const truncated = requestedSince < baseSeq

    let replayData: string | undefined
    if (instance.replayChunks.length > 0 && requestedSince < endSeq) {
      const joined = instance.replayChunks.join('')
      const offset = Math.max(0, requestedSince - baseSeq)
      replayData = joined.slice(offset)
    }

    return { ok: true, replay: replayData, baseSeq, endSeq, truncated, cols: instance.cols, rows: instance.rows }
  }

  destroyAll(): void {
    for (const [id] of this.ptys) {
      this.destroy(id)
    }
  }
}
