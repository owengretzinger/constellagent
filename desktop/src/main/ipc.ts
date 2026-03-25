import { ipcMain, dialog, app, BrowserWindow, clipboard, type WebContents } from 'electron'
import { join, relative, resolve } from 'path'
import { mkdir, writeFile, readFile, readdir, unlink } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync, realpathSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { watch, type FSWatcher } from 'fs'
import { execFile, type ExecFileException } from 'child_process'
import { promisify } from 'util'
import { IPC } from '../shared/ipc-channels'
import type { PlanAgent } from '../shared/agent-plan-path'
import type { CreateWorktreeProgressEvent } from '../shared/workspace-creation'
import { PtyManager, type PtyWriteOpts } from './pty-manager'
import { GitService } from './git-service'
import { WorktreeSyncService } from './worktree-sync-service'
import { GithubService } from './github-service'
import { FileService, type FileNode } from './file-service'
import { readPlanMeta } from './plan-meta'
import { AutomationScheduler } from './automation-scheduler'
import type { AutomationConfig } from '../shared/automation-types'
import { trustPathForClaude, loadClaudeSettings, saveClaudeSettings, loadJsonFile, saveJsonFile } from './claude-config'
import { loadCodexConfigText, saveCodexConfigText, CODEX_CONFIG_PATH, CODEX_DIR } from './codex-config'
import { loadMcpServersFromConfig, removeServerFromConfig } from './mcp-config'
import { CLAUDE_CONFIG_PATH } from './claude-config'
import { LspService } from './lsp/lsp-service'
import { SkillsService } from './skills-service'

import { ContextDb } from './context-db'
import { getAgentFS, closeAllAgentFS, checkpoint, checkpointAll } from './agentfs-service'
import { AnnotationService, cleanupAnnotationWatchers, setAnnotationNotify } from './annotation-service'
import type { DiffAnnotationAddInput } from '../shared/diff-annotation-types'

const ptyManager = new PtyManager()
const worktreeSyncService = new WorktreeSyncService()

// Wire up OSC title changes to persist session meta in AgentFS
ptyManager.onTitleChanged = (ptyId, title, workspaceId, workingDir) => {
  if (!workspaceId) {
    console.log('[constellagent:tab-title] saveSessionMeta skipped (no workspaceId)', { ptyId, title: title.slice(0, 60) })
    return
  }
  console.log('[constellagent:tab-title] saveSessionMeta', { ptyId, workspaceId, title: title.slice(0, 80) })
  // Find the project dir for this workspace's working dir to access the correct ContextDb
  // The workingDir is the worktree path; the project's repoPath is the root.
  // We need a heuristic: walk up from workingDir to find .constellagent/ or use
  // workingDir directly as projectDir (context-db lazily inits under it).
  // ContextDb keys by projectDir; for worktrees the project root is the ancestor.
  // Since we don't have the project mapping here, use workingDir — saveSessionMeta
  // only needs the AgentFS KV which initializes under any dir.
  const db = getContextDb(workingDir)
  db.saveSessionMeta(workspaceId, {
    sessionId: `pty-${ptyId}`,
    agentType: 'terminal',
    startedAt: new Date().toISOString(),
    summary: title,
  }).catch(() => {})
}

const automationScheduler = new AutomationScheduler(ptyManager)
const lspService = new LspService()

// Cache of open context databases keyed by projectDir
const contextDbs = new Map<string, ContextDb>()
const pendingIndexerWatchers = new Map<string, FSWatcher>()
/** Debounce bursts of pending files so the renderer refreshes context history once per tick */
const contextEntriesUpdatedTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleContextEntriesUpdated(projectDir: string, workspaceId: string): void {
  if (!workspaceId) return
  const key = `${projectDir}\0${workspaceId}`
  const prev = contextEntriesUpdatedTimers.get(key)
  if (prev) clearTimeout(prev)
  contextEntriesUpdatedTimers.set(key, setTimeout(() => {
    contextEntriesUpdatedTimers.delete(key)
    const payload = { projectDir, workspaceId }
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.CONTEXT_ENTRIES_UPDATED, payload)
    }
  }, 150))
}

function getContextDb(projectDir: string): ContextDb {
  let db = contextDbs.get(projectDir)
  if (!db) {
    db = new ContextDb(projectDir)
    contextDbs.set(projectDir, db)
  }
  return db
}

const SLIDING_WINDOW_LIMIT = 20
const SLIDING_WINDOW_HEADER = '# Recent Agent Activity (last 20 actions)\n\n| Time | Agent | Tool | File/Summary |\n|------|-------|------|-------------|\n'

// Debounced agent context file writers keyed by projectDir:wsId
const contextWriteTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Schedule a debounced write of the rich agent context file.
 * This writes the full AgentFS context summary to a file that hook scripts
 * can read and inject into agents on SessionStart and UserPromptSubmit.
 */
function scheduleContextFileWrite(projectDir: string, wsId: string): void {
  const key = `${projectDir}:${wsId}`
  const existing = contextWriteTimers.get(key)
  if (existing) clearTimeout(existing)

  contextWriteTimers.set(key, setTimeout(async () => {
    contextWriteTimers.delete(key)
    try {
      const db = getContextDb(projectDir)
      const contextDir = join(projectDir, '.constellagent', 'context')
      await mkdir(contextDir, { recursive: true })

      // Write per-workspace rich context
      const wsContext = await db.buildAgentContext(wsId)
      await writeFile(join(contextDir, `agent-context-${wsId}.md`), wsContext)

      // Write global context (all workspaces)
      const globalContext = await db.buildGlobalContext()
      await writeFile(join(contextDir, 'agent-context.md'), globalContext)
    } catch (err) { console.error('agentfs: context file generation failed', err) }
  }, 500)) // 500ms debounce
}

function formatSlidingWindowLine(entry: { timestamp?: string; agentType?: string; toolName?: string; filePath?: string | null; toolInput?: string | null }): string {
  const time = entry.timestamp?.replace('T', ' ').replace('Z', '') || '?'
  const agent = entry.agentType || '?'
  const tool = entry.toolName || '?'
  let summary = entry.filePath || ''
  if (!summary && entry.toolInput) {
    try {
      const parsed = JSON.parse(entry.toolInput)
      summary = parsed.command || parsed.file_path || parsed.summary || JSON.stringify(parsed).slice(0, 60)
    } catch {
      summary = (entry.toolInput ?? '').slice(0, 60)
    }
  }
  summary = summary.replace(/\|/g, '\\|').slice(0, 80)
  return `| ${time} | ${agent} | ${tool} | ${summary} |`
}

async function appendAndTrimSlidingWindow(filePath: string, newLine: string): Promise<void> {
  const contextDir = join(filePath, '..')
  await mkdir(contextDir, { recursive: true })

  let dataLines: string[] = []
  try {
    const existing = await readFile(filePath, 'utf-8')
    // Extract only table data rows (skip header, blank lines, and the trailing blank)
    dataLines = existing.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Time') && !l.startsWith('|--'))
  } catch { /* file doesn't exist yet */ }

  dataLines.push(newLine)
  // Keep only the last N entries
  if (dataLines.length > SLIDING_WINDOW_LIMIT) {
    dataLines = dataLines.slice(dataLines.length - SLIDING_WINDOW_LIMIT)
  }

  await writeFile(filePath, SLIDING_WINDOW_HEADER + dataLines.join('\n') + '\n')
}

/**
 * Attempt to repair truncated JSON (e.g. from shell `head -c` cutting mid-value).
 * Closes any unclosed strings, fills dangling keys with null, and closes unclosed braces/brackets.
 */
function repairTruncatedJson(raw: string): string {
  let inString = false
  let escaped = false
  const stack: string[] = []

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (ch === '\\' && inString) {
      escaped = true
      continue
    }

    if (ch === '"') {
      inString = !inString
      continue
    }

    if (inString) continue

    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']')
    } else if (ch === '}' || ch === ']') {
      if (stack.length) stack.pop()
    }
  }

  // Nothing to repair
  if (!inString && stack.length === 0) return raw

  let repaired = raw

  // Close unclosed string
  if (inString) {
    // If we were mid-escape, remove the dangling backslash
    if (escaped) repaired = repaired.slice(0, -1)
    repaired += '"'
  }

  // Handle trailing structural issues before closing braces
  const trimmed = repaired.replace(/[\s]+$/, '')
  if (trimmed.endsWith(':')) {
    repaired = trimmed + 'null'
  } else if (trimmed.endsWith(',')) {
    repaired = trimmed.slice(0, -1)
  }

  // Close any unclosed braces/brackets in reverse order
  while (stack.length > 0) {
    repaired += stack.pop()
  }

  return repaired
}

