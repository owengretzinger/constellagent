import * as pty from 'node-pty'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { WebContents } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { GEMINI_TAB_LABEL, isGeminiIdleOscTitle } from '../shared/gemini-tab-title'
import {
  DEFAULT_ACTIVITY_DIR,
  CLAUDE_MARKER_SUFFIX,
  CODEX_MARKER_SEGMENT,
  GEMINI_MARKER_SEGMENT,
  CURSOR_MARKER_SEGMENT,
} from '../shared/agent-markers'

const TAB_TITLE_LOG = '[constellagent:tab-title]'

interface PtyInstance {
  process: pty.IPty
  webContents: WebContents
  onExitCallbacks: Array<(exitCode: number) => void>
  cols: number
  rows: number
  workspaceId?: string
  agentType?: string
  workingDir: string
  codexPromptBuffer: string
  codexAwaitingAnswer: boolean
  lastOscTitle: string
  /** Title waiting on debounce before PTY_TITLE_CHANGED */
  pendingOscTitle: string | null
  oscTitleTimer: ReturnType<typeof setTimeout> | null
  /** Unterminated OSC chunks (Codex / crossterm often use ST + split writes) */
  oscTitleCarry: string
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

interface AgentPattern {
  agentType: string
  basenames: string[]
  nodeBasenames?: string[]
}

const AGENT_PATTERNS: AgentPattern[] = [
  { agentType: 'claude-code', basenames: ['claude'] },
  { agentType: 'codex',       basenames: ['codex'], nodeBasenames: ['codex', 'codex.js'] },
  { agentType: 'gemini',      basenames: ['gemini'] },
  { agentType: 'cursor',      basenames: ['cursor-agent', 'cursor', 'agent'] },
]

function detectAgentFromCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/)
  if (tokens.length === 0) return null
  const first = (tokens[0] ?? '').split('/').pop()?.toLowerCase() ?? ''
  const isNodeOrBun = first === 'node' || first.endsWith('/node')
    || first === 'bun' || first.endsWith('/bun')
  const second = (tokens[1] ?? '').split('/').pop()?.toLowerCase() ?? ''

  for (const pattern of AGENT_PATTERNS) {
    if (pattern.basenames.includes(first)) return pattern.agentType
    if (isNodeOrBun) {
      const names = pattern.nodeBasenames ?? pattern.basenames
      if (names.includes(second)) return pattern.agentType
      if (names.some(n => (tokens[1] ?? '').includes(`/${n}`)))
        return pattern.agentType
    }
  }
  return null
}

const CODEX_PROMPT_BUFFER_MAX = 4096
const CODEX_QUESTION_HEADER_RE = /Question\s+\d+\s*\/\s*\d+\s*\(\s*\d+\s+unanswered\s*\)/i
const CODEX_QUESTION_HINT_RE = /enter to submit answer/i

function stripAnsiSequences(data: string): string {
  return data
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP.*?\x1b\\/g, '')
}

const OSC_TITLE_CARRY_MAX = 16384
// OSC 0 / 2: icon + window title; end with BEL (7) or ST (ESC \) — Rust TUIs often use ST only.
const OSC_TITLE_COMPLETE_RE = /\x1b\](?:0|2);([\s\S]*?)(?:\x07|\x1b\\)/g

function consumeOscTitleSequences(buffer: string): { lastTitle: string | null; rest: string } {
  OSC_TITLE_COMPLETE_RE.lastIndex = 0
  let lastTitle: string | null = null
  let lastEnd = 0
  let m: RegExpExecArray | null
  while ((m = OSC_TITLE_COMPLETE_RE.exec(buffer)) !== null) {
    const t = m[1]?.trim()
    if (t) lastTitle = t
    lastEnd = OSC_TITLE_COMPLETE_RE.lastIndex
  }
  const rest = lastEnd > 0 ? buffer.slice(lastEnd) : buffer
  return { lastTitle, rest }
}

/** Gemini CLI OSC titles often include a white diamond (poorly supported in tab mono font) and Constellagent sandbox slug. */
function constellagentWsSlugInTitle(s: string): boolean {
  return /\(\s*constellagent-ws(?:-ws)?-[a-z0-9-]+\s*\)/i.test(s)
}

