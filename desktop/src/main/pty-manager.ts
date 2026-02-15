import * as pty from 'node-pty'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { WebContents } from 'electron'
import { IPC } from '../shared/ipc-channels'

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
  codexPromptBuffer: string
  codexAwaitingAnswer: boolean
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
  if (nodeOrBun && isCodexPathToken(second)) return true

  return first.includes('/codex/') && first.endsWith('/codex')
}

const DEFAULT_ACTIVITY_DIR = '/tmp/constellagent-activity'
const CODEX_MARKER_SEGMENT = '.codex.'
const CODEX_PROMPT_BUFFER_MAX = 4096
const PTY_REPLAY_BUFFER_MAX_CHARS = 8_000_000
const CODEX_QUESTION_HEADER_RE = /Question\s+\d+\s*\/\s*\d+\s*\(\s*\d+\s+unanswered\s*\)/i
const CODEX_QUESTION_HINT_RE = /enter to submit answer/i

function stripAnsiSequences(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP.*?\x1b\\/g, '')
}

function getActivityDir(): string {
  return process.env.CONSTELLAGENT_ACTIVITY_DIR || DEFAULT_ACTIVITY_DIR
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
      codexPromptBuffer: '',
      codexAwaitingAnswer: false,
    }

    let pendingWrite = initialWrite
    proc.onData((data) => {
      const startSeq = instance.outputSeq
      instance.outputSeq += data.length
      appendReplayChunk(instance, data)
      if (!instance.webContents.isDestroyed()) {
        instance.webContents.send(`${IPC.PTY_DATA}:${id}`, startSeq, data)
      }
      this.handleCodexQuestionPrompt(instance, data)
      // Write initial command on first output (shell is ready)
      if (pendingWrite) {
        const toWrite = pendingWrite
        pendingWrite = undefined
        proc.write(toWrite)
      }
    })

    proc.onExit(({ exitCode }) => {
      this.clearCodexWorkspaceActivity(instance.workspaceId, instance.process.pid)
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
    if (instance.workspaceId && /[\r\n]/.test(data) && this.isCodexRunningUnder(instance.process.pid)) {
      instance.codexPromptBuffer = ''
      instance.codexAwaitingAnswer = false
      this.markCodexWorkspaceActive(instance.workspaceId, instance.process.pid)
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
      this.clearCodexWorkspaceActivity(instance.workspaceId, instance.process.pid)
      instance.process.kill()
      this.ptys.delete(ptyId)
    }
  }

  /** Return IDs of all live PTY processes */
  list(): string[] {
    return Array.from(this.ptys.keys())
  }

  private isCodexRunningUnder(rootPid: number): boolean {
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
        if (isLikelyCodexCommand(child.command)) {
          return true
        }
        stack.push(child.pid)
      }
    }
    return false
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
      // Best-effort marker write
    }
  }

  private clearCodexWorkspaceActivity(workspaceId: string | undefined, ptyPid: number): void {
    if (!workspaceId) return
    try {
      unlinkSync(this.codexMarkerPath(workspaceId, ptyPid))
    } catch {
      // Best-effort marker removal
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
    if (!this.isCodexActivityMarked(instance.workspaceId, instance.process.pid)) return

    // Codex is explicitly waiting on user input: clear spinner activity and
    // surface unread attention via the existing notify channel.
    instance.codexAwaitingAnswer = true
    instance.codexPromptBuffer = ''
    this.clearCodexWorkspaceActivity(instance.workspaceId, instance.process.pid)
    if (!instance.webContents.isDestroyed()) {
      instance.webContents.send(IPC.CLAUDE_NOTIFY_WORKSPACE, instance.workspaceId)
    }
  }

  private isCodexActivityMarked(workspaceId: string, ptyPid: number): boolean {
    try {
      return existsSync(this.codexMarkerPath(workspaceId, ptyPid))
    } catch {
      return false
    }
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
