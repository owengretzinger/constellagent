import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AutomationConfig, AutomationRunStartedEvent } from '../shared/automation-types'
import type { CreateWorktreeProgressEvent } from '../shared/workspace-creation'

const api = {
  git: {
    listWorktrees: (repoPath: string) =>
      ipcRenderer.invoke(IPC.GIT_LIST_WORKTREES, repoPath),
    createWorktree: (repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean, requestId?: string) =>
      ipcRenderer.invoke(IPC.GIT_CREATE_WORKTREE, repoPath, name, branch, newBranch, baseBranch, force, requestId),
    createWorktreeFromPr: (repoPath: string, name: string, prNumber: number, localBranch: string, force?: boolean, requestId?: string) =>
      ipcRenderer.invoke(IPC.GIT_CREATE_WORKTREE_FROM_PR, repoPath, name, prNumber, localBranch, force, requestId) as Promise<{ worktreePath: string; branch: string }>,
    onCreateWorktreeProgress: (callback: (progress: CreateWorktreeProgressEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: CreateWorktreeProgressEvent) => callback(progress)
      ipcRenderer.on(IPC.GIT_CREATE_WORKTREE_PROGRESS, listener)
      return () => {
        ipcRenderer.removeListener(IPC.GIT_CREATE_WORKTREE_PROGRESS, listener)
      }
    },
    removeWorktree: (repoPath: string, worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_REMOVE_WORKTREE, repoPath, worktreePath),
    getStatus: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_STATUS, worktreePath),
    getDiff: (worktreePath: string, staged: boolean) =>
      ipcRenderer.invoke(IPC.GIT_GET_DIFF, worktreePath, staged),
    getFileDiff: (worktreePath: string, filePath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_FILE_DIFF, worktreePath, filePath),
    getBranches: (repoPath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_BRANCHES, repoPath),
    stage: (worktreePath: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.GIT_STAGE, worktreePath, paths),
    unstage: (worktreePath: string, paths: string[]) =>
      ipcRenderer.invoke(IPC.GIT_UNSTAGE, worktreePath, paths),
    discard: (worktreePath: string, paths: string[], untracked: string[]) =>
      ipcRenderer.invoke(IPC.GIT_DISCARD, worktreePath, paths, untracked),
    commit: (worktreePath: string, message: string) =>
      ipcRenderer.invoke(IPC.GIT_COMMIT, worktreePath, message),
    getCurrentBranch: (worktreePath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_CURRENT_BRANCH, worktreePath) as Promise<string>,
    getDefaultBranch: (repoPath: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_DEFAULT_BRANCH, repoPath) as Promise<string>,
    showFileAtHead: (worktreePath: string, filePath: string) =>
      ipcRenderer.invoke(IPC.GIT_SHOW_FILE_AT_HEAD, worktreePath, filePath) as Promise<string | null>,
    getLog: (worktreePath: string, maxCount?: number) =>
      ipcRenderer.invoke(IPC.GIT_GET_LOG, worktreePath, maxCount) as Promise<import('../shared/git-types').GitLogEntry[]>,
    getCommitDiff: (worktreePath: string, hash: string) =>
      ipcRenderer.invoke(IPC.GIT_GET_COMMIT_DIFF, worktreePath, hash) as Promise<string>,
  },

  pty: {
    create: (workingDir: string, shell?: string, extraEnv?: Record<string, string>) =>
      ipcRenderer.invoke(IPC.PTY_CREATE, workingDir, shell, extraEnv),
    write: (ptyId: string, data: string) =>
      ipcRenderer.send(IPC.PTY_WRITE, ptyId, data),
    resize: (ptyId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.PTY_RESIZE, ptyId, cols, rows),
    destroy: (ptyId: string) =>
      ipcRenderer.send(IPC.PTY_DESTROY, ptyId),
    list: () =>
      ipcRenderer.invoke(IPC.PTY_LIST) as Promise<string[]>,
    reattach: (ptyId: string) =>
      ipcRenderer.invoke(IPC.PTY_REATTACH, ptyId) as Promise<boolean>,
    onData: (ptyId: string, callback: (data: string) => void) => {
      const channel = `${IPC.PTY_DATA}:${ptyId}`
      const listener = (_event: Electron.IpcRendererEvent, data: string) => callback(data)
      ipcRenderer.on(channel, listener)
      return () => {
        ipcRenderer.removeListener(channel, listener)
      }
    },
  },

  fs: {
    getTree: (dirPath: string) =>
      ipcRenderer.invoke(IPC.FS_GET_TREE, dirPath),
    getTreeWithStatus: (dirPath: string) =>
      ipcRenderer.invoke(IPC.FS_GET_TREE_WITH_STATUS, dirPath),
    readFile: (filePath: string) =>
      ipcRenderer.invoke(IPC.FS_READ_FILE, filePath),
    writeFile: (filePath: string, content: string) =>
      ipcRenderer.invoke(IPC.FS_WRITE_FILE, filePath, content),
    deleteFile: (filePath: string) =>
      ipcRenderer.invoke(IPC.FS_DELETE_FILE, filePath),
    watchDir: (dirPath: string) =>
      ipcRenderer.invoke(IPC.FS_WATCH_START, dirPath),
    unwatchDir: (dirPath: string) =>
      ipcRenderer.send(IPC.FS_WATCH_STOP, dirPath),
    onDirChanged: (callback: (dirPath: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, dirPath: string) => callback(dirPath)
      ipcRenderer.on(IPC.FS_WATCH_CHANGED, listener)
      return () => {
        ipcRenderer.removeListener(IPC.FS_WATCH_CHANGED, listener)
      }
    },
  },

  app: {
    selectDirectory: () =>
      ipcRenderer.invoke(IPC.APP_SELECT_DIRECTORY),
    selectFile: (filters?: { name: string; extensions: string[] }[]) =>
      ipcRenderer.invoke(IPC.APP_SELECT_FILE, filters) as Promise<string | null>,
    addProjectPath: (dirPath: string) =>
      ipcRenderer.invoke(IPC.APP_ADD_PROJECT_PATH, dirPath),
    openInEditor: (dirPath: string, cliCommand: string) =>
      ipcRenderer.invoke(IPC.APP_OPEN_IN_EDITOR, dirPath, cliCommand) as Promise<{ success: boolean; error?: string }>,
  },

  skills: {
    scan: (skillPath: string) =>
      ipcRenderer.invoke(IPC.SKILLS_SCAN, skillPath) as Promise<{ name: string; description: string } | null>,
    sync: (skillPath: string, projectPath: string) =>
      ipcRenderer.invoke(IPC.SKILLS_SYNC, skillPath, projectPath),
    remove: (skillName: string, projectPath: string) =>
      ipcRenderer.invoke(IPC.SKILLS_REMOVE, skillName, projectPath),
  },

  subagents: {
    scan: (filePath: string) =>
      ipcRenderer.invoke(IPC.SUBAGENTS_SCAN, filePath) as Promise<{ name: string; description: string; tools?: string } | null>,
    sync: (subagentPath: string, projectPath: string) =>
      ipcRenderer.invoke(IPC.SUBAGENTS_SYNC, subagentPath, projectPath),
    remove: (subagentName: string, projectPath: string) =>
      ipcRenderer.invoke(IPC.SUBAGENTS_REMOVE, subagentName, projectPath),
  },

  claude: {
    trustPath: (dirPath: string) =>
      ipcRenderer.invoke(IPC.CLAUDE_TRUST_PATH, dirPath),
    installHooks: (contextEnabled: boolean) =>
      ipcRenderer.invoke(IPC.CLAUDE_INSTALL_HOOKS, contextEnabled),
    uninstallHooks: () =>
      ipcRenderer.invoke(IPC.CLAUDE_UNINSTALL_HOOKS),
    checkHooks: () =>
      ipcRenderer.invoke(IPC.CLAUDE_CHECK_HOOKS),
    onNotifyWorkspace: (callback: (workspaceId: string) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, wsId: string) => callback(wsId)
      ipcRenderer.on(IPC.CLAUDE_NOTIFY_WORKSPACE, listener)
      return () => {
        ipcRenderer.removeListener(IPC.CLAUDE_NOTIFY_WORKSPACE, listener)
      }
    },
    onActivityUpdate: (callback: (workspaceIds: string[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, wsIds: string[]) => callback(wsIds)
      ipcRenderer.on(IPC.CLAUDE_ACTIVITY_UPDATE, listener)
      return () => {
        ipcRenderer.removeListener(IPC.CLAUDE_ACTIVITY_UPDATE, listener)
      }
    },
  },

  codex: {
    installNotify: (contextEnabled?: boolean) =>
      ipcRenderer.invoke(IPC.CODEX_INSTALL_NOTIFY, contextEnabled),
    uninstallNotify: () =>
      ipcRenderer.invoke(IPC.CODEX_UNINSTALL_NOTIFY),
    checkNotify: () =>
      ipcRenderer.invoke(IPC.CODEX_CHECK_NOTIFY),
  },

  automations: {
    create: (automation: AutomationConfig) =>
      ipcRenderer.invoke(IPC.AUTOMATION_CREATE, automation),
    update: (automation: AutomationConfig) =>
      ipcRenderer.invoke(IPC.AUTOMATION_UPDATE, automation),
    delete: (automationId: string) =>
      ipcRenderer.invoke(IPC.AUTOMATION_DELETE, automationId),
    runNow: (automation: AutomationConfig) =>
      ipcRenderer.invoke(IPC.AUTOMATION_RUN_NOW, automation),
    stop: (automationId: string) =>
      ipcRenderer.invoke(IPC.AUTOMATION_STOP, automationId),
    onRunStarted: (callback: (data: AutomationRunStartedEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, data: AutomationRunStartedEvent) => callback(data)
      ipcRenderer.on(IPC.AUTOMATION_RUN_STARTED, listener)
      return () => {
        ipcRenderer.removeListener(IPC.AUTOMATION_RUN_STARTED, listener)
      }
    },
  },

  github: {
    getPrStatuses: (repoPath: string, branches: string[]) =>
      ipcRenderer.invoke(IPC.GITHUB_GET_PR_STATUSES, repoPath, branches),
    listOpenPrs: (repoPath: string) =>
      ipcRenderer.invoke(IPC.GITHUB_LIST_OPEN_PRS, repoPath),
    resolvePr: (repoPath: string, prNumber: number, repoSlug?: string) =>
      ipcRenderer.invoke(IPC.GITHUB_RESOLVE_PR, repoPath, prNumber, repoSlug) as Promise<{ branch: string; title: string; number: number }>,
  },

  lsp: {
    getPort: () =>
      ipcRenderer.invoke(IPC.LSP_GET_PORT) as Promise<number>,
    getAvailableLanguages: () =>
      ipcRenderer.invoke(IPC.LSP_GET_AVAILABLE_LANGUAGES) as Promise<string[]>,
  },

  mcp: {
    syncConfigs: (servers: unknown[], assignments: unknown) =>
      ipcRenderer.invoke(IPC.MCP_SYNC_CONFIGS, servers, assignments),
    loadServers: () =>
      ipcRenderer.invoke(IPC.MCP_LOAD_SERVERS) as Promise<import('../renderer/store/types').McpServer[]>,
    removeServer: (serverName: string) =>
      ipcRenderer.invoke(IPC.MCP_REMOVE_SERVER, serverName),
    getConfigPaths: () =>
      ipcRenderer.invoke(IPC.MCP_GET_CONFIG_PATHS) as Promise<Record<string, string>>,
  },

  context: {
    repoInit: (projectDir: string, wsId: string) =>
      ipcRenderer.invoke(IPC.CONTEXT_REPO_INIT, projectDir, wsId) as Promise<{ success: boolean }>,
    search: (projectDir: string, query: string, limit?: number) =>
      ipcRenderer.invoke(IPC.CONTEXT_SEARCH, projectDir, query, limit),
    getRecent: (projectDir: string, workspaceId: string, limit?: number) =>
      ipcRenderer.invoke(IPC.CONTEXT_GET_RECENT, projectDir, workspaceId, limit),
    insert: (projectDir: string, entry: {
      workspaceId: string; sessionId?: string; toolName: string;
      toolInput?: string; filePath?: string; timestamp: string;
    }) => ipcRenderer.invoke(IPC.CONTEXT_INSERT, projectDir, entry),
    restoreCheckpoint: (projectDir: string, commitHash: string) =>
      ipcRenderer.invoke(IPC.CONTEXT_RESTORE_CHECKPOINT, projectDir, commitHash) as Promise<{ success: boolean }>,
  },

  session: {
    getLast: (workspaceId: string, agentType: string) =>
      ipcRenderer.invoke(IPC.SESSION_GET_LAST, workspaceId, agentType) as Promise<string | null>,
  },

  clipboard: {
    saveImage: () =>
      ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_IMAGE) as Promise<string | null>,
  },

  state: {
    save: (data: unknown) =>
      ipcRenderer.invoke(IPC.STATE_SAVE, data),
    saveSync: (data: unknown) =>
      ipcRenderer.sendSync(IPC.STATE_SAVE_SYNC, data) as boolean,
    load: () =>
      ipcRenderer.invoke(IPC.STATE_LOAD),
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
