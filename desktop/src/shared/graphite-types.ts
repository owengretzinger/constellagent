export interface GraphiteBranchInfo {
  name: string
  parent: string | null
  prNumber?: number
}

export interface GraphiteStackInfo {
  branches: GraphiteBranchInfo[]  // ordered trunk → tip
  currentBranch: string
}
