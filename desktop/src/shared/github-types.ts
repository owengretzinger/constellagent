export type PrState = 'open' | 'merged' | 'closed'

export type CheckStatus = 'pending' | 'passing' | 'failing' | 'none'

export interface PrInfo {
  number: number
  state: PrState
  title: string
  url: string
  checkStatus: CheckStatus
  hasPendingComments: boolean
  pendingCommentCount: number
  isBlockedByCi: boolean
  isApproved: boolean
  isChangesRequested: boolean
  updatedAt: string
}

export interface PrLookupResult {
  available: boolean
  error?: 'gh_not_installed' | 'not_authenticated' | 'not_github_repo'
  data: Record<string, PrInfo | null>
}