async function processPendingFile(projectDir: string, pendingDir: string, fileName: string): Promise<void> {
  if (!fileName.endsWith('.json')) return
  const filePath = join(pendingDir, fileName)
  const db = getContextDb(projectDir)

  try {
    let raw = await readFile(filePath, 'utf-8')
    // Repair common shell-hook issues
    raw = raw.replace(/"input":,/g, '"input":null,')
    raw = raw.replace(/"tool_response":,/g, '"tool_response":null,')

    let data: any // eslint-disable-line @typescript-eslint/no-explicit-any
    try {
      data = JSON.parse(raw)
    } catch {
      // Sanitize bad control characters & escape sequences inside JSON string values,
      // then retry. Shell hooks often embed raw newlines/tabs/backslashes in values.
      const sanitized = raw.replace(
        /("(?:[^"\\]|\\.)*")/g,
        (_match, strLiteral: string) => {
          // Re-escape unescaped control chars (0x00-0x1F) inside the string
          const inner = strLiteral.slice(1, -1)
          const fixed = inner
            .replace(/\\(?!["\\/bfnrtu])/g, '\\\\') // fix bad escape sequences like \x, \a
            .replace(/[\x00-\x1f]/g, (ch) => {       // escape raw control chars
              const hex = ch.charCodeAt(0).toString(16).padStart(4, '0')
              return `\\u${hex}`
            })
          return `"${fixed}"`
        }
      )
      try {
        data = JSON.parse(sanitized)
      } catch {
        // Last resort: try to repair truncated JSON (e.g. from head -c cutting mid-value)
        const repaired = repairTruncatedJson(sanitized)
        data = JSON.parse(repaired) // will throw SyntaxError if still broken
      }
    }

    const toolInput = typeof data.input === 'string' ? data.input : data.input != null ? JSON.stringify(data.input) : undefined
    const toolResponse = typeof data.tool_response === 'string' ? data.tool_response : data.tool_response != null ? JSON.stringify(data.tool_response) : undefined

    await db.insert({
      workspaceId: data.ws,
      agentType: data.agent || 'claude-code',
      sessionId: data.sid || undefined,
      toolName: data.tool || 'unknown',
      toolInput,
      filePath: data.file || undefined,
      projectHead: data.head || undefined,
      eventType: data.event_type || undefined,
      toolResponse,
      timestamp: data.ts,
    })
    await unlink(filePath)

    scheduleContextEntriesUpdated(projectDir, data.ws)

    // Codex tab titles: suggest from first UserPrompt in context when capture lands (OSC often absent).
    if (data.agent === 'codex' && data.ws && data.tool === 'UserPrompt') {
      try {
        console.log('[constellagent:tab-title] pending ingest: codex UserPrompt', {
          workspaceId: data.ws,
          sessionId: data.sid ? `${String(data.sid).slice(0, 16)}…` : null,
        })
        const titleHint = await db.getCodexTabTitleHint(data.ws)
        if (titleHint) {
          const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
          console.log('[constellagent:tab-title] → CONTEXT_CODEX_TAB_TITLE_HINT', {
            workspaceId: data.ws,
            title: titleHint.slice(0, 80),
            windows: wins.length,
          })
          for (const win of wins) {
            win.webContents.send(IPC.CONTEXT_CODEX_TAB_TITLE_HINT, { workspaceId: data.ws, title: titleHint })
          }
        } else {
          console.log('[constellagent:tab-title] context hint empty after UserPrompt ingest', { workspaceId: data.ws })
        }
      } catch (err) {
        console.warn('[constellagent:tab-title] context hint broadcast failed', err)
      }
    }

    // Append to per-workspace and global sliding windows
    const line = formatSlidingWindowLine({
      timestamp: data.ts,
      agentType: data.agent || 'claude-code',
      toolName: data.tool || 'unknown',
      filePath: data.file || null,
      toolInput: toolInput ?? null,
    })

    const contextDir = join(projectDir, '.constellagent', 'context')
    const globalPath = join(contextDir, 'sliding-window.md')
    await appendAndTrimSlidingWindow(globalPath, line)

    if (data.ws) {
      const wsPath = join(contextDir, `sliding-window-${data.ws}.md`)
      await appendAndTrimSlidingWindow(wsPath, line)

      // Schedule rich agent context file generation (debounced)
      scheduleContextFileWrite(projectDir, data.ws)
    }
  } catch (err: any) {
    // ENOENT = file already processed & deleted by a previous indexer tick (race condition) — skip silently
    if (err?.code === 'ENOENT') return
    console.error(`agentfs: failed to process pending file ${fileName}`, err)
    // If the file is corrupt (parse error), delete it so it doesn't retry endlessly
    if (err instanceof SyntaxError) {
      try { await unlink(filePath) } catch { /* already gone */ }
      console.warn(`agentfs: deleted corrupt pending file ${fileName}`)
    }
  }
}

function startPendingIndexer(projectDir: string) {
  if (pendingIndexerWatchers.has(projectDir)) return
  const pendingDir = join(projectDir, '.constellagent', '.pending')

  // Ensure the pending directory exists before watching
  mkdirSync(pendingDir, { recursive: true })

  // Process any existing pending files immediately
  readdir(pendingDir).then(async (files) => {
    for (const file of files) {
      await processPendingFile(projectDir, pendingDir, file)
    }
  }).catch(() => { /* dir may not exist yet */ })

  // Watch for new pending files and process them instantly
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const watcher = watch(pendingDir, (_event, filename) => {
    if (!filename || !filename.endsWith('.json')) return
    // Small debounce to batch rapid writes (e.g. multiple hooks firing at once)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(async () => {
      debounceTimer = null
      try {
        const files = await readdir(pendingDir)
        for (const file of files) {
          await processPendingFile(projectDir, pendingDir, file)
        }
      } catch (err) { console.error('agentfs: pending indexer batch processing failed', err) }
    }, 50)
  })

  pendingIndexerWatchers.set(projectDir, watcher)
}

interface FsWatchSubscriber {
  webContents: WebContents
  refs: number
}

interface FsWatcherEntry {
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
  subscribers: Map<number, FsWatchSubscriber>
  totalRefs: number
}

// Filesystem watchers keyed by watched directory.
// Each renderer subscription increments a ref count so one panel unmounting
// does not tear down a shared watcher used by another panel.
const fsWatchers = new Map<string, FsWatcherEntry>()

function sameWorktreePath(a: string, b: string): boolean {
  if (a === b) return true
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** Repo-relative paths safe for `git restore -- <pathspecs>` (no traversal outside worktree). */
function safeGitRestorePathspecs(projectDir: string, rawPaths: string[]): string[] {
  const root = resolve(projectDir)
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of rawPaths) {
    if (!raw?.trim()) continue
    let s = raw.trim().replaceAll('\\', '/')
    const rootNorm = root.replaceAll('\\', '/')
    if (s.startsWith(rootNorm)) {
      s = s.slice(rootNorm.length).replace(/^\/+/, '')
    }
    const norm = s.replace(/^\/+/, '')
    if (!norm || norm.split('/').includes('..')) continue
    const abs = resolve(root, norm)
    const relToRoot = relative(root, abs).replaceAll('\\', '/')
    if (!relToRoot || relToRoot.startsWith('..')) continue
    if (!seen.has(relToRoot)) {
      seen.add(relToRoot)
      out.push(relToRoot)
    }
  }
  return out
}

interface StateSanitizeResult {
  data: unknown
  changed: boolean
  removedWorkspaceCount: number
}

interface WorkspaceLike {
  id: string
  worktreePath: string
}

