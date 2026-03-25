import { BrowserWindow } from 'electron'
import { realpathSync, resolve } from 'path'
import { IPC } from '../shared/ipc-channels'
import type { WorktreeSyncEvent, WorkspaceSyncInfo } from '../shared/worktree-sync-types'
import { GitService } from './git-service'

type ProjectSyncState = {
  repoPath: string
  syncInProgress: boolean
  pendingQueue: Set<string>
}

function normalizePath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export class WorktreeSyncService {
  private projects = new Map<string, ProjectSyncState>()
  private busyPaths = new Set<string>()

  private isBusy(worktreePath: string): boolean {
    const n = normalizePath(worktreePath)
    for (const b of this.busyPaths) {
      if (normalizePath(b) === n) return true
    }
    return false
  }

  private broadcast(event: WorktreeSyncEvent): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC.GIT_WORKTREE_SYNC_STATUS, event)
    }
  }

  private workspaceInfo(
    worktreePath: string,
    status: WorkspaceSyncInfo['status'],
    message?: string
  ): WorkspaceSyncInfo {
    return {
      workspacePath: worktreePath,
      status,
      message,
      lastSyncAt: status === 'synced' ? Date.now() : undefined,
    }
  }

  private mergeBroadcast(projectId: string, entries: Record<string, WorkspaceSyncInfo>): void {
    this.broadcast({ projectId, workspaces: entries })
  }

  /**
   * Run sync for one worktree path (must belong to project's repo).
   */
  private async syncOneWorktree(
    projectId: string,
    worktreePath: string,
    defaultBranch: string
  ): Promise<void> {
    const key = normalizePath(worktreePath)
    this.mergeBroadcast(projectId, { [key]: this.workspaceInfo(worktreePath, 'syncing') })

    const result = await GitService.syncWorktree(worktreePath, defaultBranch)
    if (result.status === 'ok') {
      this.mergeBroadcast(projectId, { [key]: this.workspaceInfo(worktreePath, 'synced') })
    } else if (result.status === 'conflict') {
      this.mergeBroadcast(projectId, {
        [key]: this.workspaceInfo(worktreePath, 'conflict', result.message),
      })
    } else {
      this.mergeBroadcast(projectId, {
        [key]: this.workspaceInfo(worktreePath, 'error', result.message),
      })
    }
  }

  /**
   * Remember repo path for manual sync (sidebar ↻). No background polling.
   */
  startPolling(projectId: string, repoPath: string): void {
    if (this.projects.has(projectId)) {
      this.stopPolling(projectId)
    }
    const state: ProjectSyncState = {
      repoPath,
      syncInProgress: false,
      pendingQueue: new Set(),
    }
    this.projects.set(projectId, state)
  }

  stopPolling(projectId: string): void {
    this.projects.delete(projectId)
  }

  stopAll(): void {
    for (const id of [...this.projects.keys()]) {
      this.stopPolling(id)
    }
    this.busyPaths.clear()
  }

  /**
   * Manual sync: fetch and rebase every worktree (busy ones queued).
   */
  async syncNow(projectId: string): Promise<void> {
    const state = this.projects.get(projectId)
    if (!state) return
    if (state.syncInProgress) return

    state.syncInProgress = true
    try {
      await GitService.fetchOrigin(state.repoPath)
      const defaultBranch = await GitService.getDefaultBranch(state.repoPath)
      const list = await GitService.listWorktrees(state.repoPath)
      const batch: Record<string, WorkspaceSyncInfo> = {}

      for (const wt of list) {
        if (wt.isBare || !wt.path) continue
        const p = wt.path
        const key = normalizePath(p)
        if (this.isBusy(p)) {
          state.pendingQueue.add(key)
          batch[key] = this.workspaceInfo(
            p,
            'queued',
            'Waiting for agent to finish'
          )
        }
      }
      if (Object.keys(batch).length > 0) {
        this.mergeBroadcast(projectId, batch)
      }

      for (const wt of list) {
        if (wt.isBare || !wt.path) continue
        const p = wt.path
        const key = normalizePath(p)
        if (this.isBusy(p)) continue

        state.pendingQueue.delete(key)
        await this.syncOneWorktree(projectId, p, defaultBranch)
      }
    } finally {
      state.syncInProgress = false
    }
  }

  setBusyWorktrees(paths: string[]): void {
    this.busyPaths = new Set(paths.map((p) => normalizePath(p)))
  }
}