const GEMINI_INTERNAL_WS_SLUG_RE = /\s*\(\s*constellagent-ws(?:-ws)?-[a-z0-9-]+\s*\)/gi
const GEMINI_LEADING_MARK_RE = /^[\s\u25C7\u25C6\u25CB\u2022]+/u

function normalizeOscTabTitle(raw: string, agentType: string | undefined): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  let t = trimmed.replace(GEMINI_INTERNAL_WS_SLUG_RE, ' ').replace(/\s+/g, ' ').trim()

  const looksLikeGeminiChrome =
    agentType === 'gemini'
    || constellagentWsSlugInTitle(trimmed)
    || (GEMINI_LEADING_MARK_RE.test(t) && /\bReady\b/i.test(t))

  if (looksLikeGeminiChrome) {
    t = t.replace(GEMINI_LEADING_MARK_RE, '').replace(/\s+/g, ' ').trim()
  }

  return t.length > 0 ? t : trimmed
}

/** Final string used for tabs / IPC / session meta (Gemini idle OSC → product label). */
function oscTitleForTab(raw: string, agentType: string | undefined): string {
  const n = normalizeOscTabTitle(raw, agentType)
  if (!n) return ''
  // Gemini emits "Ready" via OSC before we always have agentType === 'gemini'; show product label in tab + logs.
  if (/^ready$/i.test(n.trim())) return GEMINI_TAB_LABEL
  if (agentType === 'gemini' && isGeminiIdleOscTitle(n)) return GEMINI_TAB_LABEL
  return n
}

const CODEX_TAB_TITLE_MAX = 72

/** OSC color query responses (10/11/4; …) can surface as plain ASCII in the xterm onData buffer. */
function looksLikeOscColorResponseArtifact(line: string): boolean {
  if (/^\d*;rgb:/i.test(line)) return true
  const chunks =
    line.match(
      /(?:\d+;)?rgb:[0-9a-f]{2,4}\/[0-9a-f]{2,4}\/[0-9a-f]{2,4}/gi,
    ) ?? []
  return chunks.length >= 2
}

/**
 * Strip xterm color-query leakage: full `10;rgb:x/y/z`, bare `;rgb:x/y/z`, and partial `;rgb:x/y/`
 * fragments (digits before `;rgb:` are optional; replies often concatenate without separators).
 */
const OSC_RGB_JUNK_RE =
  /\d+;rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+|;rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+|\d+;rgb:[0-9a-f]+\/[0-9a-f]+\/|;rgb:[0-9a-f]+\/[0-9a-f]+\//gi

function stripOscRgbResponseArtifacts(text: string): string {
  let cur = text
  for (let i = 0; i < 16; i++) {
    const next = cur.replace(OSC_RGB_JUNK_RE, '').replace(/\s+/g, ' ').trim()
    if (next === cur) break
    cur = next
  }
  return cur
}

function stripBracketedPasteWrapper(data: string): string {
  return data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, '')
}

/** First usable line for a Codex tab title (shared by PTY write heuristics and xterm buffer IPC). */
function extractCodexTabTitleFromText(data: string): string | null {
  const stripped = stripBracketedPasteWrapper(data)
  const normalized = stripped.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  for (const rawLine of normalized.split('\n')) {
    let line = stripAnsiSequences(rawLine).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
    if (line.length < 3) continue
    const beforeOscStrip = line
    line = stripOscRgbResponseArtifacts(line)
    if (line.length < 2) continue
    // Short titles are OK when OSC color-query noise was stripped; keep requiring 3+ for unchanged lines
    // so bare two-letter input is not promoted to a tab title.
    if (line.length < 3 && line === beforeOscStrip) continue
    if (looksLikeOscColorResponseArtifact(line)) continue
    if (/^(y|n|p|yes|no)$/i.test(line)) continue
    return line.length > CODEX_TAB_TITLE_MAX ? `${line.slice(0, CODEX_TAB_TITLE_MAX)}…` : line
  }
  return null
}

export type PtyWriteOpts = {
  /** Local input line from xterm when `data` is only \\r/\\n (bundled so main sees it with the same IPC as write). */
  submittedLine?: string
}