interface TabLike {
  id: string
  workspaceId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWorkspaceLike(value: unknown): value is WorkspaceLike {
  return isRecord(value) && typeof value.id === 'string' && typeof value.worktreePath === 'string'
}

function isTabLike(value: unknown): value is TabLike {
  return isRecord(value) && typeof value.id === 'string' && typeof value.workspaceId === 'string'
}

/**
 * macOS often stores `/var/...` while Node/git use `/private/var/...` (or the reverse).
 * A plain existsSync on the persisted string can falsely drop valid workspaces on load.
 */
function resolveWorktreePathIfExists(worktreePath: string): string | null {
  const trimmed = worktreePath.trim()
  if (!trimmed) return null
  const norm = trimmed.replace(/\/+$/, '') || '/'
  const variants = new Set<string>([trimmed, norm])
  if (norm.startsWith('/var/') && !norm.startsWith('/private/')) {
    variants.add('/private' + norm)
  }
  if (norm.startsWith('/private/var/')) {
    const stripped = norm.slice('/private'.length)
    if (stripped) variants.add(stripped)
  }
  for (const v of variants) {
    try {
      if (existsSync(v)) {
        return realpathSync(v)
      }
    } catch {
      // realpathSync can throw on race / permission
    }
  }
  return null
}

function sanitizeLoadedState(data: unknown): StateSanitizeResult {
  if (!isRecord(data)) return { data, changed: false, removedWorkspaceCount: 0 }
  const rawWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : null
  if (!rawWorkspaces) return { data, changed: false, removedWorkspaceCount: 0 }

  const keptWorkspaces: unknown[] = []
  const keptWorkspaceIds = new Set<string>()
  let removedWorkspaceCount = 0
  let pathNormalized = false

  for (const workspace of rawWorkspaces) {
    if (!isWorkspaceLike(workspace)) {
      removedWorkspaceCount += 1
      continue
    }
    const resolved = resolveWorktreePathIfExists(workspace.worktreePath)
    if (!resolved) {
      removedWorkspaceCount += 1
      continue
    }
    keptWorkspaceIds.add(workspace.id)
    if (resolved === workspace.worktreePath) {
      keptWorkspaces.push(workspace)
    } else {
      pathNormalized = true
      keptWorkspaces.push({ ...workspace, worktreePath: resolved })
    }
  }

  if (removedWorkspaceCount === 0 && !pathNormalized) {
    return { data, changed: false, removedWorkspaceCount: 0 }
  }

  const next: Record<string, unknown> = { ...data, workspaces: keptWorkspaces }
  let changed = true

  const rawTabs = Array.isArray(data.tabs) ? data.tabs : null
  const keptTabs = rawTabs
    ? rawTabs.filter((tab) => isTabLike(tab) && keptWorkspaceIds.has(tab.workspaceId))
    : []
  if (rawTabs) next.tabs = keptTabs

  const rawActiveWorkspaceId = typeof data.activeWorkspaceId === 'string' ? data.activeWorkspaceId : null
  let nextActiveWorkspaceId: string | null = null
  if (rawActiveWorkspaceId && keptWorkspaceIds.has(rawActiveWorkspaceId)) {
    nextActiveWorkspaceId = rawActiveWorkspaceId
  } else {
    const firstWorkspace = keptWorkspaces.find(isWorkspaceLike)
    nextActiveWorkspaceId = firstWorkspace?.id ?? null
  }
  if ((data.activeWorkspaceId ?? null) !== nextActiveWorkspaceId) {
    changed = true
  }
  next.activeWorkspaceId = nextActiveWorkspaceId

  const rawActiveTabId = typeof data.activeTabId === 'string' ? data.activeTabId : null
  let nextActiveTabId: string | null = null
  if (rawTabs) {
    const tabIds = new Set<string>()
    for (const tab of keptTabs) {
      if (isTabLike(tab)) tabIds.add(tab.id)
    }
    if (rawActiveTabId && tabIds.has(rawActiveTabId)) {
      nextActiveTabId = rawActiveTabId
    } else if (nextActiveWorkspaceId) {
      const fallback = keptTabs.find(
        (tab) => isTabLike(tab) && tab.workspaceId === nextActiveWorkspaceId
      )
      if (isTabLike(fallback)) nextActiveTabId = fallback.id
    }
  }
  if ((data.activeTabId ?? null) !== nextActiveTabId) {
    changed = true
  }
  next.activeTabId = nextActiveTabId

  if (isRecord(data.lastActiveTabByWorkspace)) {
    const filtered = Object.fromEntries(
      Object.entries(data.lastActiveTabByWorkspace).filter(([workspaceId]) =>
        keptWorkspaceIds.has(workspaceId)
      )
    )
    if (
      Object.keys(filtered).length !==
      Object.keys(data.lastActiveTabByWorkspace).length
    ) {
      changed = true
    }
    next.lastActiveTabByWorkspace = filtered
  }

  return { data: next, changed, removedWorkspaceCount }
}

export function registerIpcHandlers(): void {
  setAnnotationNotify((worktreePath: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.ANNOTATION_CHANGED, { worktreePath })
    }
  })

  // ── Git handlers ──
  ipcMain.handle(IPC.GIT_LIST_WORKTREES, async (_e, repoPath: string) => {
    return GitService.listWorktrees(repoPath)
  })

  ipcMain.handle(IPC.GIT_CREATE_WORKTREE, async (_e, repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean, requestId?: string) => {
    return GitService.createWorktree(
      repoPath,
      name,
      branch,
      newBranch,
      baseBranch,
      force,
      (progress) => {
        const payload: CreateWorktreeProgressEvent = { requestId, ...progress }
        _e.sender.send(IPC.GIT_CREATE_WORKTREE_PROGRESS, payload)
      }
    )
  })

  ipcMain.handle(IPC.GIT_CREATE_WORKTREE_FROM_PR, async (_e, repoPath: string, name: string, prNumber: number, localBranch: string, force?: boolean, requestId?: string) => {
    return GitService.createWorktreeFromPr(
      repoPath,
      name,
      prNumber,
      localBranch,
      force,
      (progress) => {
        const payload: CreateWorktreeProgressEvent = { requestId, ...progress }
        _e.sender.send(IPC.GIT_CREATE_WORKTREE_PROGRESS, payload)
      }
    )
  })

  ipcMain.handle(IPC.GIT_REMOVE_WORKTREE, async (_e, repoPath: string, worktreePath: string) => {
    return GitService.removeWorktree(repoPath, worktreePath)
  })

  ipcMain.handle(IPC.GIT_GET_STATUS, async (_e, worktreePath: string) => {
    return GitService.getStatus(worktreePath)
  })

  ipcMain.handle(IPC.GIT_GET_DIFF, async (_e, worktreePath: string, staged: boolean) => {
    return GitService.getDiff(worktreePath, staged)
  })

  ipcMain.handle(IPC.GIT_GET_FILE_DIFF, async (_e, worktreePath: string, filePath: string) => {
    return GitService.getFileDiff(worktreePath, filePath)
  })

  ipcMain.handle(IPC.GIT_GET_BRANCHES, async (_e, repoPath: string) => {
    return GitService.getBranches(repoPath)
  })

  ipcMain.handle(IPC.GIT_STAGE, async (_e, worktreePath: string, paths: string[]) => {
    return GitService.stage(worktreePath, paths)
  })

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_e, worktreePath: string, paths: string[]) => {
    return GitService.unstage(worktreePath, paths)
  })

  ipcMain.handle(IPC.GIT_DISCARD, async (_e, worktreePath: string, paths: string[], untracked: string[]) => {
    return GitService.discard(worktreePath, paths, untracked)
  })

  ipcMain.handle(IPC.GIT_COMMIT, async (_e, worktreePath: string, message: string) => {
    return GitService.commit(worktreePath, message)
  })

  ipcMain.handle(IPC.GIT_GET_CURRENT_BRANCH, async (_e, worktreePath: string) => {
    return GitService.getCurrentBranch(worktreePath)
  })

  ipcMain.handle(IPC.GIT_GET_DEFAULT_BRANCH, async (_e, repoPath: string) => {
    return GitService.getDefaultBranch(repoPath)
  })

  ipcMain.handle(IPC.GIT_SHOW_FILE_AT_HEAD, async (_e, worktreePath: string, filePath: string) => {
    return GitService.showFileAtHead(worktreePath, filePath)
  })

  ipcMain.handle(IPC.GIT_GET_LOG, async (_e, worktreePath: string, maxCount?: number) => {
    return GitService.getLog(worktreePath, maxCount)
  })

  ipcMain.handle(IPC.GIT_GET_COMMIT_DIFF, async (_e, worktreePath: string, hash: string) => {
    return GitService.getCommitDiff(worktreePath, hash)
  })

  ipcMain.handle(IPC.GIT_GET_REMOTE_HEAD, async (_e, repoPath: string) => {
    return GitService.getRemoteHead(repoPath)
  })

  ipcMain.handle(IPC.GIT_SYNC_ALL_WORKTREES, async (_e, projectId: string) => {
    await worktreeSyncService.syncNow(projectId)
  })

  ipcMain.handle(IPC.GIT_START_SYNC_POLLING, async (_e, projectId: string, repoPath: string) => {
    worktreeSyncService.startPolling(projectId, repoPath)
  })

  ipcMain.handle(IPC.GIT_STOP_SYNC_POLLING, async (_e, projectId: string) => {
    worktreeSyncService.stopPolling(projectId)
  })

  ipcMain.on(IPC.GIT_SYNC_SET_BUSY, (_e, paths: unknown) => {
    if (!Array.isArray(paths)) return
    const strings = paths.filter((p): p is string => typeof p === 'string')
    worktreeSyncService.setBusyWorktrees(strings)
  })

  // ── GitHub handlers ──
  ipcMain.handle(IPC.GITHUB_GET_PR_STATUSES, async (_e, repoPath: string, branches: string[]) => {
    return GithubService.getPrStatuses(repoPath, branches)
  })

  ipcMain.handle(IPC.GITHUB_LIST_OPEN_PRS, async (_e, repoPath: string) => {
    return GithubService.listOpenPrs(repoPath)
  })

  ipcMain.handle(IPC.GITHUB_RESOLVE_PR, async (_e, repoPath: string, prNumber: number, repoSlug?: string) => {
    return GithubService.resolvePr(repoPath, prNumber, repoSlug)
  })

  // ── PTY handlers ──
  ipcMain.handle(IPC.PTY_CREATE, async (_e, workingDir: string, shell?: string, extraEnv?: Record<string, string>) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) throw new Error('No window found')
    return ptyManager.create(workingDir, win.webContents, shell, undefined, undefined, extraEnv)
  })

  ipcMain.on(IPC.PTY_WRITE, (_e, ptyId: string, data: string, opts?: PtyWriteOpts) => {
    ptyManager.write(ptyId, data, opts)
  })

  ipcMain.on(IPC.PTY_SUGGEST_TAB_TITLE, (_e, ptyId: string, line: string) => {
    if (typeof ptyId === 'string' && typeof line === 'string') {
      console.log('[constellagent:tab-title] IPC PTY_SUGGEST_TAB_TITLE', {
        ptyId,
        lineByteLength: Buffer.byteLength(line, 'utf8'),
        linePreview: line.replace(/\r/g, '\\r').replace(/\n/g, '\\n').slice(0, 72),
      })
      ptyManager.suggestTabTitle(ptyId, line)
    }
  })

  ipcMain.on(IPC.PTY_RESIZE, (_e, ptyId: string, cols: number, rows: number) => {
    ptyManager.resize(ptyId, cols, rows)
  })

  ipcMain.on(IPC.PTY_DESTROY, (_e, ptyId: string) => {
    ptyManager.destroy(ptyId)
  })

  ipcMain.handle(IPC.PTY_LIST, async () => {
    return ptyManager.list()
  })

  ipcMain.handle(IPC.PTY_REATTACH, async (_e, ptyId: string) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) throw new Error('No window found')
    return ptyManager.reattach(ptyId, win.webContents)
  })

  // ── File handlers ──
  ipcMain.handle(IPC.FS_GET_TREE, async (_e, dirPath: string) => {
    return FileService.getTree(dirPath)
  })

  ipcMain.handle(IPC.FS_GET_TREE_WITH_STATUS, async (_e, dirPath: string) => {
    const [tree, statuses, topLevel] = await Promise.all([
      FileService.getTree(dirPath),
      GitService.getStatus(dirPath).catch(() => []),
      GitService.getTopLevel(dirPath).catch(() => dirPath),
    ])

    // git status --porcelain paths are relative to repo root, but
    // git ls-files paths (used for the tree) are relative to cwd (dirPath).
    // Compute prefix to convert between them.
    const prefix = relative(topLevel, dirPath) // e.g. 'desktop' or ''

    // Build map: dirPath-relative path → git status
    const statusMap = new Map<string, string>()
    for (const s of statuses) {
      let p = s.path
      // Handle renamed files: "old -> new" — use the new path
      if (p.includes(' -> ')) {
        p = p.split(' -> ')[1]
      }
      // Strip repo-root prefix to get dirPath-relative path
      if (prefix && p.startsWith(prefix + '/')) {
        p = p.slice(prefix.length + 1)
      }
      statusMap.set(p, s.status)
    }

    // Attach gitStatus to nodes, propagate to parent dirs
    function annotate(nodes: FileNode[]): boolean {
      let hasStatus = false
      for (const node of nodes) {
        // Compute relative path from dirPath
        const rel = node.path.startsWith(dirPath)
          ? node.path.slice(dirPath.length + 1)
          : node.path

        if (node.type === 'file') {
          const st = statusMap.get(rel)
          if (st) {
            node.gitStatus = st as FileNode['gitStatus']
            hasStatus = true
          }
        } else if (node.children) {
          const childHasStatus = annotate(node.children)
          if (childHasStatus) {
            node.gitStatus = 'modified'
            hasStatus = true
          }
        }
      }
      return hasStatus
    }

    annotate(tree)
    return tree
  })

  ipcMain.handle(IPC.FS_READ_FILE, async (_e, filePath: string) => {
    try {
      return await FileService.readFile(filePath)
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return null
      }
      throw err
    }
  })

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_e, filePath: string, content: string) => {
    return FileService.writeFile(filePath, content)
  })

  ipcMain.handle(IPC.FS_DELETE_FILE, async (_e, filePath: string) => {
    return FileService.deleteFile(filePath)
  })

  ipcMain.handle(IPC.FS_FIND_NEWEST_PLAN, async (_e, worktreePath: string) => {
    return FileService.findNewestPlanMarkdown(worktreePath)
  })

  ipcMain.handle(IPC.FS_LIST_AGENT_PLANS, async (_e, worktreePath: string | string[]) => {
    return FileService.listAgentPlanMarkdowns(worktreePath)
  })

  ipcMain.handle(IPC.FS_READ_PLAN_META, async (_e, filePath: string) => {
    return readPlanMeta(filePath)
  })

  ipcMain.handle(IPC.FS_UPDATE_PLAN_META, async (_e, filePath: string, patch: { built?: boolean; codingAgent?: string | null; buildHarness?: PlanAgent | null }) => {
    return FileService.updatePlanMeta(filePath, patch)
  })

  ipcMain.handle(IPC.FS_RELOCATE_AGENT_PLAN, async (_e, worktreePath: string, filePath: string, targetAgent: string, mode: string) => {
    return FileService.relocateAgentPlan(worktreePath, filePath, targetAgent as any, mode as any)
  })

  // ── Filesystem watcher handlers ──
  ipcMain.handle(IPC.FS_WATCH_START, (_e, dirPath: string) => {
    const senderId = _e.sender.id
    const existing = fsWatchers.get(dirPath)
    if (existing) {
      const subscriber = existing.subscribers.get(senderId)
      if (subscriber) {
        subscriber.refs += 1
      } else {
        existing.subscribers.set(senderId, { webContents: _e.sender, refs: 1 })
      }
      existing.totalRefs += 1
      return
    }

    try {
      const watcher = watch(dirPath, { recursive: true }, (_eventType, filename) => {
        // For .git/ changes, only notify on meaningful state changes (commit, stage, branch switch)
        // Ignore noisy internals like objects/, logs/, COMMIT_EDITMSG
        if (filename && (filename.startsWith('.git/') || filename.startsWith('.git\\'))) {
          const f = filename.replaceAll('\\', '/')
          const isStateChange =
            f === '.git/index' || f === '.git/HEAD' || f.startsWith('.git/refs/')
          if (!isStateChange) return
        }

        const entry = fsWatchers.get(dirPath)
        if (!entry) return

        // Debounce: wait 500ms of quiet before notifying
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          for (const [id, subscriber] of entry.subscribers.entries()) {
            if (subscriber.webContents.isDestroyed()) {
              entry.totalRefs = Math.max(0, entry.totalRefs - subscriber.refs)
              entry.subscribers.delete(id)
              continue
            }
            subscriber.webContents.send(IPC.FS_WATCH_CHANGED, dirPath)
          }

          if (entry.totalRefs <= 0 || entry.subscribers.size === 0) {
            if (entry.timer) clearTimeout(entry.timer)
            entry.watcher.close()
            fsWatchers.delete(dirPath)
          }
        }, 500)
      })

      fsWatchers.set(dirPath, {
        watcher,
        timer: null,
        subscribers: new Map([[senderId, { webContents: _e.sender, refs: 1 }]]),
        totalRefs: 1,
      })
    } catch {
      // Directory may not exist or be inaccessible — ignore
    }
  })

  ipcMain.on(IPC.FS_WATCH_STOP, (_e, dirPath: string) => {
    const entry = fsWatchers.get(dirPath)
    if (!entry) return

    const senderId = _e.sender.id
    const subscriber = entry.subscribers.get(senderId)
    if (subscriber) {
      subscriber.refs -= 1
      entry.totalRefs = Math.max(0, entry.totalRefs - 1)
      if (subscriber.refs <= 0) {
        entry.subscribers.delete(senderId)
      }
    } else {
      entry.totalRefs = Math.max(0, entry.totalRefs - 1)
    }

    if (entry.totalRefs <= 0 || entry.subscribers.size === 0) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.watcher.close()
      fsWatchers.delete(dirPath)
    }
  })

  // ── App handlers ──
  ipcMain.handle(IPC.APP_SELECT_DIRECTORY, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select Repository',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.APP_GET_HOME_DIR, () => homedir())

  // Accepts a path directly (for testing — avoids dialog.showOpenDialog)
  ipcMain.handle(IPC.APP_ADD_PROJECT_PATH, async (_e, dirPath: string) => {
    const { stat } = await import('fs/promises')
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) return null
      return dirPath
    } catch {
      return null
    }
  })

  // ── Open in external editor ──
  const execFileAsync = promisify(execFile)

  ipcMain.handle(IPC.APP_OPEN_IN_EDITOR, async (_e, dirPath: string, cliCommand: string) => {
    try {
      await execFileAsync(cliCommand, [dirPath])
      return { success: true }
    } catch (err) {
      const msg = (err as ExecFileException).message || `Failed to open ${cliCommand}`
      return { success: false, error: msg }
    }
  })

  // ── Claude Code trust ──
  ipcMain.handle(IPC.CLAUDE_TRUST_PATH, async (_e, dirPath: string) => {
    await trustPathForClaude(dirPath)
  })

  // ── Claude Code hooks ──
  function getHookScriptPath(name: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'claude-hooks', name)
    }
    return join(__dirname, '..', '..', 'claude-hooks', name)
  }

  function getCodexHookScriptPath(name: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'codex-hooks', name)
    }
    return join(__dirname, '..', '..', 'codex-hooks', name)
  }

  function getAgentHookPath(name: string): string {
    if (app.isPackaged) {
      return join(process.resourcesPath, 'agent-hooks', name)
    }
    return join(__dirname, '..', '..', 'agent-hooks', name)
  }

  // Stable identifiers to match our hook entries regardless of full path
  const HOOK_IDENTIFIERS = [
    'claude-hooks/notify.sh',
    'claude-hooks/activity.sh',
    'claude-hooks/context-capture.sh',
    'claude-hooks/context-inject.sh',
    'claude-hooks/session-save.sh',
    'agent-hooks/claude-capture.sh',
    'agent-hooks/gemini-capture.sh',
    'agent-hooks/cursor-capture.sh',
    'agent-hooks/codex-capture.sh',
    'codex-hooks/codex-combined.sh',
  ]

  function shellQuoteArg(value: string): string {
    // Claude executes hook commands via /bin/sh; paths can contain spaces.
    return `'${value.replace(/'/g, `'\"'\"'`)}'`
  }

  function isOurHook(rule: { hooks?: Array<{ command?: string }> }): boolean {
    return !!rule.hooks?.some((h) => HOOK_IDENTIFIERS.some((id) => h.command?.includes(id)))
  }

  ipcMain.handle(IPC.CLAUDE_CHECK_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const hooks = settings.hooks as Record<string, unknown[]> | undefined
    if (!hooks) return { installed: false }

    const hasStop = (hooks.Stop as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasNotification = (hooks.Notification as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasPromptSubmit = (hooks.UserPromptSubmit as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasPostToolUse = (hooks.PostToolUse as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasSessionStart = (hooks.SessionStart as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    // Context capture hooks should be on PostToolUse, UserPromptSubmit, Stop, and SessionStart
    const contextCaptureId = 'claude-hooks/context-capture.sh'
    const agentCaptureId = 'agent-hooks/claude-capture.sh'
    const hasCapture = (h?: { command?: string }) => h?.command?.includes(contextCaptureId) || h?.command?.includes(agentCaptureId)
    const stopHasCapture = (hooks.Stop as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(
      (rule) => rule.hooks?.some(hasCapture)
    )
    const promptHasCapture = (hooks.UserPromptSubmit as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(
      (rule) => rule.hooks?.some(hasCapture)
    )
    return {
      installed: !!(hasStop && hasNotification && hasPromptSubmit),
      contextHooksInstalled: !!(hasPostToolUse && hasSessionStart && stopHasCapture && promptHasCapture),
    }
  })

  ipcMain.handle(IPC.CLAUDE_INSTALL_HOOKS, async (_e, contextEnabled: boolean) => {
    const settings = await loadClaudeSettings()
    const notifyPath = getHookScriptPath('notify.sh')
    const activityPath = getHookScriptPath('activity.sh')
    const contextCapturePath = getAgentHookPath('claude-capture.sh')
    const contextInjectPath = getHookScriptPath('context-inject.sh')
    const sessionSavePath = getHookScriptPath('session-save.sh')

    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>

    // Helper: strip all our hooks from an event, then add the specified ones
    function setHooks(event: string, entries: Array<{ scriptPath: string; matcher?: string }>) {
      const rules = (hooks[event] ?? []) as Array<Record<string, unknown>>
      const filtered = rules.filter((rule) => !isOurHook(rule as { hooks?: Array<{ command?: string }> }))
      for (const entry of entries) {
        filtered.push({ matcher: entry.matcher ?? '', hooks: [{ type: 'command', command: shellQuoteArg(entry.scriptPath) }] })
      }
      hooks[event] = filtered
      if (filtered.length === 0) delete hooks[event]
    }

    setHooks('Notification', [{ scriptPath: notifyPath }])

    // Context hooks gated on setting
    if (contextEnabled) {
      setHooks('Stop', [{ scriptPath: notifyPath }, { scriptPath: sessionSavePath }, { scriptPath: contextCapturePath }])
      setHooks('UserPromptSubmit', [{ scriptPath: activityPath }, { scriptPath: contextCapturePath }, { scriptPath: contextInjectPath }])
      setHooks('PostToolUse', [{ scriptPath: contextCapturePath, matcher: '' }])
      setHooks('SessionStart', [{ scriptPath: contextInjectPath }, { scriptPath: contextCapturePath }])
      setHooks('SessionEnd', [{ scriptPath: contextCapturePath }])
      setHooks('PreToolUse', [{ scriptPath: contextCapturePath }])
      setHooks('PostToolUseFailure', [{ scriptPath: contextCapturePath }])
      setHooks('SubagentStart', [{ scriptPath: contextCapturePath }])
      setHooks('SubagentStop', [{ scriptPath: contextCapturePath }])
    } else {
      setHooks('Stop', [{ scriptPath: notifyPath }, { scriptPath: sessionSavePath }])
      setHooks('UserPromptSubmit', [{ scriptPath: activityPath }])
      setHooks('PostToolUse', [])
      setHooks('SessionStart', [])
      setHooks('SessionEnd', [])
      setHooks('PreToolUse', [])
      setHooks('PostToolUseFailure', [])
      setHooks('SubagentStart', [])
      setHooks('SubagentStop', [])
    }

    settings.hooks = hooks

    await saveClaudeSettings(settings)
    return { success: true }
  })

  ipcMain.handle(IPC.CLAUDE_UNINSTALL_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const hooks = settings.hooks as Record<string, unknown[]> | undefined
    if (!hooks) return { success: true }

    function removeHook(event: string) {
      const rules = (hooks![event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>
      hooks![event] = rules.filter((rule) => !isOurHook(rule))
      if ((hooks![event] as unknown[]).length === 0) delete hooks![event]
    }

    removeHook('Stop')
    removeHook('Notification')
    removeHook('UserPromptSubmit')
    removeHook('PostToolUse')
    removeHook('SessionStart')
    removeHook('SessionEnd')
    removeHook('PreToolUse')
    removeHook('PostToolUseFailure')
    removeHook('SubagentStart')
    removeHook('SubagentStop')

    if (Object.keys(hooks).length === 0) delete settings.hooks
    await saveClaudeSettings(settings)
    return { success: true }
  })

  // ── Context repository handlers ──
  const execFileAsyncCtx = promisify(execFile)

  /** Remove refs/constellagent-cp/* older than 7 days (ref name starts with unix ts). */
  async function pruneCheckpointRefs(projectDir: string): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
    const gitOpts = { cwd: projectDir, encoding: 'utf8' as const }
    try {
      const { stdout } = await execFileAsyncCtx('git', ['for-each-ref', '--format=%(refname)', 'refs/constellagent-cp/'], gitOpts)
      for (const ref of stdout.trim().split('\n').filter(Boolean)) {
        const base = ref.replace(/^refs\/constellagent-cp\//, '')
        const tsStr = base.split('-')[0] ?? ''
        const ts = parseInt(tsStr, 10)
        if (!Number.isFinite(ts) || ts >= cutoff) continue
        await execFileAsyncCtx('git', ['update-ref', '-d', ref], gitOpts).catch(() => {})
      }
    } catch {
      /* not a git repo or no refs namespace */
    }
  }

  ipcMain.handle(IPC.CONTEXT_REPO_INIT, async (_e, projectDir: string, wsId: string) => {
    const repoDir = join(projectDir, '.constellagent')
    const gitExists = existsSync(join(repoDir, '.git'))

    if (!gitExists) {
      await mkdir(join(repoDir, 'context'), { recursive: true })
      await mkdir(join(repoDir, 'sessions'), { recursive: true })
      await mkdir(join(repoDir, 'meta'), { recursive: true })

      await writeFile(join(repoDir, 'README.md'), '# Agent Context Repository\n\nAuto-managed by Constellagent.\n')
      await writeFile(join(repoDir, 'context', 'activity.md'), '# Recent Activity\n')
      await writeFile(join(repoDir, 'context', 'files-touched.md'), '# Files Touched\n')
      await writeFile(join(repoDir, 'meta', 'workspace.json'), JSON.stringify({ wsId, createdAt: new Date().toISOString() }, null, 2))

      await execFileAsyncCtx('git', ['init'], { cwd: repoDir })
      await execFileAsyncCtx('git', ['add', '-A'], { cwd: repoDir })
      await execFileAsyncCtx('git', ['-c', 'user.name=Constellagent', '-c', 'user.email=noreply@constellagent', 'commit', '--no-gpg-sign', '-m', 'init: context repository'], { cwd: repoDir })

      // Add .constellagent/ to project .gitignore
      const gitignorePath = join(projectDir, '.gitignore')
      const gitignore = existsSync(gitignorePath) ? await readFile(gitignorePath, 'utf-8') : ''
      if (!gitignore.includes('.constellagent')) {
        await writeFile(gitignorePath, gitignore.trimEnd() + '\n.constellagent/\n')
      }
    }

    // Initialize context database for this project (lazy AgentFS init via ContextDb)
    getContextDb(projectDir)
    startPendingIndexer(projectDir)

    if (existsSync(join(projectDir, '.git'))) {
      await pruneCheckpointRefs(projectDir)
    }

    // Auto-configure agent hooks for context capture
    const geminiCaptureScript = getAgentHookPath('gemini-capture.sh')
    const cursorCaptureScript = getAgentHookPath('cursor-capture.sh')

    // Gemini hooks: write .gemini/settings.json in project dir
    const geminiDir = join(projectDir, '.gemini')
    const geminiSettingsPath = join(geminiDir, 'settings.json')
    try {
      if (!existsSync(geminiSettingsPath)) {
        await mkdir(geminiDir, { recursive: true })
      }
      const geminiSettings = existsSync(geminiSettingsPath)
        ? JSON.parse(await readFile(geminiSettingsPath, 'utf-8'))
        : {}
      if (!geminiSettings.hooks) {
        const quotedGemini = shellQuoteArg(geminiCaptureScript)
        geminiSettings.hooks = {
          AfterTool: [{ matcher: '.*', hooks: [{ type: 'command', command: quotedGemini }] }],
          BeforeAgent: [{ matcher: '*', hooks: [{ type: 'command', command: quotedGemini }] }],
          AfterAgent: [{ matcher: '*', hooks: [{ type: 'command', command: quotedGemini }] }],
          SessionStart: [{ matcher: '*', hooks: [{ type: 'command', command: quotedGemini }] }],
          SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: quotedGemini }] }],
        }
        await writeFile(geminiSettingsPath, JSON.stringify(geminiSettings, null, 2))
      }
    } catch (err) { console.error('agentfs: Gemini hooks setup failed', err) }

    // Cursor hooks: write .cursor/hooks.json in project dir (all 14 hooks)
    const cursorDir = join(projectDir, '.cursor')
    const cursorHooksPath = join(cursorDir, 'hooks.json')
    try {
      if (!existsSync(cursorHooksPath)) {
        await mkdir(cursorDir, { recursive: true })
      }
      const cursorHooks = existsSync(cursorHooksPath)
        ? JSON.parse(await readFile(cursorHooksPath, 'utf-8'))
        : {}
      if (!cursorHooks.hooks) {
        const quotedCursor = shellQuoteArg(cursorCaptureScript)
        const hookEntry = [{ command: quotedCursor }]
        cursorHooks.version = 1
        cursorHooks.hooks = {
          beforeSubmitPrompt: hookEntry,
          afterFileEdit: hookEntry,
          beforeShellExecution: hookEntry,
          afterShellExecution: hookEntry,
          beforeReadFile: hookEntry,
          beforeMCPExecution: hookEntry,
          afterMCPExecution: hookEntry,
          sessionStart: hookEntry,
          sessionEnd: hookEntry,
          preToolUse: hookEntry,
          postToolUse: hookEntry,
          subagentStop: hookEntry,
          preCompact: hookEntry,
          stop: hookEntry,
        }
        await writeFile(cursorHooksPath, JSON.stringify(cursorHooks, null, 2))
      }
    } catch (err) { console.error('agentfs: Cursor hooks setup failed', err) }

    // Codex auto-configuration: add notify+capture to ~/.codex/config.toml
    try {
      const codexConfig = await loadCodexConfigText()
      if (!hasOurCodexNotify(codexConfig)) {
        const codexScriptName = 'codex-combined.sh'
        const codexNotifyPath = getCodexHookScriptPath(codexScriptName)
        const codexNotifyLine = `notify = ["${tomlEscape(codexNotifyPath)}"]`
        let updatedConfig = stripNotifyAssignments(codexConfig)
        updatedConfig = insertTopLevelNotify(updatedConfig, codexNotifyLine)
        await saveCodexConfigText(updatedConfig)
      }
    } catch (err) { console.error('agentfs: Codex notify setup failed', err) }

    // Discovery files: let Codex and Cursor find the sliding window
    try {
      // .codex/AGENTS.md — project-scoped instruction for Codex
      const codexProjectDir = join(projectDir, '.codex')
      const codexAgentsPath = join(codexProjectDir, 'AGENTS.md')
      await mkdir(codexProjectDir, { recursive: true })
      await writeFile(codexAgentsPath, `# Constellagent Cross-Agent Context

## Session & Activity Context
Read these files to see what other agents (and you) have been doing recently:
- \`.constellagent/context/sliding-window.md\` — Compact table of last 20 agent actions across all agents
- \`.constellagent/context/agent-context.md\` — Rich context summary (files touched, tool details, activity timeline)
- \`.constellagent/sessions/\` — Session-end summaries with timestamps

## Cachebro (MCP — auto-configured)
Cachebro is pre-configured via \`npx cachebro init\`. Use the cachebro MCP tools (\`read_file\`, \`read_files\`, \`cache_status\`, \`cache_clear\`) instead of raw file reads to save tokens.

## Context Database
Agent tool calls and activity are recorded in \`.constellagent/constellagent.db\` (libSQL/SQLite via AgentFS).
The \`entries\` table stores: workspace_id, agent_type, session_id, tool_name, tool_input, file_path, tool_response, timestamp.
`)

      // .gemini/AGENTS.md — project-scoped instruction for Gemini
      const geminiAgentsPath = join(projectDir, '.gemini', 'AGENTS.md')
      await mkdir(join(projectDir, '.gemini'), { recursive: true })
      await writeFile(geminiAgentsPath, `# Constellagent Cross-Agent Context

## Session & Activity Context
Read these files to see what other agents (and you) have been doing recently:
- \`.constellagent/context/sliding-window.md\` — Compact table of last 20 agent actions across all agents
- \`.constellagent/context/agent-context.md\` — Rich context summary (files touched, tool details, activity timeline)
- \`.constellagent/sessions/\` — Session-end summaries with timestamps

## Cachebro (MCP — auto-configured)
Cachebro is pre-configured via \`npx cachebro init\`. Use the cachebro MCP tools (\`read_file\`, \`read_files\`, \`cache_status\`, \`cache_clear\`) instead of raw file reads to save tokens.

## Context Database
Agent tool calls and activity are recorded in \`.constellagent/constellagent.db\` (libSQL/SQLite via AgentFS).
The \`entries\` table stores: workspace_id, agent_type, session_id, tool_name, tool_input, file_path, tool_response, timestamp.
`)

      // CLAUDE.md — project-scoped instruction for Claude Code
      const claudeMdPath = join(projectDir, 'CLAUDE.md')
      await writeFile(claudeMdPath, `# Constellagent Cross-Agent Context

## Session & Activity Context
Read these files to see what other agents (and you) have been doing recently:
- \`.constellagent/context/sliding-window.md\` — Compact table of last 20 agent actions across all agents
- \`.constellagent/context/agent-context.md\` — Rich context summary (files touched, tool details, activity timeline)
- \`.constellagent/sessions/\` — Session-end summaries with timestamps

## Cachebro (MCP — auto-configured)
Cachebro is pre-configured via \`npx cachebro init\`. Use the cachebro MCP tools (\`read_file\`, \`read_files\`, \`cache_status\`, \`cache_clear\`) instead of raw file reads to save tokens.

## Context Database
Agent tool calls and activity are recorded in \`.constellagent/constellagent.db\` (libSQL/SQLite via AgentFS).
The \`entries\` table stores: workspace_id, agent_type, session_id, tool_name, tool_input, file_path, tool_response, timestamp.
`)

      // .cursor/rules/constellagent.mdc — project-scoped instruction for Cursor
      const cursorRulesDir = join(projectDir, '.cursor', 'rules')
      const cursorRulePath = join(cursorRulesDir, 'constellagent.mdc')
      await mkdir(cursorRulesDir, { recursive: true })
      await writeFile(cursorRulePath, `---
description: Cross-agent context and tools from Constellagent
alwaysApply: true
---

## Session & Activity Context
Read these files to see what other agents (and you) have been doing recently:
- \`.constellagent/context/sliding-window.md\` — Compact table of last 20 agent actions across all agents
- \`.constellagent/context/agent-context.md\` — Rich context summary (files touched, tool details, activity timeline)
- \`.constellagent/sessions/\` — Session-end summaries with timestamps

## Cachebro (MCP — auto-configured)
Cachebro is pre-configured via \`npx cachebro init\`. Use the cachebro MCP tools (\`read_file\`, \`read_files\`, \`cache_status\`, \`cache_clear\`) instead of raw file reads to save tokens.
`)
    } catch (err) { console.error('agentfs: discovery files setup failed', err) }

    return { success: true }
  })

  ipcMain.handle(IPC.CONTEXT_INSERT, async (_e, projectDir: string, entry: {
    workspaceId: string; sessionId?: string; toolName: string;
    toolInput?: string; filePath?: string; timestamp: string
  }) => {
    await getContextDb(projectDir).insert(entry)
    return { success: true }
  })

  ipcMain.handle(IPC.CONTEXT_SEARCH, async (_e, projectDir: string, query: string, limit?: number) => {
    startPendingIndexer(projectDir)
    return await getContextDb(projectDir).search(query, limit)
  })

  ipcMain.handle(IPC.CONTEXT_GET_RECENT, async (_e, projectDir: string, workspaceId: string, limit?: number) => {
    startPendingIndexer(projectDir)
    return await getContextDb(projectDir).getRecent(workspaceId, limit)
  })

  ipcMain.handle(
    IPC.CONTEXT_RESTORE_CHECKPOINT,
    async (_e, projectDir: string, commitHash: string, relativePaths?: string[]) => {
    const logPrefix = '[constellagent:restore-checkpoint]'
    const short = (h: string) => (h.length > 14 ? `${h.slice(0, 7)}…${h.slice(-6)}` : h)
    const gitOpts = { cwd: projectDir, encoding: 'utf8' as const }
    let verified = false
    const requestedScoped = Array.isArray(relativePaths) && relativePaths.length > 0
    const pathspecs = requestedScoped ? safeGitRestorePathspecs(projectDir, relativePaths) : []
    if (requestedScoped && pathspecs.length === 0) {
      throw new Error('Could not resolve any valid file paths to restore')
    }
    const scoped = pathspecs.length > 0
    console.log(logPrefix, 'start', {
      projectDir,
      object: short(commitHash),
      mode: scoped ? 'scoped' : 'full',
      pathspecs: scoped ? pathspecs : undefined,
    })
    try {
      const { stdout: objTypeRaw } = await execFileAsyncCtx('git', ['cat-file', '-t', commitHash], gitOpts)
      const objType = objTypeRaw.trim()
      if (objType === 'blob') {
        throw new Error('Checkpoint object is a blob, not a tree or commit')
      }

      let treeHash: string
      if (objType === 'tree') {
        treeHash = commitHash
      } else if (objType === 'commit' || objType === 'tag') {
        const { stdout } = await execFileAsyncCtx('git', ['rev-parse', `${commitHash}^{tree}`], gitOpts)
        treeHash = stdout.trim()
      } else {
        throw new Error(`Unsupported git object type: ${objType}`)
      }

      console.log(logPrefix, 'resolved', { objType, tree: short(treeHash) })

      if (scoped) {
        // Determine which paths exist in the checkpoint tree vs which are absent.
        const { stdout: lsOut } = await execFileAsyncCtx(
          'git',
          ['ls-tree', '-r', '--name-only', treeHash, '--', ...pathspecs],
          gitOpts,
        )
        const inTree = new Set(lsOut.split('\n').map((l) => l.trim()).filter(Boolean))
        const restorePaths = pathspecs.filter((p) => inTree.has(p))
        const removePaths = pathspecs.filter((p) => !inTree.has(p))

        if (restorePaths.length > 0) {
          await execFileAsyncCtx(
            'git',
            ['restore', '--source', treeHash, '--staged', '--worktree', '--', ...restorePaths],
            gitOpts,
          )
          console.log(logPrefix, 'restore fromTree', { paths: restorePaths })
        }

        for (const p of removePaths) {
          const absPath = join(projectDir, p)
          // Remove from index if staged/tracked (ignore errors if not in index)
          await execFileAsyncCtx('git', ['rm', '--cached', '-f', '--ignore-unmatch', '--', p], gitOpts)
            .catch(() => {})
          // Remove from worktree
          await unlink(absPath).catch(() => {})
          console.log(logPrefix, 'removedAbsentFromTree', { path: p })
        }

        // Verify: in-tree paths match tree; absent paths gone from disk and index
        let scopeOk = true
        if (restorePaths.length > 0) {
          const { stdout: diffOut } = await execFileAsyncCtx(
            'git',
            ['diff', '--no-ext-diff', treeHash, '--', ...restorePaths],
            gitOpts,
          )
          if (diffOut.trim() !== '') scopeOk = false
        }
        for (const p of removePaths) {
          if (existsSync(join(projectDir, p))) { scopeOk = false; break }
          const { stdout: lsStaged } = await execFileAsyncCtx(
            'git', ['ls-files', '--stage', '--', p], gitOpts,
          )
          if (lsStaged.trim() !== '') { scopeOk = false; break }
        }
        verified = scopeOk
      } else {
        // Full tree: `git restore` matches the checkpoint; `git clean` drops other untracked files.
        await execFileAsyncCtx(
          'git',
          ['restore', '--source', treeHash, '--staged', '--worktree', '.'],
          gitOpts,
        )
        console.log(logPrefix, 'restore --staged --worktree . done')
        await execFileAsyncCtx('git', ['clean', '-fd', '-e', '.constellagent'], gitOpts)
        console.log(logPrefix, 'clean -fd done (excluded .constellagent)')

        const tmpVerify = join(tmpdir(), `csg-verify-${Date.now()}-${Math.random().toString(16).slice(2)}`)
        let currentTreeTrimmed = ''
        try {
          await execFileAsyncCtx('git', ['add', '-A'], {
            ...gitOpts,
            env: { ...process.env, GIT_INDEX_FILE: tmpVerify },
          })
          const { stdout: currentTree } = await execFileAsyncCtx('git', ['write-tree'], {
            ...gitOpts,
            env: { ...process.env, GIT_INDEX_FILE: tmpVerify },
          })
          currentTreeTrimmed = currentTree.trim()
          verified = currentTreeTrimmed === treeHash
        } finally {
          await unlink(tmpVerify).catch(() => {})
        }

        console.log(logPrefix, 'verify', {
          verified,
          expectedTree: short(treeHash),
          worktreeTree: short(currentTreeTrimmed),
        })
      }

      if (scoped) {
        console.log(logPrefix, 'verify', { verified, scopedPaths: pathspecs })
      }

      let notifyCount = 0
      for (const [dir, entry] of fsWatchers.entries()) {
        if (!sameWorktreePath(dir, projectDir)) continue
        for (const [, sub] of entry.subscribers) {
          if (!sub.webContents.isDestroyed()) {
            // Use watcher key so renderer `changedDir === worktreePath` matches what watchDir used
            sub.webContents.send(IPC.FS_WATCH_CHANGED, dir)
            notifyCount += 1
          }
        }
      }
      console.log(logPrefix, 'fs-watch notify', { projectDir, subscriberSends: notifyCount })

      console.log(logPrefix, 'ok', { verified })
      return { success: true, verified }
    } catch (err: unknown) {
      const ex = err as ExecFileException & { stderr?: string }
      const msg = (typeof ex.stderr === 'string' ? ex.stderr.trim() : '') || ex?.message || 'Unknown git error'
      console.error(logPrefix, 'failed', { projectDir, object: short(commitHash), message: msg })
      throw new Error(`Failed to restore checkpoint: ${msg}`)
    }
  })

  ipcMain.handle(IPC.CONTEXT_BUILD_SUMMARY, async (_e, projectDir: string, workspaceId: string) => {
    const db = getContextDb(projectDir)
    const contextDir = join(projectDir, '.constellagent', 'context')
    await mkdir(contextDir, { recursive: true })

    // Build and write per-workspace rich context
    const wsContext = await db.buildAgentContext(workspaceId)
    await writeFile(join(contextDir, `agent-context-${workspaceId}.md`), wsContext)

    // Build and write global context
    const globalContext = await db.buildGlobalContext()
    await writeFile(join(contextDir, 'agent-context.md'), globalContext)

    return { success: true, wsContext, globalContext }
  })

  // ── WAL checkpoint ──
  ipcMain.handle(IPC.CONTEXT_WAL_CHECKPOINT, async (_e, projectDir?: string) => {
    if (projectDir) {
      await checkpoint(projectDir)
    } else {
      await checkpointAll()
    }
    return { success: true }
  })

  // ── Session context ──
  ipcMain.handle(IPC.CONTEXT_SESSION_CONTEXT, async (_e, projectDir: string, sessionId: string, limit?: number) => {
    return await getContextDb(projectDir).getSessionContext(sessionId, limit)
  })

  ipcMain.handle(IPC.CONTEXT_SESSION_META_SAVE, async (_e, projectDir: string, wsId: string, meta: {
    sessionId: string; agentType: string; startedAt: string; summary?: string
  }) => {
    await getContextDb(projectDir).saveSessionMeta(wsId, meta)
    return { success: true }
  })

  ipcMain.handle(IPC.CONTEXT_SESSION_META_GET, async (_e, projectDir: string, wsId: string, agentType?: string) => {
    return await getContextDb(projectDir).getSessionMeta(wsId, agentType)
  })

  // ── Session resume ──
  ipcMain.handle(IPC.SESSION_GET_LAST, async (_e, workspaceId: string, agentType: string) => {
    const sessionDir = join(tmpdir(), 'constellagent-sessions')
    const filePath = join(sessionDir, `${workspaceId}.${agentType}`)
    try {
      const { readFile } = await import('fs/promises')
      return (await readFile(filePath, 'utf-8')).trim() || null
    } catch { return null }
  })

  // ── Codex notify hook ──
  const CODEX_NOTIFY_IDENTIFIER = 'codex-hooks/notify.sh'
  const CODEX_NOTIFY_CAPTURE_IDENTIFIER = 'codex-hooks/codex-combined.sh'
  const TABLE_HEADER_RE = /^\s*\[[^\n]+\]\s*$/m
  const NOTIFY_ASSIGNMENT_RE = /^\s*notify\s*=/

  function tomlEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function firstTableHeaderIndex(configText: string): number {
    const match = configText.match(TABLE_HEADER_RE)
    return match?.index ?? -1
  }

  function topLevelSection(configText: string): string {
    const firstTableIndex = firstTableHeaderIndex(configText)
    return firstTableIndex === -1 ? configText : configText.slice(0, firstTableIndex)
  }

  function hasOurCodexNotify(configText: string): boolean {
    const top = topLevelSection(configText)
    return top.includes(CODEX_NOTIFY_IDENTIFIER) || top.includes(CODEX_NOTIFY_CAPTURE_IDENTIFIER)
  }

  function hasOurCodexCapture(configText: string): boolean {
    return topLevelSection(configText).includes(CODEX_NOTIFY_CAPTURE_IDENTIFIER)
  }

  function stripNotifyAssignments(configText: string, shouldStrip: (assignment: string) => boolean = () => true): string {
    const lines = configText.split('\n')
    const kept: string[] = []
    let i = 0

    while (i < lines.length) {
      const line = lines[i]
      if (!NOTIFY_ASSIGNMENT_RE.test(line)) {
        kept.push(line)
        i += 1
        continue
      }

      let end = i
      const startsArray = line.includes('[')
      const endsArray = line.includes(']')
      if (startsArray && !endsArray) {
        let j = i + 1
        while (j < lines.length) {
          end = j
          if (lines[j].includes(']')) break
          j += 1
        }
      }

      const assignment = lines.slice(i, end + 1).join('\n')
      if (!shouldStrip(assignment)) {
        kept.push(...lines.slice(i, end + 1))
      }
      i = end + 1
    }

    return kept.join('\n')
  }

  function insertTopLevelNotify(configText: string, notifyLine: string): string {
    const withoutNotify = configText.trimEnd()
    if (!withoutNotify) return `${notifyLine}\n`

    const firstTableIndex = firstTableHeaderIndex(withoutNotify)
    if (firstTableIndex === -1) {
      return `${withoutNotify}\n${notifyLine}\n`
    }

    const beforeTables = withoutNotify.slice(0, firstTableIndex).trimEnd()
    const tablesAndBelow = withoutNotify.slice(firstTableIndex).replace(/^\n+/, '')

    const rebuilt = beforeTables
      ? `${beforeTables}\n${notifyLine}\n\n${tablesAndBelow}`
      : `${notifyLine}\n\n${tablesAndBelow}`

    return `${rebuilt.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
  }

  ipcMain.handle(IPC.CODEX_CHECK_NOTIFY, async () => {
    const config = await loadCodexConfigText()
    return {
      installed: hasOurCodexNotify(config),
      contextCaptureInstalled: hasOurCodexCapture(config),
    }
  })

  ipcMain.handle(IPC.CODEX_INSTALL_NOTIFY, async (_e, contextEnabled?: boolean) => {
    const scriptName = contextEnabled ? 'codex-combined.sh' : 'notify.sh'
    const notifyPath = getCodexHookScriptPath(scriptName)
    const notifyLine = `notify = ["${tomlEscape(notifyPath)}"]`
    let config = await loadCodexConfigText()

    // `notify` must be at true top-level in TOML. Appending at EOF can accidentally
    // nest it under the last table (for example `[projects."..."]`), which Codex ignores.
    config = stripNotifyAssignments(config)
    config = insertTopLevelNotify(config, notifyLine)

    await saveCodexConfigText(config)
    return { success: true }
  })

  ipcMain.handle(IPC.CODEX_UNINSTALL_NOTIFY, async () => {
    let config = await loadCodexConfigText()
    if (!config.includes(CODEX_NOTIFY_IDENTIFIER) && !config.includes(CODEX_NOTIFY_CAPTURE_IDENTIFIER)) return { success: true }

    config = stripNotifyAssignments(config, (assignment) => assignment.includes(CODEX_NOTIFY_IDENTIFIER) || assignment.includes(CODEX_NOTIFY_CAPTURE_IDENTIFIER))
    config = config.replace(/\n{3,}/g, '\n\n').trimEnd()
    if (config) config += '\n'

    await saveCodexConfigText(config)
    return { success: true }
  })

  // ── MCP config ──
  ipcMain.handle(IPC.MCP_LOAD_SERVERS, async () => {
    return loadMcpServersFromConfig()
  })

  ipcMain.handle(IPC.MCP_REMOVE_SERVER, async (_e, serverName: string) => {
    await removeServerFromConfig(serverName)
    return { success: true }
  })

  ipcMain.handle(IPC.MCP_GET_CONFIG_PATHS, async () => {
    const home = homedir()
    const geminiDir = join(home, '.gemini')
    const geminiConfigPath = join(geminiDir, 'settings.json')
    const cursorDir = join(home, '.cursor')
    const cursorConfigPath = join(cursorDir, 'mcp.json')

    // Ensure claude config exists
    if (!existsSync(CLAUDE_CONFIG_PATH)) {
      await writeFile(CLAUDE_CONFIG_PATH, '{}', 'utf-8')
    }
    // Ensure codex config exists
    if (!existsSync(CODEX_CONFIG_PATH)) {
      await mkdir(CODEX_DIR, { recursive: true })
      await writeFile(CODEX_CONFIG_PATH, '', 'utf-8')
    }
    // Ensure gemini config exists
    if (!existsSync(geminiConfigPath)) {
      await mkdir(geminiDir, { recursive: true })
      await writeFile(geminiConfigPath, '{}', 'utf-8')
    }
    // Ensure cursor config exists
    if (!existsSync(cursorConfigPath)) {
      await mkdir(cursorDir, { recursive: true })
      await writeFile(cursorConfigPath, '{}', 'utf-8')
    }

    return {
      'claude-code': CLAUDE_CONFIG_PATH,
      'codex': CODEX_CONFIG_PATH,
      'gemini': geminiConfigPath,
      'cursor': cursorConfigPath,
    }
  })

  // ── Automation handlers ──
  ipcMain.handle(IPC.AUTOMATION_CREATE, async (_e, automation: AutomationConfig) => {
    automationScheduler.schedule(automation)
  })

  ipcMain.handle(IPC.AUTOMATION_UPDATE, async (_e, automation: AutomationConfig) => {
    automationScheduler.schedule(automation) // reschedules
  })

  ipcMain.handle(IPC.AUTOMATION_DELETE, async (_e, automationId: string) => {
    automationScheduler.unschedule(automationId)
  })

  ipcMain.handle(IPC.AUTOMATION_RUN_NOW, async (_e, automation: AutomationConfig) => {
    automationScheduler.runNow(automation)
  })

  ipcMain.handle(IPC.AUTOMATION_STOP, async (_e, automationId: string) => {
    automationScheduler.unschedule(automationId)
  })

  // ── LSP handlers ──
  ipcMain.handle(IPC.LSP_GET_PORT, async () => {
    return lspService.start()
  })

  ipcMain.handle(IPC.LSP_GET_AVAILABLE_LANGUAGES, async () => {
    return lspService.getAvailableLanguages()
  })

  // ── App file picker ──
  ipcMain.handle(IPC.APP_SELECT_FILE, async (_e, filters?: { name: string; extensions: string[] }[]) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      title: 'Select File',
      filters: filters || [],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ── Skills & Subagents handlers ──
  ipcMain.handle(IPC.SKILLS_SCAN, async (_e, skillPath: string) => {
    return SkillsService.scanSkillDir(skillPath)
  })

  ipcMain.handle(IPC.SKILLS_SYNC, async (_e, skillPath: string, projectPath: string) => {
    await SkillsService.syncSkillToAgents(skillPath, projectPath)
  })

  ipcMain.handle(IPC.SKILLS_REMOVE, async (_e, skillName: string, projectPath: string) => {
    await SkillsService.removeSkillFromAgents(skillName, projectPath)
  })

  ipcMain.handle(IPC.SUBAGENTS_SCAN, async (_e, filePath: string) => {
    return SkillsService.scanSubagentFile(filePath)
  })

  ipcMain.handle(IPC.SUBAGENTS_SYNC, async (_e, subagentPath: string, projectPath: string) => {
    await SkillsService.syncSubagentToAgents(subagentPath, projectPath)
  })

  ipcMain.handle(IPC.SUBAGENTS_REMOVE, async (_e, subagentName: string, projectPath: string) => {
    await SkillsService.removeSubagentFromAgents(subagentName, projectPath)
  })

  // ── Skills & Subagents KV persistence ──
  ipcMain.handle(IPC.SKILLS_KV_SAVE, async (_e, projectPath: string, skill: { name: string; description: string; sourcePath: string; enabled: boolean }) => {
    await SkillsService.saveSkillToKV(projectPath, skill)
  })

  ipcMain.handle(IPC.SKILLS_KV_REMOVE, async (_e, projectPath: string, skillName: string) => {
    await SkillsService.removeSkillFromKV(projectPath, skillName)
  })

  ipcMain.handle(IPC.SKILLS_KV_LIST, async (_e, projectPath: string) => {
    return SkillsService.listSkillsFromKV(projectPath)
  })

  ipcMain.handle(IPC.SUBAGENTS_KV_SAVE, async (_e, projectPath: string, subagent: { name: string; description: string; sourcePath: string; tools?: string; enabled: boolean }) => {
    await SkillsService.saveSubagentToKV(projectPath, subagent)
  })

  ipcMain.handle(IPC.SUBAGENTS_KV_REMOVE, async (_e, projectPath: string, subagentName: string) => {
    await SkillsService.removeSubagentFromKV(projectPath, subagentName)
  })

  ipcMain.handle(IPC.SUBAGENTS_KV_LIST, async (_e, projectPath: string) => {
    return SkillsService.listSubagentsFromKV(projectPath)
  })

  // ── Clipboard handlers ──
  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    const filePath = join(tmpdir(), `constellagent-paste-${Date.now()}.png`)
    await writeFile(filePath, buf)
    return filePath
  })

  // ── Diff annotations (`{worktree}/.constellagent/annotations.json`) ──
  ipcMain.handle(IPC.ANNOTATION_LOAD, async (_e, worktreePath: string) => {
    return AnnotationService.load(worktreePath)
  })

  ipcMain.handle(IPC.ANNOTATION_ADD, async (_e, worktreePath: string, input: DiffAnnotationAddInput) => {
    return AnnotationService.add(worktreePath, input)
  })

  ipcMain.handle(IPC.ANNOTATION_RESOLVE, async (_e, worktreePath: string, id: string) => {
    await AnnotationService.resolve(worktreePath, id)
  })

  ipcMain.handle(IPC.ANNOTATION_DELETE, async (_e, worktreePath: string, id: string) => {
    await AnnotationService.delete(worktreePath, id)
  })

  // ── State persistence handlers ──
  const stateFilePath = () =>
    join(app.getPath('userData'), 'constellagent-state.json')

  ipcMain.handle(IPC.STATE_SAVE, async (_e, data: unknown) => {
    await mkdir(app.getPath('userData'), { recursive: true })
    await saveJsonFile(stateFilePath(), data)
  })

  // Synchronous save for beforeunload — guarantees state is written before window closes
  ipcMain.on(IPC.STATE_SAVE_SYNC, (event, data: unknown) => {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(stateFilePath(), JSON.stringify(data, null, 2), 'utf-8')
      event.returnValue = true
    } catch {
      event.returnValue = false
    }
  })

  ipcMain.handle(IPC.STATE_LOAD, async () => {
    const loaded = await loadJsonFile(stateFilePath(), null)
    const sanitized = sanitizeLoadedState(loaded)
    if (sanitized.changed) {
      await saveJsonFile(stateFilePath(), sanitized.data).catch(() => {})
      const count = sanitized.removedWorkspaceCount
      if (count > 0) {
        console.info(`[state] removed ${count} stale workspace${count === 1 ? '' : 's'}`)
      }
    }
    return sanitized.data
  })
}

/** Kill all PTY processes and stop all automation jobs. Call on app quit. */
export function cleanupAll(): void {
  worktreeSyncService.stopAll()
  ptyManager.destroyAll()
  automationScheduler.destroyAll()
  lspService.shutdown()
  cleanupAnnotationWatchers()
  for (const watcher of pendingIndexerWatchers.values()) watcher.close()
  pendingIndexerWatchers.clear()
  // Close AgentFS-backed context databases (async, best-effort on quit)
  for (const db of contextDbs.values()) db.close().catch(() => {})
  contextDbs.clear()
  closeAllAgentFS().catch(() => {})
}
