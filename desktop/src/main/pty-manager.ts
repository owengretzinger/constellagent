import * as pty from 'node-pty'
import { execFileSync } from 'child_process'
import { mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { WebContents } from 'electron'
import { IPC } from '../shared/ipc-channels'

interface PtyInstance {
  process: pty.IPty
  webContents: WebContents
  onExitCallbacks: Array<(exitCode: number) => void>
  cols: number
  rows: number
  workspaceId?: string
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

const ACTIVITY_DIR = '/tmp/constellagent-activity'

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

    let pendingWrite = initialWrite
    proc.onData((data) => {
      if (!instance.webContents.isDestroyed()) {
        instance.webContents.send(`${IPC.PTY_DATA}:${id}`, data)
      }
      // Write initial command on first output (shell is ready)
      if (pendingWrite) {
        const toWrite = pendingWrite
        pendingWrite = undefined
        proc.write(toWrite)
      }
    })

    const instance: PtyInstance = {
      process: proc,
      webContents,
      onExitCallbacks: [],
      cols: 80,
      rows: 24,
      workspaceId: extraEnv?.AGENT_ORCH_WS_ID,
    }

    proc.onExit(({ exitCode }) => {
      this.clearWorkspaceActivity(instance.workspaceId)
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
      this.markWorkspaceActive(instance.workspaceId)
    }

    instance.process.write(data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      instance.cols = cols
      instance.rows = rows
      instance.process.resize(cols, rows)
    }
  }

  destroy(ptyId: string): void {
    const instance = this.ptys.get(ptyId)
    if (instance) {
      this.clearWorkspaceActivity(instance.workspaceId)
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

  private markWorkspaceActive(workspaceId: string): void {
    try {
      mkdirSync(ACTIVITY_DIR, { recursive: true })
      writeFileSync(`${ACTIVITY_DIR}/${workspaceId}`, '')
    } catch {
      // Best-effort marker write
    }
  }

  private clearWorkspaceActivity(workspaceId?: string): void {
    if (!workspaceId) return
    try {
      unlinkSync(`${ACTIVITY_DIR}/${workspaceId}`)
    } catch {
      // Best-effort marker removal
    }
  }

  /** Update the webContents reference for an existing PTY (e.g. after renderer reload) */
  reattach(ptyId: string, webContents: WebContents): boolean {
    const instance = this.ptys.get(ptyId)
    if (!instance) return false
    instance.webContents = webContents
    // Send SIGWINCH directly so TUI apps (Claude Code) redraw their screen.
    // Can't use resize() with same dimensions — kernel skips the signal on no-op.
    try { process.kill(instance.process.pid, 'SIGWINCH') } catch {}
    return true
  }

  destroyAll(): void {
    for (const [id] of this.ptys) {
      this.destroy(id)
    }
  }
}
