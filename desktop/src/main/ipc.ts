import { Utils } from 'electrobun/bun'
import { join, relative } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync, watch, type FSWatcher } from 'fs'
import { homedir, tmpdir } from 'os'
import { IPC } from '../shared/ipc-channels'
import type { CreateWorktreeProgressEvent } from '../shared/workspace-creation'
import { PtyManager } from './pty-manager'
import { GitService } from './git-service'
import { GithubService } from './github-service'
import { FileService, type FileNode } from './file-service'
import { AutomationScheduler } from './automation-scheduler'
import type { AutomationConfig } from '../shared/automation-types'
import { trustPathForClaude, loadClaudeSettings, saveClaudeSettings, loadJsonFile, saveJsonFile } from './claude-config'
import { loadCodexConfigText, saveCodexConfigText } from './codex-config'
import {
  checkPiActivityExtensionInstalled,
  installPiActivityExtension,
  uninstallPiActivityExtension,
} from './pi-config'
import {
  type RendererConnection,
  broadcastToRenderer,
  requireRendererConnection,
} from './runtime-bridge'

const ptyManager = new PtyManager()
const automationScheduler = new AutomationScheduler(ptyManager)

export async function catchUpAutomationsOnWake(now = new Date()): Promise<void> {
  await automationScheduler.catchUpOnWake(now)
}

interface FsWatcherEntry {
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
  refs: number
}

const fsWatchers = new Map<string, FsWatcherEntry>()

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

type InvokeHandler = (sender: RendererConnection, ...args: any[]) => unknown | Promise<unknown>
type SendHandler = (sender: RendererConnection, ...args: any[]) => void | Promise<void>

const invokeHandlers = new Map<string, InvokeHandler>()
const sendHandlers = new Map<string, SendHandler>()
let handlersRegistered = false

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isWorkspaceLike(value: unknown): value is WorkspaceLike {
  return isRecord(value) && typeof value.id === 'string' && typeof value.worktreePath === 'string'
}

function isTabLike(value: unknown): value is TabLike {
  return isRecord(value) && typeof value.id === 'string' && typeof value.workspaceId === 'string'
}

