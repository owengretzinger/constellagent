import { ipcMain, dialog, app, BrowserWindow, clipboard } from 'electron'
import { join, relative } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { watch, type FSWatcher } from 'fs'
import { IPC } from '../shared/ipc-channels'
import { PtyManager } from './pty-manager'
import { GitService } from './git-service'
import { GithubService } from './github-service'
import { FileService } from './file-service'
import { AutomationScheduler, type AutomationConfig } from './automation-scheduler'
import { trustPathForClaude, loadClaudeSettings, saveClaudeSettings, loadJsonFile, saveJsonFile } from './claude-config'
import { SkillsService } from './skills-service'

const ptyManager = new PtyManager()
const automationScheduler = new AutomationScheduler(ptyManager)

// Filesystem watchers: dirPath → { watcher, debounceTimer }
const fsWatchers = new Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>()

export function registerIpcHandlers(): void {
  // ── Git handlers ──
  ipcMain.handle(IPC.GIT_LIST_WORKTREES, async (_e, repoPath: string) => {
    return GitService.listWorktrees(repoPath)
  })

  ipcMain.handle(IPC.GIT_CREATE_WORKTREE, async (_e, repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean) => {
    return GitService.createWorktree(repoPath, name, branch, newBranch, baseBranch, force)
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

  // ── GitHub handlers ──
  ipcMain.handle(IPC.GITHUB_GET_PR_STATUSES, async (_e, repoPath: string, branches: string[]) => {
    return GithubService.getPrStatuses(repoPath, branches)
  })

  // ── PTY handlers ──
  ipcMain.handle(IPC.PTY_CREATE, async (_e, workingDir: string, shell?: string, extraEnv?: Record<string, string>) => {
    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) throw new Error('No window found')
    return ptyManager.create(workingDir, win.webContents, shell, undefined, undefined, extraEnv)
  })

  ipcMain.on(IPC.PTY_WRITE, (_e, ptyId: string, data: string) => {
    ptyManager.write(ptyId, data)
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
    function annotate(nodes: Awaited<ReturnType<typeof FileService.getTree>>): boolean {
      let hasStatus = false
      for (const node of nodes) {
        // Compute relative path from dirPath
        const rel = node.path.startsWith(dirPath)
          ? node.path.slice(dirPath.length + 1)
          : node.path

        if (node.type === 'file') {
          const st = statusMap.get(rel)
          if (st) {
            ;(node as any).gitStatus = st
            hasStatus = true
          }
        } else if (node.children) {
          const childHasStatus = annotate(node.children)
          if (childHasStatus) {
            ;(node as any).gitStatus = 'modified'
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
    return FileService.readFile(filePath)
  })

  ipcMain.handle(IPC.FS_WRITE_FILE, async (_e, filePath: string, content: string) => {
    return FileService.writeFile(filePath, content)
  })

  // ── Filesystem watcher handlers ──
  ipcMain.handle(IPC.FS_WATCH_START, (_e, dirPath: string) => {
    if (fsWatchers.has(dirPath)) return // already watching

    const win = BrowserWindow.fromWebContents(_e.sender)
    if (!win) return

    try {
      const watcher = watch(dirPath, { recursive: true }, (_eventType, filename) => {
        // Ignore .git internal changes
        if (filename && (filename.startsWith('.git/') || filename.startsWith('.git\\'))) return

        const entry = fsWatchers.get(dirPath)
        if (!entry) return

        // Debounce: wait 500ms of quiet before notifying
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => {
          if (!win.isDestroyed()) {
            win.webContents.send(IPC.FS_WATCH_CHANGED, dirPath)
          }
        }, 500)
      })

      fsWatchers.set(dirPath, { watcher, timer: null })
    } catch {
      // Directory may not exist or be inaccessible — ignore
    }
  })

  ipcMain.on(IPC.FS_WATCH_STOP, (_e, dirPath: string) => {
    const entry = fsWatchers.get(dirPath)
    if (entry) {
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

  ipcMain.handle(IPC.APP_GET_DATA_PATH, async () => {
    return app.getPath('userData')
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

  // Stable identifiers to match our hook entries regardless of full path
  const HOOK_IDENTIFIERS = ['claude-hooks/notify.sh', 'claude-hooks/activity.sh']

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
    return { installed: !!(hasStop && hasNotification && hasPromptSubmit) }
  })

  ipcMain.handle(IPC.CLAUDE_INSTALL_HOOKS, async () => {
    const settings = await loadClaudeSettings()
    const notifyPath = getHookScriptPath('notify.sh')
    const activityPath = getHookScriptPath('activity.sh')

    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>

    // Helper: remove stale entries with old paths, then add current one
    function ensureHook(event: string, scriptPath: string, matcher = '') {
      const rules = (hooks[event] ?? []) as Array<Record<string, unknown>>
      const filtered = rules.filter((rule) => !isOurHook(rule as { hooks?: Array<{ command?: string }> }))
      filtered.push({ matcher, hooks: [{ type: 'command', command: scriptPath }] })
      hooks[event] = filtered
    }

    ensureHook('Stop', notifyPath)
    ensureHook('Notification', notifyPath)
    ensureHook('UserPromptSubmit', activityPath)
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

    if (Object.keys(hooks).length === 0) delete settings.hooks
    await saveClaudeSettings(settings)
    return { success: true }
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

  // Load persisted automations and schedule enabled ones on startup
  ipcMain.handle(IPC.AUTOMATION_LIST, async () => {
    // List is just for init — renderer manages the list in store
    // Main process uses this to bootstrap scheduler from persisted state
    return null
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

  // ── Clipboard handlers ──
  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const buf = img.toPNG()
    const filePath = join(tmpdir(), `constellagent-paste-${Date.now()}.png`)
    await writeFile(filePath, buf)
    return filePath
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
    return loadJsonFile(stateFilePath(), null)
  })
}
