export type SyncStage = 'stash' | 'fetch' | 'rebase' | 'stash-pop' | 'done' | 'error' | 'skip'

export interface SyncProgress {
  worktreePath: string
  stage: SyncStage
  message: string
}

export interface SyncResult {
  worktreePath: string
  success: boolean
  skipped?: boolean
  error?: string
  stashPopConflict?: boolean
}
