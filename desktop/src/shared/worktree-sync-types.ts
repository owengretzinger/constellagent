export type WorkspaceSyncStatus = 'idle' | 'syncing' | 'synced' | 'queued' | 'conflict' | 'error'

export interface WorkspaceSyncInfo {
  workspacePath: string
  status: WorkspaceSyncStatus
  message?: string
  lastSyncAt?: number
}

export interface WorktreeSyncEvent {
  projectId: string
  workspaces: Record<string, WorkspaceSyncInfo>
}