function getActivityDir(): string {
  return process.env.CONSTELLAGENT_ACTIVITY_DIR || DEFAULT_ACTIVITY_DIR
}

export class PtyManager {
  private ptys = new Map<string, PtyInstance>()
  private nextId = 0
  onTitleChanged?: (ptyId: string, title: string, workspaceId: string | undefined, workingDir: string) => void
  onAgentDetected?: (ptyId: string, agentType: string) => void

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
      this.handleCodexQuestionPrompt(instance, data)
      this.handleOscTitle(id, instance, data)
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
      agentType: extraEnv?.AGENT_ORCH_AGENT_TYPE,
      workingDir: workingDir,
      codexPromptBuffer: '',
      codexAwaitingAnswer: false,
      lastOscTitle: '',
      pendingOscTitle: null,
      oscTitleTimer: null,
      oscTitleCarry: '',
    }

    proc.onExit(({ exitCode }) => {
      this.clearCodexWorkspaceActivity(instance.workspaceId, instance.process.pid)
      this.clearAgentActivityMarker(instance)
      for (const cb of instance.onExitCallbacks) cb(exitCode)
      this.ptys.delete(id)
    })

    this.ptys.set(id, instance)
    const presetAgent = instance.agentType
    if (presetAgent && presetAgent !== 'unknown') {
      this.notifyAgentDetected(id, instance, presetAgent)
    }
    return id
  }

  onExit(ptyId: string, callback: (exitCode: number) => void): void {
    const instance = this.ptys.get(ptyId)
    if (instance) instance.onExitCallbacks.push(callback)
  }

  /**
   * Tab title from xterm's local line buffer (legacy IPC). Prefer bundling `submittedLine` on
   * {@link PtyManager.write} so title + activity run in one main handler with no ordering gap.
   */
  suggestTabTitle(ptyId: string, line: string): void {
    const instance = this.ptys.get(ptyId)
    if (!instance) {
      console.log(TAB_TITLE_LOG, 'suggestTabTitle: no PTY instance', { ptyId })
      return
    }
    if (!instance.workspaceId) {
      console.log(TAB_TITLE_LOG, 'suggestTabTitle: skipped (no workspaceId on PTY)', { ptyId })
      return
    }
    if (!this.isCodexRunningUnder(instance.process.pid)) {
      console.log(TAB_TITLE_LOG, 'suggestTabTitle: skipped (Codex not running under this PTY)', { ptyId })
      return
    }
    console.log(TAB_TITLE_LOG, 'suggestTabTitle: legacy IPC path (xterm-line-buffer)', {
      ptyId,
      lineByteLength: Buffer.byteLength(line, 'utf8'),
      linePreview: line.replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 72),
    })
    this.emitCodexTabTitleFromInputLine(ptyId, instance, line, 'xterm-line-buffer')
  }

  private clearOscTitleDebounce(instance: PtyInstance): void {
    if (instance.oscTitleTimer) {
      clearTimeout(instance.oscTitleTimer)
      instance.oscTitleTimer = null
      instance.pendingOscTitle = null
    }
  }

  /** Derive Codex tab title from PTY write bytes and/or the renderer's local line snapshot. */
  private emitCodexTabTitleFromInputLine(
    ptyId: string,
    instance: PtyInstance,
    line: string,
    source: 'codex-pty-write' | 'xterm-line-buffer',
  ): void {
    const derived = extractCodexTabTitleFromText(line)
    if (!derived) {
      const stripped = stripAnsiSequences(line).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()
      if (stripped.length >= 3) {
        const firstLine = stripped.split('\n')[0] ?? ''
        const afterRgbStrip = stripOscRgbResponseArtifacts(firstLine)
        let filterReason: string | undefined
        if (afterRgbStrip.length < 3 && looksLikeOscColorResponseArtifact(firstLine))
          filterReason = 'osc-color-response-artifact-only'
        else if (looksLikeOscColorResponseArtifact(firstLine)) filterReason = 'osc-color-response-artifact'
        else if (/^(y|n|p|yes|no)$/i.test(firstLine.trim())) filterReason = 'short-affirmative-reply'
        console.log(TAB_TITLE_LOG, 'codex tab title: extractCodexTabTitleFromText skipped line', {
          ptyId,
          source,
          workspaceId: instance.workspaceId,
          lineByteLength: Buffer.byteLength(line, 'utf8'),
          filterReason,
          preview: stripped.slice(0, 80),
          afterRgbStripPreview: afterRgbStrip ? afterRgbStrip.slice(0, 80) : undefined,
        })
      }
      return
    }
    this.clearOscTitleDebounce(instance)
    this.emitOscTitleIfNew(ptyId, instance, derived, source)
  }

  write(ptyId: string, data: string, opts?: PtyWriteOpts): void {
    const instance = this.ptys.get(ptyId)
    if (!instance) return

    // Codex doesn't expose a prompt-submit hook, so mark the workspace active
    // when Enter is sent while a Codex process is already running in this PTY.
    if (/[\r\n]/.test(data)) {
      const codexRunning = this.isCodexRunningUnder(instance.process.pid)
      if (instance.workspaceId && codexRunning) {
        instance.codexPromptBuffer = ''
        instance.codexAwaitingAnswer = false
        this.markCodexWorkspaceActive(instance.workspaceId, instance.process.pid)
        const fromChunk = extractCodexTabTitleFromText(data)
        if (fromChunk) {
          this.emitCodexTabTitleFromInputLine(ptyId, instance, data, 'codex-pty-write')
        } else if (opts?.submittedLine) {
          this.emitCodexTabTitleFromInputLine(ptyId, instance, opts.submittedLine, 'xterm-line-buffer')
        } else {
          const byteLength = Buffer.byteLength(data, 'utf8')
          const chunkLooksLikeNewlineOnly = /^[\r\n]+$/.test(data)
          console.log(TAB_TITLE_LOG, 'codex derive from PTY write: no inline title (newline-only chunk or empty prompt in write payload)', {
            ptyId,
            workspaceId: instance.workspaceId,
            byteLength,
            newlineOnlyChunk: chunkLooksLikeNewlineOnly,
            note: 'xterm/Codex often sends Enter without the prompt text on this path; tab title uses bundled submittedLine, OSC, or context DB',
          })
        }
      } else if (codexRunning && !instance.workspaceId) {
        console.log(TAB_TITLE_LOG, 'codex PTY write title skipped (no workspaceId on PTY)', { ptyId })
      }
    }

    // Lazily detect agent type
    if (instance.workspaceId && /[\r\n]/.test(data)) {
      if (!instance.agentType || instance.agentType === 'unknown') {
        const detected = this.detectAgentUnder(instance.process.pid)
        if (detected) {
          instance.agentType = detected
          this.writeAgentActivityMarker(instance.workspaceId, detected, instance.process.pid)
          this.notifyAgentDetected(ptyId, instance, detected)
        } else {
          // Retry after 1.5s — process may not have spawned yet
          const wsId = instance.workspaceId
          const pid = instance.process.pid
          setTimeout(() => {
            if (instance.agentType && instance.agentType !== 'unknown') return
            const retryDetected = this.detectAgentUnder(pid)
            if (retryDetected) {
              instance.agentType = retryDetected
              this.writeAgentActivityMarker(wsId, retryDetected, pid)
              this.notifyAgentDetected(ptyId, instance, retryDetected)
            }
          }, 1500)
        }
      }
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
      this.clearCodexWorkspaceActivity(instance.workspaceId, instance.process.pid)
      this.clearAgentActivityMarker(instance)
      instance.process.kill()
      this.ptys.delete(ptyId)
    }
  }

  /** Return IDs of all live PTY processes */
  list(): string[] {
    return Array.from(this.ptys.keys())
  }

  private detectAgentUnder(rootPid: number): string | null {
    let processTable = ''
    try {
      processTable = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf-8' })
    } catch {
      return null
    }

    const entries = parseProcessTable(processTable)
    if (entries.length === 0) return null

    for (const entry of entries) {
      if (entry.ppid !== rootPid) continue
      const detected = detectAgentFromCommand(entry.command)
      if (detected) return detected
    }
    return null
  }

  private isCodexRunningUnder(rootPid: number): boolean {
    return this.detectAgentUnder(rootPid) === 'codex'
  }

  private agentMarkerPath(workspaceId: string, agentType: string, ptyPid: number): string {
    switch (agentType) {
      case 'claude-code': return `${getActivityDir()}/${workspaceId}${CLAUDE_MARKER_SUFFIX}`
      case 'codex': return `${getActivityDir()}/${workspaceId}${CODEX_MARKER_SEGMENT}${ptyPid}`
      case 'gemini': return `${getActivityDir()}/${workspaceId}${GEMINI_MARKER_SEGMENT}${ptyPid}`
      case 'cursor': return `${getActivityDir()}/${workspaceId}${CURSOR_MARKER_SEGMENT}${ptyPid}`
      default: return `${getActivityDir()}/${workspaceId}.${agentType}.${ptyPid}`
    }
  }

  private writeAgentActivityMarker(workspaceId: string, agentType: string, ptyPid: number): void {
    // Claude and Codex already write their own markers via hooks/submit handlers
    if (agentType === 'claude-code' || agentType === 'codex') return
    try {
      const activityDir = getActivityDir()
      mkdirSync(activityDir, { recursive: true })
      writeFileSync(this.agentMarkerPath(workspaceId, agentType, ptyPid), '')
    } catch {
      // Best-effort marker write
    }
  }

  private clearAgentActivityMarker(instance: PtyInstance): void {
    if (!instance.workspaceId || !instance.agentType) return
    if (instance.agentType === 'claude-code' || instance.agentType === 'codex') return
    try {
      unlinkSync(this.agentMarkerPath(instance.workspaceId, instance.agentType, instance.process.pid))
    } catch {
      // Best-effort marker removal
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

  private emitOscTitleIfNew(ptyId: string, instance: PtyInstance, title: string, source = 'pty'): void {
    const display = oscTitleForTab(title, instance.agentType)
    if (!display || display === instance.lastOscTitle) return
    instance.lastOscTitle = display
    console.log(TAB_TITLE_LOG, '→ PTY_TITLE_CHANGED', {
      ptyId,
      source,
      workspaceId: instance.workspaceId,
      title: display.slice(0, 80),
    })
    if (!instance.webContents.isDestroyed()) {
      instance.webContents.send(IPC.PTY_TITLE_CHANGED, { ptyId, title: display })
    }
    this.onTitleChanged?.(ptyId, display, instance.workspaceId, instance.workingDir)
  }

  private notifyAgentDetected(ptyId: string, instance: PtyInstance, agentType: string): void {
    if (instance.oscTitleTimer) {
      clearTimeout(instance.oscTitleTimer)
      instance.oscTitleTimer = null
      const pending = instance.pendingOscTitle
      instance.pendingOscTitle = null
      if (pending) this.emitOscTitleIfNew(ptyId, instance, pending, 'osc-flush-on-agent-detect')
    }
    if (!instance.webContents.isDestroyed()) {
      instance.webContents.send(IPC.PTY_AGENT_DETECTED, { ptyId, agentType })
    }
    this.onAgentDetected?.(ptyId, agentType)
  }

  private handleOscTitle(ptyId: string, instance: PtyInstance, data: string): void {
    instance.oscTitleCarry = (instance.oscTitleCarry + data).slice(-OSC_TITLE_CARRY_MAX)
    const { lastTitle, rest } = consumeOscTitleSequences(instance.oscTitleCarry)
    instance.oscTitleCarry = rest.slice(-OSC_TITLE_CARRY_MAX)

    if (!lastTitle) return
    const display = oscTitleForTab(lastTitle, instance.agentType)
    if (!display || display === instance.lastOscTitle) return

    console.log(TAB_TITLE_LOG, 'OSC title extracted (debouncing 500ms)', { ptyId, title: display.slice(0, 80) })
    if (instance.oscTitleTimer) clearTimeout(instance.oscTitleTimer)
    instance.pendingOscTitle = lastTitle
    instance.oscTitleTimer = setTimeout(() => {
      instance.oscTitleTimer = null
      const t = instance.pendingOscTitle
      instance.pendingOscTitle = null
      if (t) this.emitOscTitleIfNew(ptyId, instance, t, 'osc')
    }, 500)
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
  reattach(ptyId: string, webContents: WebContents): boolean {
    const instance = this.ptys.get(ptyId)
    if (!instance) return false
    instance.webContents = webContents
    instance.oscTitleCarry = ''
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
