import { IMessageSDK } from '@photon-ai/imessage-kit'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { PhoneControlSettings, PhoneControlStatus } from '../shared/phone-control-types'
import type { AutomationRunStartedEvent } from '../shared/automation-types'
import type { PtyManager } from './pty-manager'
import { GitService } from './git-service'
import { trustPathForClaude } from './claude-config'

interface PhoneSession {
  num: number
  ptyId: string
  workspaceId: string
  projectId: string
  projectName: string
  agentType: string
  branch: string
  worktreePath: string
  prompt: string
  title: string
  status: 'active' | 'idle'
  outputBuffer: string[]
  startedAt: number
}

export interface ProjectInfo {
  id: string
  name: string
  repoPath: string
}

type ParsedCommand =
  | { type: 'run'; agent: string; project?: string; prompt: string }
  | { type: 'followup'; sessionNum: number; text: string }
  | { type: 'status' }
  | { type: 'output'; sessionNum?: number }
  | { type: 'stop'; sessionNum?: number }
  | { type: 'projects' }
  | { type: 'followup-recent'; text: string }

const OUTPUT_BUFFER_MAX = 200
const OUTPUT_DISPLAY_LINES = 30
const MAX_MESSAGE_LENGTH = 2000

const AGENT_COMMANDS: Record<string, string> = {
  claude: 'claude',
  gemini: 'gemini',
  codex: 'codex',
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP.*?\x1b\\/g, '')
}

