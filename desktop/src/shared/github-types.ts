export type PrState = 'open' | 'merged' | 'closed'

export type CheckStatus = 'pending' | 'passing' | 'failing' | 'none'

export type GithubLookupError = 'gh_not_installed' | 'not_authenticated' | 'not_github_repo'

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
  error?: GithubLookupError
  data: Record<string, PrInfo | null>
}

export interface OpenPrInfo extends PrInfo {
  headRefName: string
  authorLogin?: string
}

export interface ListOpenPrsResult {
  available: boolean
  error?: GithubLookupError
  data: OpenPrInfo[]
}
