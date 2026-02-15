import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { AutomationConfig, AutomationRunStartedEvent } from '../shared/automation-types'
import type { CreateWorktreeProgressEvent } from '../shared/workspace-creation'
import type { GraphiteCurrentStackSnapshot } from '../shared/graphite-types'

const api = {
  git: {
    listWorktrees: (repoPath: string) =>
      ipcRenderer.invoke(IPC.GIT_LIST_WORKTREES, repoPath),
    createWorktree: (repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean, requestId?: string) =>
      ipcRenderer.invoke(IPC.GIT_CREATE_WORKTREE, repoPath, name, branch, newBranch, baseBranch, force, requestId),
    createCloneWorkspace: (repoPath: string, name: string, branch: string, newBranch: boolean, baseBranch?: string, force?: boolean, requestId?: string) =>
      ipcRenderer.invoke(IPC.GIT_CREATE_CLONE_WORKSPACE, repoPath, name, branch, newBranch, baseBranch, force, requestId),
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
  },

  pty: {
    create: (workingDir: string, shell?: string, extraEnv?: Record<string, string>, useLoginShell?: boolean, sessionId?: string) =>
      ipcRenderer.invoke(IPC.PTY_CREATE, workingDir, shell, extraEnv, useLoginShell, sessionId),
    write: (ptyId: string, data: string) =>
      ipcRenderer.send(IPC.PTY_WRITE, ptyId, data),
    resize: (ptyId: string, cols: number, rows: number) =>
      ipcRenderer.send(IPC.PTY_RESIZE, ptyId, cols, rows),
    detach: (ptyId: string) =>
      ipcRenderer.send(IPC.PTY_DETACH, ptyId),
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
    addProjectPath: (dirPath: string) =>
      ipcRenderer.invoke(IPC.APP_ADD_PROJECT_PATH, dirPath),
    setZoomFactor: (factor: number) =>
      ipcRenderer.invoke(IPC.APP_SET_ZOOM_FACTOR, factor) as Promise<number>,
    getZoomFactor: () =>
      ipcRenderer.invoke(IPC.APP_GET_ZOOM_FACTOR) as Promise<number>,
  },

  claude: {
    trustPath: (dirPath: string) =>
      ipcRenderer.invoke(IPC.CLAUDE_TRUST_PATH, dirPath),
    installHooks: () =>
      ipcRenderer.invoke(IPC.CLAUDE_INSTALL_HOOKS),
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
    installNotify: () =>
      ipcRenderer.invoke(IPC.CODEX_INSTALL_NOTIFY),
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
  },

  graphite: {
    getCurrentStackSnapshot: (repoPath: string, worktreePath: string) =>
      ipcRenderer.invoke(IPC.GRAPHITE_GET_CURRENT_STACK_SNAPSHOT, repoPath, worktreePath) as Promise<GraphiteCurrentStackSnapshot>,
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