function capitalize(s: string): string {
  if (s === 'claude') return 'Claude'
  if (s === 'gemini') return 'Gemini'
  if (s === 'codex') return 'Codex'
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function formatPhoneControlErr(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export class IMessageService {
  private sdk: IMessageSDK | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private streamTimer: ReturnType<typeof setInterval> | null = null
  private lastMessageDate: Date = new Date()
  /** Last DB / permission failure (cleared on successful start). */
  private permissionError: string | null = null
  private pollDbFailureLogged = false
  private sessions = new Map<number, PhoneSession>()
  private ptyToSession = new Map<string, number>()
  private workspaceToSession = new Map<string, number>()
  private nextSessionNum = 1
  private settings: PhoneControlSettings = {
    enabled: false,
    contactId: '',
    notifyOnStart: true,
    notifyOnFinish: true,
    streamOutput: false,
    streamIntervalSec: 10,
  }

  constructor(
    private ptyManager: PtyManager,
    private getProjects: () => ProjectInfo[],
    private getActiveProjectId: () => string | null,
  ) {}

  // ── Lifecycle ──

  async start(settings: PhoneControlSettings): Promise<void> {
    this.stopInternal(false)
    this.settings = settings
    this.permissionError = null
    this.pollDbFailureLogged = false
    if (!settings.enabled || !settings.contactId) {
      this.stopInternal(true)
      return
    }

    this.sdk = new IMessageSDK()
    try {
      // Await DB init immediately so initPromise rejection is handled (avoids unhandledRejection)
      // and we fail fast if Full Disk Access is missing.
      await this.sdk.getMessages({ limit: 1 })
    } catch (err) {
      const msg = formatPhoneControlErr(err)
      this.permissionError =
        msg.includes('unable to open database') || msg.includes('chat.db')
          ? 'Cannot read Messages database. Grant Full Disk Access to the app shown below (use “Open Full Disk Access settings”), then toggle Phone Control off and on.'
          : msg
      // Do not call sdk.close() here: imessage-kit's close() awaits database.close(), which
      // calls ensureInit() again and surfaces a second rejection / unhandled promise when the DB
      // never opened. Drop the reference only (one leaked SDK instance on failure).
      this.sdk = null
      throw new Error(this.permissionError)
    }

    this.lastMessageDate = new Date()
    this.pollTimer = setInterval(() => this.poll(), 3000)

    if (settings.streamOutput && settings.streamIntervalSec > 0) {
      this.streamTimer = setInterval(
        () => this.streamOutputTick(),
        settings.streamIntervalSec * 1000,
      )
    }

    console.log('[phone-control] Started, listening for messages from', settings.contactId)
  }

  /** Tear down SDK and timers. Pass clearPermissionError when the user disables Phone Control. */
  private stopInternal(clearPermissionError: boolean): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.streamTimer) {
      clearInterval(this.streamTimer)
      this.streamTimer = null
    }
    if (this.sdk) {
      this.sdk.close().catch(() => {})
      this.sdk = null
    }
    if (clearPermissionError) {
      this.permissionError = null
      this.pollDbFailureLogged = false
    }
  }

  stop(): void {
    this.stopInternal(true)
  }

  updateSettings(settings: PhoneControlSettings): void {
    this.settings = settings
    if (this.streamTimer) {
      clearInterval(this.streamTimer)
      this.streamTimer = null
    }
    if (this.sdk && settings.streamOutput && settings.streamIntervalSec > 0) {
      this.streamTimer = setInterval(
        () => this.streamOutputTick(),
        settings.streamIntervalSec * 1000,
      )
    }
  }

  isRunning(): boolean {
    return this.sdk !== null
  }

  getStatus(): PhoneControlStatus {
    return {
      running: this.isRunning(),
      contactId: this.settings.contactId,
      sessionCount: this.sessions.size,
      executablePathForPermissions: process.execPath,
      permissionError: this.permissionError,
    }
  }

  async testSend(message: string): Promise<void> {
    if (!this.sdk) throw new Error('Phone control not running')
    try {
      await this.sdk.send(this.settings.contactId, message)
    } catch (err) {
      const msg = formatPhoneControlErr(err)
      if (msg.includes('Messages app is not running')) {
        throw new Error(
          'Messages is not running. Open the Messages app on this Mac, then try Test again.',
        )
      }
      throw err instanceof Error ? err : new Error(msg)
    }
  }

  destroy(): void {
    this.stopInternal(true)
    this.sessions.clear()
    this.ptyToSession.clear()
    this.workspaceToSession.clear()
  }

  // ── External event callbacks (wired from ipc.ts) ──

  onPtyData(ptyId: string, data: string): void {
    const sessionNum = this.ptyToSession.get(ptyId)
    if (sessionNum === undefined) return
    const session = this.sessions.get(sessionNum)
    if (!session) return

    const clean = stripAnsi(data)
    for (const line of clean.split('\n')) {
      if (line.trim()) {
        session.outputBuffer.push(line.trimEnd())
        if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
          session.outputBuffer.shift()
        }
      }
    }
  }

  onNotify(workspaceId: string): void {
    const sessionNum = this.workspaceToSession.get(workspaceId)
    if (sessionNum === undefined) return
    const session = this.sessions.get(sessionNum)
    if (!session) return

    session.status = 'idle'
    if (this.settings.notifyOnFinish) {
      this.sendMessage(
        `#${session.num} ${capitalize(session.agentType)} finished @ ${session.projectName}`,
      ).catch(() => {})
    }
  }

  onTitleChanged(ptyId: string, title: string): void {
    const sessionNum = this.ptyToSession.get(ptyId)
    if (sessionNum === undefined) return
    const session = this.sessions.get(sessionNum)
    if (session) session.title = title
  }

  /** Link a workspace ID to a session when the renderer creates the workspace for a phone-spawned PTY. */
  registerWorkspaceForPty(ptyId: string, workspaceId: string): void {
    const sessionNum = this.ptyToSession.get(ptyId)
    if (sessionNum === undefined) return
    const session = this.sessions.get(sessionNum)
    if (session) {
      session.workspaceId = workspaceId
      this.workspaceToSession.set(workspaceId, sessionNum)
    }
  }

  // ── Polling ──

  private async poll(): Promise<void> {
    if (!this.sdk) return
    try {
      const result = await this.sdk.getMessages({
        since: this.lastMessageDate,
        excludeOwnMessages: true,
        sender: this.settings.contactId,
        limit: 10,
      })
      for (const msg of result.messages) {
        this.lastMessageDate = msg.date
        if (msg.text) {
          await this.handleMessage(msg.text)
        }
      }
    } catch (err) {
      const msg = formatPhoneControlErr(err)
      if (msg.includes('unable to open database') || msg.includes('chat.db')) {
        if (!this.pollDbFailureLogged) {
          this.pollDbFailureLogged = true
          this.permissionError =
            'Lost access to the Messages database. Check Full Disk Access for this app, then restart Phone Control.'
          console.error('[phone-control] Poll error (database):', err)
        }
      } else if (!this.pollDbFailureLogged) {
        console.error('[phone-control] Poll error:', err)
      }
    }
  }

  // ── Command dispatch ──

  private async handleMessage(text: string): Promise<void> {
    const cmd = this.parseCommand(text.trim())
    switch (cmd.type) {
      case 'run':
        await this.handleRunCommand(cmd.agent, cmd.prompt, cmd.project)
        break
      case 'followup':
        await this.handleFollowUp(cmd.sessionNum, cmd.text)
        break
      case 'followup-recent':
        await this.handleFollowUpRecent(cmd.text)
        break
      case 'status':
        await this.handleStatusCommand()
        break
      case 'output':
        await this.handleOutput(cmd.sessionNum)
        break
      case 'stop':
        await this.handleStop(cmd.sessionNum)
        break
      case 'projects':
        await this.handleProjects()
        break
    }
  }

  // ── Command parser ──

  private parseCommand(text: string): ParsedCommand {
    // Agent command: claude/gemini/codex [@project] prompt
    const agentMatch = text.match(/^(claude|gemini|codex)\s+(?:@([\w-]+)\s+)?(.+)/is)
    if (agentMatch) {
      return {
        type: 'run',
        agent: agentMatch[1].toLowerCase(),
        project: agentMatch[2] || undefined,
        prompt: agentMatch[3],
      }
    }

    // Targeted follow-up: #N text
    const followupMatch = text.match(/^#(\d+)\s+(.+)/s)
    if (followupMatch) {
      return {
        type: 'followup',
        sessionNum: parseInt(followupMatch[1], 10),
        text: followupMatch[2],
      }
    }

    if (/^status$/i.test(text)) return { type: 'status' }

    const outputMatch = text.match(/^output\s*#?(\d+)?$/i)
    if (outputMatch) {
      return {
        type: 'output',
        sessionNum: outputMatch[1] ? parseInt(outputMatch[1], 10) : undefined,
      }
    }

    const stopMatch = text.match(/^stop\s*#?(\d+)?$/i)
    if (stopMatch) {
      return {
        type: 'stop',
        sessionNum: stopMatch[1] ? parseInt(stopMatch[1], 10) : undefined,
      }
    }

    if (/^projects$/i.test(text)) return { type: 'projects' }

    // Anything else → follow-up to most recently active session
    return { type: 'followup-recent', text }
  }

  // ── Command handlers ──

  private async handleRunCommand(
    agent: string,
    prompt: string,
    projectName?: string,
  ): Promise<void> {
    const projects = this.getProjects()
    if (projects.length === 0) {
      await this.sendMessage('No projects configured in Constellagent')
      return
    }

    let project: ProjectInfo
    if (projectName) {
      const found = projects.find(
        (p) => p.name.toLowerCase() === projectName.toLowerCase(),
      )
      if (!found) {
        await this.sendMessage(
          `Project "${projectName}" not found. Text "projects" to list available projects.`,
        )
        return
      }
      project = found
    } else if (projects.length === 1) {
      project = projects[0]
    } else {
      const activeId = this.getActiveProjectId()
      project = projects.find((p) => p.id === activeId) || projects[0]
    }

    // Create worktree
    const sanitized = prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 20)
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const branch = `auto/${sanitized}/${timestamp}`
    const wtName = `phone-${agent}-${sanitized}-${timestamp}`

    let worktreePath: string
    try {
      worktreePath = await GitService.createWorktree(
        project.repoPath,
        wtName,
        branch,
        true,
      )
    } catch (err) {
      console.error('[phone-control] Failed to create worktree:', err)
      await this.sendMessage(`Failed to create worktree: ${err}`)
      return
    }

    try {
      await trustPathForClaude(worktreePath)
    } catch {
      // non-fatal
    }

    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      await this.sendMessage('No Constellagent window found')
      return
    }

    // Spawn shell with agent command
    const shell = process.env.SHELL || '/bin/zsh'
    const agentCmd = AGENT_COMMANDS[agent] || 'claude'
    const escapedPrompt = prompt.replace(/'/g, "'\\''")
    const ptyId = this.ptyManager.create(
      worktreePath,
      win.webContents,
      shell,
      undefined,
      `${agentCmd} '${escapedPrompt}'\r`,
    )

    const sessionNum = this.nextSessionNum++
    const session: PhoneSession = {
      num: sessionNum,
      ptyId,
      workspaceId: '', // filled when renderer creates workspace via AUTOMATION_RUN_STARTED
      projectId: project.id,
      projectName: project.name,
      agentType: agent,
      branch,
      worktreePath,
      prompt,
      title: '',
      status: 'active',
      outputBuffer: [],
      startedAt: Date.now(),
    }
    this.sessions.set(sessionNum, session)
    this.ptyToSession.set(ptyId, sessionNum)

    // Emit AUTOMATION_RUN_STARTED so the renderer creates workspace + terminal tab
    if (!win.isDestroyed()) {
      const event: AutomationRunStartedEvent = {
        automationId: `phone-${sessionNum}`,
        automationName: `Phone #${sessionNum}: ${prompt.slice(0, 40)}`,
        projectId: project.id,
        ptyId,
        worktreePath,
        branch,
      }
      win.webContents.send(IPC.AUTOMATION_RUN_STARTED, event)
    }

    if (this.settings.notifyOnStart) {
      await this.sendMessage(
        `#${sessionNum} Started ${capitalize(agent)} @ ${project.name} (${branch})`,
      )
    }
  }

  private async handleFollowUp(
    sessionNum: number,
    text: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionNum)
    if (!session) {
      await this.sendMessage(`Session #${sessionNum} not found`)
      return
    }
    this.ptyManager.write(session.ptyId, text + '\r')
    await this.sendMessage(
      `→ Sent to #${sessionNum} (${capitalize(session.agentType)})`,
    )
  }

  private async handleFollowUpRecent(text: string): Promise<void> {
    const recent = this.getMostRecentSession()
    if (!recent) {
      await this.sendMessage('No active sessions')
      return
    }
    this.ptyManager.write(recent.ptyId, text + '\r')
    await this.sendMessage(
      `→ Sent to #${recent.num} (${capitalize(recent.agentType)}, most recent)`,
    )
  }

  private async handleStatusCommand(): Promise<void> {
    if (this.sessions.size === 0) {
      await this.sendMessage('No active sessions')
      return
    }

    const lines: string[] = ['Sessions:']
    for (const session of this.sessions.values()) {
      const lastLine =
        session.title ||
        session.outputBuffer[session.outputBuffer.length - 1] ||
        session.prompt
      lines.push(
        `#${session.num} ${capitalize(session.agentType)} @ ${session.projectName} (${session.branch}) — ${session.status}`,
      )
      lines.push(`   "${lastLine.slice(0, 80)}"`)
    }
    await this.sendMessage(lines.join('\n'))
  }

  private async handleOutput(sessionNum?: number): Promise<void> {
    const session =
      sessionNum !== undefined
        ? this.sessions.get(sessionNum)
        : this.getMostRecentSession()

    if (!session) {
      await this.sendMessage(
        sessionNum !== undefined
          ? `Session #${sessionNum} not found`
          : 'No active sessions',
      )
      return
    }

    const lines = session.outputBuffer.slice(-OUTPUT_DISPLAY_LINES)
    if (lines.length === 0) {
      await this.sendMessage(`#${session.num} No output yet`)
      return
    }

    await this.sendMessage(
      `#${session.num} Output:\n${lines.join('\n')}`,
    )
  }

  private async handleStop(sessionNum?: number): Promise<void> {
    const session =
      sessionNum !== undefined
        ? this.sessions.get(sessionNum)
        : this.getMostRecentSession()

    if (!session) {
      await this.sendMessage(
        sessionNum !== undefined
          ? `Session #${sessionNum} not found`
          : 'No active sessions',
      )
      return
    }

    this.ptyManager.destroy(session.ptyId)
    this.cleanupSession(session.num)
    await this.sendMessage(
      `#${session.num} Stopped ${capitalize(session.agentType)} @ ${session.projectName}`,
    )
  }

  private async handleProjects(): Promise<void> {
    const projects = this.getProjects()
    if (projects.length === 0) {
      await this.sendMessage('No projects configured')
      return
    }
    const lines = projects.map((p) => `- ${p.name} (${p.repoPath})`)
    await this.sendMessage(`Projects:\n${lines.join('\n')}`)
  }

  // ── Helpers ──

  private getMostRecentSession(): PhoneSession | undefined {
    let newest: PhoneSession | undefined
    for (const session of this.sessions.values()) {
      if (!newest || session.startedAt > newest.startedAt) {
        newest = session
      }
    }
    return newest
  }

  private cleanupSession(sessionNum: number): void {
    const session = this.sessions.get(sessionNum)
    if (!session) return
    this.sessions.delete(sessionNum)
    this.ptyToSession.delete(session.ptyId)
    if (session.workspaceId) {
      this.workspaceToSession.delete(session.workspaceId)
    }
  }

  private async sendMessage(text: string): Promise<void> {
    if (!this.sdk) return
    try {
      if (text.length <= MAX_MESSAGE_LENGTH) {
        await this.sdk.send(this.settings.contactId, text)
      } else {
        let remaining = text
        while (remaining.length > 0) {
          await this.sdk.send(
            this.settings.contactId,
            remaining.slice(0, MAX_MESSAGE_LENGTH),
          )
          remaining = remaining.slice(MAX_MESSAGE_LENGTH)
        }
      }
    } catch (err) {
      console.error('[phone-control] Failed to send message:', err)
    }
  }

  private streamOutputTick(): void {
    for (const session of this.sessions.values()) {
      if (session.status !== 'active') continue
      if (session.outputBuffer.length === 0) continue
      const lines = session.outputBuffer.slice(-10)
      this.sendMessage(`#${session.num}:\n${lines.join('\n')}`).catch(
        () => {},
      )
    }
  }
}
