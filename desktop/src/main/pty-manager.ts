import * as pty from 'node-pty'
import { WebContents } from 'electron'
import { IPC } from '../shared/ipc-channels'

interface PtyInstance {
  process: pty.IPty
  webContents: WebContents
  onExitCallbacks: Array<(exitCode: number) => void>
  cols: number
  rows: number
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

    const instance: PtyInstance = { process: proc, webContents, onExitCallbacks: [], cols: 80, rows: 24 }

    proc.onExit(({ exitCode }) => {
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
    this.ptys.get(ptyId)?.process.write(data)
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
      instance.process.kill()
      this.ptys.delete(ptyId)
    }
  }

  /** Return IDs of all live PTY processes */
  list(): string[] {
    return Array.from(this.ptys.keys())
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
