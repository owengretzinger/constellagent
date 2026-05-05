export type WorkingTreeFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'

export interface WorkingTreeDiffEntry {
  path: string
  oldPath?: string
  status: WorkingTreeFileStatus
  patch: string
  isBinary: boolean
  tooLarge: boolean
}