function sanitizeLoadedState(data: unknown): StateSanitizeResult {
  if (!isRecord(data)) return { data, changed: false, removedWorkspaceCount: 0 }
  const rawWorkspaces = Array.isArray(data.workspaces) ? data.workspaces : null
  if (!rawWorkspaces) return { data, changed: false, removedWorkspaceCount: 0 }

  const keptWorkspaces: unknown[] = []
  const keptWorkspaceIds = new Set<string>()
  let removedWorkspaceCount = 0

  for (const workspace of rawWorkspaces) {
    if (!isWorkspaceLike(workspace) || !existsSync(workspace.worktreePath)) {
      removedWorkspaceCount += 1
      continue
    }
    keptWorkspaces.push(workspace)
    keptWorkspaceIds.add(workspace.id)
  }

  if (removedWorkspaceCount === 0) {
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
        (tab) => isTabLike(tab) && tab.workspaceId === nextActiveWorkspaceId,
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
        keptWorkspaceIds.has(workspaceId),
      ),
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

function userDataDir(): string {
  if (process.env.CONSTELLAGENT_USER_DATA_DIR) {
    return process.env.CONSTELLAGENT_USER_DATA_DIR
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Constellagent')
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Constellagent')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'constellagent')
}

function stateFilePath(): string {
  return join(userDataDir(), 'constellagent-state.json')
}

function resourceRoot(): string {
  return process.env.CONSTELLAGENT_RESOURCE_ROOT || join(import.meta.dir, '..')
}

function getHookScriptPath(name: string): string {
  return join(resourceRoot(), 'claude-hooks', name)
}

function getCodexHookScriptPath(name: string): string {
  return join(resourceRoot(), 'codex-hooks', name)
}

function registerInvoke(channel: string, handler: InvokeHandler): void {
  invokeHandlers.set(channel, handler)
}

function registerSend(channel: string, handler: SendHandler): void {
  sendHandlers.set(channel, handler)
}

export async function handleInvoke(
  channel: string,
  args: unknown[],
  sender = requireRendererConnection(),
): Promise<unknown> {
  const handler = invokeHandlers.get(channel)
  if (!handler) {
    throw new Error(`No invoke handler registered for ${channel}`)
  }
  return handler(sender, ...(args as any[]))
}

export async function handleSend(
  channel: string,
  args: unknown[],
  sender = requireRendererConnection(),
): Promise<void> {
  const handler = sendHandlers.get(channel)
  if (!handler) {
    throw new Error(`No send handler registered for ${channel}`)
  }
  await handler(sender, ...(args as any[]))
}

export function registerIpcHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true

  registerInvoke(IPC.GIT_LIST_WORKTREES, async (_sender, repoPath: string) => {
    return GitService.listWorktrees(repoPath)
  })

  registerInvoke(
    IPC.GIT_CREATE_WORKTREE,
    async (
      sender,
      repoPath: string,
      name: string,
      branch: string,
      newBranch: boolean,
      baseBranch?: string,
      force?: boolean,
      requestId?: string,
    ) => {
      return GitService.createWorktree(
        repoPath,
        name,
        branch,
        newBranch,
        baseBranch,
        force,
        (progress) => {
          const payload: CreateWorktreeProgressEvent = { requestId, ...progress }
          sender.send(IPC.GIT_CREATE_WORKTREE_PROGRESS, payload)
        },
      )
    },
  )

  registerInvoke(
    IPC.GIT_CREATE_WORKTREE_FROM_PR,
    async (
      sender,
      repoPath: string,
      name: string,
      prNumber: number,
      localBranch: string,
      force?: boolean,
      requestId?: string,
    ) => {
      return GitService.createWorktreeFromPr(
        repoPath,
        name,
        prNumber,
        localBranch,
        force,
        (progress) => {
          const payload: CreateWorktreeProgressEvent = { requestId, ...progress }
          sender.send(IPC.GIT_CREATE_WORKTREE_PROGRESS, payload)
        },
      )
    },
  )

  registerInvoke(IPC.GIT_REMOVE_WORKTREE, async (_sender, repoPath: string, worktreePath: string) => {
    return GitService.removeWorktree(repoPath, worktreePath)
  })

  registerInvoke(IPC.GIT_GET_STATUS, async (_sender, worktreePath: string) => {
    return GitService.getStatus(worktreePath)
  })

  registerInvoke(IPC.GIT_GET_DIFF, async (_sender, worktreePath: string, staged: boolean) => {
    return GitService.getDiff(worktreePath, staged)
  })

  registerInvoke(IPC.GIT_GET_FILE_DIFF, async (_sender, worktreePath: string, filePath: string) => {
    return GitService.getFileDiff(worktreePath, filePath)
  })

  registerInvoke(IPC.GIT_GET_BRANCHES, async (_sender, repoPath: string) => {
    return GitService.getBranches(repoPath)
  })

  registerInvoke(IPC.GIT_STAGE, async (_sender, worktreePath: string, paths: string[]) => {
    return GitService.stage(worktreePath, paths)
  })

  registerInvoke(IPC.GIT_UNSTAGE, async (_sender, worktreePath: string, paths: string[]) => {
    return GitService.unstage(worktreePath, paths)
  })

  registerInvoke(IPC.GIT_DISCARD, async (_sender, worktreePath: string, paths: string[], untracked: string[]) => {
    return GitService.discard(worktreePath, paths, untracked)
  })

  registerInvoke(IPC.GIT_COMMIT, async (_sender, worktreePath: string, message: string) => {
    return GitService.commit(worktreePath, message)
  })

  registerInvoke(IPC.GIT_GET_CURRENT_BRANCH, async (_sender, worktreePath: string) => {
    return GitService.getCurrentBranch(worktreePath)
  })

  registerInvoke(IPC.GIT_GET_DEFAULT_BRANCH, async (_sender, repoPath: string) => {
    return GitService.getDefaultBranch(repoPath)
  })

  registerInvoke(IPC.GITHUB_GET_PR_STATUSES, async (_sender, repoPath: string, branches: string[]) => {
    return GithubService.getPrStatuses(repoPath, branches)
  })

  registerInvoke(IPC.GITHUB_LIST_OPEN_PRS, async (_sender, repoPath: string) => {
    return GithubService.listOpenPrs(repoPath)
  })

  registerInvoke(IPC.PTY_CREATE, async (sender, workingDir: string, shell?: string, extraEnv?: Record<string, string>) => {
    return ptyManager.create(workingDir, sender, shell, undefined, undefined, extraEnv)
  })

  registerSend(IPC.PTY_WRITE, (_sender, ptyId: string, data: string) => {
    ptyManager.write(ptyId, data)
  })

  registerSend(IPC.PTY_RESIZE, (_sender, ptyId: string, cols: number, rows: number) => {
    ptyManager.resize(ptyId, cols, rows)
  })

  registerSend(IPC.PTY_DESTROY, (_sender, ptyId: string) => {
    ptyManager.destroy(ptyId)
  })

  registerInvoke(IPC.PTY_LIST, async () => {
    return ptyManager.list()
  })

  registerInvoke(IPC.PTY_REATTACH, async (sender, ptyId: string, sinceSeq?: number) => {
    return ptyManager.reattach(ptyId, sender, sinceSeq)
  })

  registerInvoke(IPC.FS_GET_TREE, async (_sender, dirPath: string) => {
    return FileService.getTree(dirPath)
  })

  registerInvoke(IPC.FS_GET_TREE_WITH_STATUS, async (_sender, dirPath: string) => {
    const [tree, statuses, topLevel] = await Promise.all([
      FileService.getTree(dirPath),
      GitService.getStatus(dirPath).catch(() => []),
      GitService.getTopLevel(dirPath).catch(() => dirPath),
    ])

    const prefix = relative(topLevel, dirPath)
    const statusMap = new Map<string, string>()
    for (const s of statuses) {
      let p = s.path
      if (p.includes(' -> ')) {
        p = p.split(' -> ')[1]
      }
      if (prefix && p.startsWith(prefix + '/')) {
        p = p.slice(prefix.length + 1)
      }
      statusMap.set(p, s.status)
    }

    function annotate(nodes: FileNode[]): boolean {
      let hasStatus = false
      for (const node of nodes) {
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

  registerInvoke(IPC.FS_READ_FILE, async (_sender, filePath: string) => {
    return FileService.readFile(filePath)
  })

  registerInvoke(IPC.FS_WRITE_FILE, async (_sender, filePath: string, content: string) => {
    return FileService.writeFile(filePath, content)
  })

  registerInvoke(IPC.FS_WATCH_START, async (_sender, dirPath: string) => {
    const existing = fsWatchers.get(dirPath)
    if (existing) {
      existing.refs += 1
      return
    }

    try {
      const watcher = watch(dirPath, { recursive: true }, (_eventType, filename) => {
        if (filename && (filename.startsWith('.git/') || filename.startsWith('.git\\'))) {
          const normalized = filename.replaceAll('\\', '/')
          const isStateChange =
            normalized === '.git/index' ||
            normalized === '.git/HEAD' ||
            normalized.startsWith('.git/refs/')
          if (!isStateChange) return
        }

        const entry = fsWatchers.get(dirPath)
        if (!entry) return
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          broadcastToRenderer(IPC.FS_WATCH_CHANGED, dirPath)
        }, 500)
      })

      fsWatchers.set(dirPath, {
        watcher,
        timer: null,
        refs: 1,
      })
    } catch {
      // Directory may not exist or be inaccessible.
    }
  })

  registerSend(IPC.FS_WATCH_STOP, async (_sender, dirPath: string) => {
    const entry = fsWatchers.get(dirPath)
    if (!entry) return
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs > 0) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.watcher.close()
    fsWatchers.delete(dirPath)
  })

  registerInvoke(IPC.APP_SELECT_DIRECTORY, async () => {
    const filePaths = await Utils.openFileDialog({
      canChooseFiles: false,
      canChooseDirectory: true,
      allowsMultipleSelection: false,
    })
    return filePaths.find(Boolean) || null
  })

  registerInvoke(IPC.APP_ADD_PROJECT_PATH, async (_sender, dirPath: string) => {
    const { stat } = await import('fs/promises')
    try {
      const s = await stat(dirPath)
      if (!s.isDirectory()) return null
      return dirPath
    } catch {
      return null
    }
  })

  registerInvoke(IPC.APP_OPEN_EXTERNAL, async (_sender, url: string) => {
    return Utils.openExternal(url)
  })

  registerInvoke(IPC.CLAUDE_TRUST_PATH, async (_sender, dirPath: string) => {
    await trustPathForClaude(dirPath)
  })

  const HOOK_IDENTIFIERS = [
    'claude-hooks/notify.sh',
    'claude-hooks/activity.sh',
    'claude-hooks/question-notify.sh',
  ]

  function shellQuoteArg(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`
  }

  function isOurHook(rule: { hooks?: Array<{ command?: string }> }): boolean {
    return !!rule.hooks?.some((h) => HOOK_IDENTIFIERS.some((id) => h.command?.includes(id)))
  }

  registerInvoke(IPC.CLAUDE_CHECK_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const hooks = settings.hooks as Record<string, unknown[]> | undefined
    if (!hooks) return { installed: false }

    const hasStop = (hooks.Stop as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasNotification = (hooks.Notification as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasPromptSubmit = (hooks.UserPromptSubmit as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    const hasQuestionHook = (hooks.PreToolUse as Array<{ hooks?: Array<{ command?: string }> }> | undefined)?.some(isOurHook)
    return { installed: !!(hasStop && hasNotification && hasPromptSubmit && hasQuestionHook) }
  })

  registerInvoke(IPC.CLAUDE_INSTALL_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const notifyPath = getHookScriptPath('notify.sh')
    const activityPath = getHookScriptPath('activity.sh')
    const questionNotifyPath = getHookScriptPath('question-notify.sh')
    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>

    function ensureHook(event: string, scriptPath: string, matcher = '') {
      const rules = (hooks[event] ?? []) as Array<Record<string, unknown>>
      const filtered = rules.filter((rule) => !isOurHook(rule as { hooks?: Array<{ command?: string }> }))
      filtered.push({ matcher, hooks: [{ type: 'command', command: shellQuoteArg(scriptPath) }] })
      hooks[event] = filtered
    }

    ensureHook('Stop', notifyPath)
    ensureHook('Notification', notifyPath)
    ensureHook('UserPromptSubmit', activityPath)
    ensureHook('PreToolUse', questionNotifyPath)
    settings.hooks = hooks

    await saveClaudeSettings(settings)
    return { success: true }
  })

  registerInvoke(IPC.CLAUDE_UNINSTALL_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const hooks = settings.hooks as Record<string, unknown[]> | undefined
    if (!hooks) return { success: true }
    const installedHooks = hooks

    function removeHook(event: string) {
      const rules = (installedHooks[event] ?? []) as Array<{ hooks?: Array<{ command?: string }> }>
      installedHooks[event] = rules.filter((rule) => !isOurHook(rule))
      if ((installedHooks[event] as unknown[]).length === 0) delete installedHooks[event]
    }

    removeHook('Stop')
    removeHook('Notification')
    removeHook('UserPromptSubmit')
    removeHook('PreToolUse')

    if (Object.keys(installedHooks).length === 0) delete settings.hooks
    await saveClaudeSettings(settings)
    return { success: true }
  })

  const CODEX_NOTIFY_IDENTIFIER = 'codex-hooks/notify.sh'
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
    return topLevelSection(configText).includes(CODEX_NOTIFY_IDENTIFIER)
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

  registerInvoke(IPC.CODEX_CHECK_NOTIFY, async () => {
    const config = await loadCodexConfigText()
    return { installed: hasOurCodexNotify(config) }
  })

  registerInvoke(IPC.CODEX_INSTALL_NOTIFY, async () => {
    const notifyPath = getCodexHookScriptPath('notify.sh')
    const notifyLine = `notify = ["${tomlEscape(notifyPath)}"]`
    let config = await loadCodexConfigText()

    config = stripNotifyAssignments(config)
    config = insertTopLevelNotify(config, notifyLine)

    await saveCodexConfigText(config)
    return { success: true }
  })

  registerInvoke(IPC.CODEX_UNINSTALL_NOTIFY, async () => {
    let config = await loadCodexConfigText()
    if (!config.includes(CODEX_NOTIFY_IDENTIFIER)) return { success: true }

    config = stripNotifyAssignments(config, (assignment) => assignment.includes(CODEX_NOTIFY_IDENTIFIER))
    config = config.replace(/\n{3,}/g, '\n\n').trimEnd()
    if (config) config += '\n'

    await saveCodexConfigText(config)
    return { success: true }
  })

  registerInvoke(IPC.PI_CHECK_ACTIVITY_EXTENSION, async () => {
    const installed = await checkPiActivityExtensionInstalled()
    return { installed }
  })

  registerInvoke(IPC.PI_INSTALL_ACTIVITY_EXTENSION, async () => {
    await installPiActivityExtension()
    return { success: true }
  })

  registerInvoke(IPC.PI_UNINSTALL_ACTIVITY_EXTENSION, async () => {
    await uninstallPiActivityExtension()
    return { success: true }
  })

  registerInvoke(IPC.AUTOMATION_CREATE, async (_sender, automation: AutomationConfig) => {
    automationScheduler.schedule(automation)
  })

  registerInvoke(IPC.AUTOMATION_UPDATE, async (_sender, automation: AutomationConfig) => {
    automationScheduler.schedule(automation)
  })

  registerInvoke(IPC.AUTOMATION_DELETE, async (_sender, automationId: string) => {
    automationScheduler.unschedule(automationId)
  })

  registerInvoke(IPC.AUTOMATION_RUN_NOW, async (_sender, automation: AutomationConfig) => {
    automationScheduler.runNow(automation)
  })

  registerInvoke(IPC.AUTOMATION_STOP, async (_sender, automationId: string) => {
    automationScheduler.unschedule(automationId)
  })

  registerInvoke(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = Utils.clipboardReadImage()
    if (!img || img.length === 0) return null
    const filePath = join(tmpdir(), `constellagent-paste-${Date.now()}.png`)
    await writeFile(filePath, img)
    return filePath
  })

  registerInvoke(IPC.STATE_SAVE, async (_sender, data: unknown) => {
    await mkdir(userDataDir(), { recursive: true })
    await saveJsonFile(stateFilePath(), data)
  })

  registerInvoke(IPC.STATE_LOAD, async () => {
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
