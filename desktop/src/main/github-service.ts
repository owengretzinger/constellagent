import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PrInfo, PrLookupResult, CheckStatus, PrState } from '../shared/github-types'

const execFileAsync = promisify(execFile)

interface GithubRepoInfo {
  owner: string
  name: string
}

interface GraphqlPullRequestNode {
  number: number
  state: string
  title: string
  url: string
  updatedAt: string
  reviewDecision?: string | null
  mergeStateStatus?: string | null
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          state?: string
        } | null
      }
    }>
  }
}

interface GraphqlConnection {
  nodes?: GraphqlPullRequestNode[]
}

interface GraphqlResponse {
  data?: {
    repository?: Record<string, GraphqlConnection>
  }
  errors?: Array<{ message?: string }>
}

interface GraphqlReviewThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes?: Array<{ isResolved?: boolean }>
          pageInfo?: {
            hasNextPage?: boolean
            endCursor?: string | null
          }
        }
      }
    }
  }
  errors?: Array<{ message?: string }>
}

interface RepoResponseCache {
  data: Record<string, PrInfo | null>
}

interface UnresolvedThreadCacheEntry {
  count: number
  fetchedAt: number
}

class GithubAuthError extends Error {}

export class GithubService {
  private static AUTH_TOKEN_REFRESH_MS = 60_000
  private static UNRESOLVED_THREAD_CACHE_TTL_MS = 30_000
  private static ghAvailable: boolean | null = null
  private static repoInfoCache = new Map<string, GithubRepoInfo | null>()
  private static responseCache = new Map<string, RepoResponseCache>()
  private static unresolvedThreadCache = new Map<string, UnresolvedThreadCacheEntry>()
  private static authToken: string | null = null
  private static authTokenChecked = false
  private static authTokenFetchedAt = 0

  static async isGhAvailable(): Promise<boolean> {
    if (this.ghAvailable !== null) return this.ghAvailable
    try {
      await execFileAsync('gh', ['--version'], { timeout: 5000 })
      this.ghAvailable = true
    } catch {
      this.ghAvailable = false
    }
    return this.ghAvailable
  }

  static async isGithubRepo(repoPath: string): Promise<boolean> {
    const cached = this.repoInfoCache.get(repoPath)
    if (cached !== undefined) return cached !== null
    const repoInfo = await this.getGithubRepoInfo(repoPath)
    return repoInfo !== null
  }

  private static async getGithubRepoInfo(repoPath: string): Promise<GithubRepoInfo | null> {
    const cached = this.repoInfoCache.get(repoPath)
    if (cached !== undefined) return cached
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoPath,
        timeout: 5000,
      })
      const repoInfo = this.parseGithubRemote(stdout)
      this.repoInfoCache.set(repoPath, repoInfo)
      return repoInfo
    } catch {
      this.repoInfoCache.set(repoPath, null)
      return null
    }
  }

  static async getPrStatuses(repoPath: string, branches: string[]): Promise<PrLookupResult> {
    if (!(await this.isGhAvailable())) {
      return { available: false, error: 'gh_not_installed', data: {} }
    }
    const repoInfo = await this.getGithubRepoInfo(repoPath)
    if (!repoInfo) {
      return { available: false, error: 'not_github_repo', data: {} }
    }
    const token = await this.getAuthToken()
    if (!token) {
      return { available: false, error: 'not_authenticated', data: {} }
    }

    const normalizedBranches = Array.from(
      new Set(
        branches
          .map((branch) => branch.trim())
          .filter(Boolean)
      )
    ).sort()

    if (normalizedBranches.length === 0) {
      return { available: true, data: {} }
    }

    const cacheKey = this.cacheKey(repoPath, normalizedBranches)
    const cached = this.responseCache.get(cacheKey)

    try {
      const result = await this.fetchRepoPrStatuses(repoInfo, normalizedBranches, token)
      this.setCachedResponse(cacheKey, result.data)
      return { available: true, data: this.cloneData(result.data) }
    } catch (err) {
      if (err instanceof GithubAuthError) {
        this.authToken = null
        this.authTokenChecked = false
        this.authTokenFetchedAt = 0
        return { available: false, error: 'not_authenticated', data: {} }
      }
      if (cached) {
        return { available: true, data: this.cloneData(cached.data) }
      }
      return { available: true, data: this.emptyResult(normalizedBranches) }
    }
  }

  private static async getAuthToken(): Promise<string | null> {
    const now = Date.now()
    if (
      this.authTokenChecked &&
      now - this.authTokenFetchedAt < this.AUTH_TOKEN_REFRESH_MS
    ) {
      return this.authToken
    }

    this.authTokenChecked = true
    this.authTokenFetchedAt = now
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 5000 })
      const token = stdout.trim()
      this.authToken = token || null
    } catch {
      this.authToken = null
    }
    return this.authToken
  }

  private static parseGithubRemote(remote: string): GithubRepoInfo | null {
    const trimmed = remote.trim()
    if (!trimmed) return null

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('ssh://')) {
      try {
        const parsed = new URL(trimmed)
        if (parsed.hostname.toLowerCase() !== 'github.com') return null
        const parts = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
        if (parts.length < 2) return null
        const owner = parts[0]
        const name = parts[1].replace(/\.git$/i, '')
        if (!owner || !name) return null
        return { owner, name }
      } catch {
        return null
      }
    }

    const sshMatch = trimmed.match(/^[^@]+@github\.com:([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i)
    if (sshMatch?.[1] && sshMatch?.[2]) {
      return { owner: sshMatch[1], name: sshMatch[2] }
    }

    const plainMatch = trimmed.match(/^github\.com[:/]([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/i)
    if (plainMatch?.[1] && plainMatch?.[2]) {
      return { owner: plainMatch[1], name: plainMatch[2] }
    }

    return null
  }

  private static cacheKey(repoPath: string, branches: string[]): string {
    return `${repoPath}::${branches.join('\u0000')}`
  }

  private static setCachedResponse(
    cacheKey: string,
    data: Record<string, PrInfo | null>
  ): void {
    this.responseCache.set(cacheKey, {
      data: this.cloneData(data),
    })
  }

  private static cloneData(data: Record<string, PrInfo | null>): Record<string, PrInfo | null> {
    const cloned: Record<string, PrInfo | null> = {}
    for (const [branch, pr] of Object.entries(data)) {
      cloned[branch] = pr ? { ...pr } : null
    }
    return cloned
  }

  private static emptyResult(branches: string[]): Record<string, PrInfo | null> {
    const result: Record<string, PrInfo | null> = {}
    for (const branch of branches) result[branch] = null
    return result
  }

  private static async fetchRepoPrStatuses(
    repoInfo: GithubRepoInfo,
    branches: string[],
    token: string
  ): Promise<{ data: Record<string, PrInfo | null> }> {
    const { query, variables } = this.buildGraphqlQuery(repoInfo, branches)
    const payload = await this.fetchGraphqlJson<GraphqlResponse>(query, variables, token)

    const repository = payload.data?.repository
    if (!repository) {
      return { data: this.emptyResult(branches) }
    }

    const data: Record<string, PrInfo | null> = {}
    const unresolvedLookups: Promise<void>[] = []
    for (let i = 0; i < branches.length; i++) {
      const branch = branches[i]
      const openNode = repository[`b${i}Open`]?.nodes?.[0]
      const anyNode = repository[`b${i}Any`]?.nodes?.[0]
      const picked = openNode ?? anyNode
      const mapped = picked ? this.mapPullRequest(picked) : null
      data[branch] = mapped

      if (picked && mapped && mapped.state === 'open') {
        unresolvedLookups.push(
          this.attachUnresolvedReviewThreads(repoInfo, token, picked, mapped)
        )
      }
    }

    if (unresolvedLookups.length > 0) {
      await Promise.allSettled(unresolvedLookups)
    }

    return { data }
  }

  private static buildGraphqlQuery(
    repoInfo: GithubRepoInfo,
    branches: string[]
  ): { query: string; variables: Record<string, string> } {
    const variableDefs = ['$owner: String!', '$name: String!']
    const fields: string[] = []
    const variables: Record<string, string> = {
      owner: repoInfo.owner,
      name: repoInfo.name,
    }

    for (let i = 0; i < branches.length; i++) {
      const varName = `b${i}`
      variableDefs.push(`$${varName}: String!`)
      variables[varName] = branches[i]
      fields.push(
        `b${i}Open: pullRequests(headRefName: $${varName}, states: OPEN, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ...PrFields }
        }`
      )
      fields.push(
        `b${i}Any: pullRequests(headRefName: $${varName}, states: [OPEN, CLOSED, MERGED], first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
          nodes { ...PrFields }
        }`
      )
    }

    const query = `
      query PrStatuses(${variableDefs.join(', ')}) {
        repository(owner: $owner, name: $name) {
          ${fields.join('\n')}
        }
      }

      fragment PrFields on PullRequest {
        number
        state
        title
        url
        updatedAt
        reviewDecision
        mergeStateStatus
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
              }
            }
          }
        }
      }
    `

    return { query, variables }
  }

  private static hasAuthError(errors: Array<{ message?: string }>): boolean {
    return errors.some(({ message }) => {
      const m = (message ?? '').toLowerCase()
      return (
        m.includes('bad credentials') ||
        m.includes('requires authentication') ||
        m.includes('resource not accessible') ||
        m.includes('could not resolve to a repository')
      )
    })
  }

  private static mapPullRequest(pr: GraphqlPullRequestNode): PrInfo {
    const rawState = pr.state.toLowerCase()
    const state: PrState =
      rawState === 'merged' || rawState === 'closed'
        ? rawState
        : 'open'
    const rollupState = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
    const checkStatus = this.rollupStateToStatus(rollupState)
    const mergeStateStatus = pr.mergeStateStatus?.toUpperCase()
    const isOpen = state === 'open'
    const checksNotPassing = checkStatus === 'pending' || checkStatus === 'failing'
    const reviewDecision = pr.reviewDecision?.toUpperCase()

    return {
      number: pr.number,
      state,
      title: pr.title,
      url: pr.url,
      checkStatus,
      hasPendingComments: false,
      pendingCommentCount: 0,
      isBlockedByCi: isOpen && checksNotPassing && (
        mergeStateStatus ? mergeStateStatus === 'BLOCKED' : true
      ),
      isApproved: isOpen && reviewDecision === 'APPROVED',
      isChangesRequested: isOpen && reviewDecision === 'CHANGES_REQUESTED',
      updatedAt: pr.updatedAt,
    }
  }

  private static reviewThreadCacheKey(
    repoInfo: GithubRepoInfo,
    number: number,
    updatedAt: string
  ): string {
    return `${repoInfo.owner}/${repoInfo.name}#${number}@${updatedAt}`
  }

  private static updateReviewThreadCache(
    repoInfo: GithubRepoInfo,
    number: number,
    updatedAt: string,
    unresolvedCount: number
  ): void {
    const prefix = `${repoInfo.owner}/${repoInfo.name}#${number}@`
    for (const key of this.unresolvedThreadCache.keys()) {
      if (key.startsWith(prefix)) this.unresolvedThreadCache.delete(key)
    }
    this.unresolvedThreadCache.set(
      this.reviewThreadCacheKey(repoInfo, number, updatedAt),
      {
        count: unresolvedCount,
        fetchedAt: Date.now(),
      }
    )
  }

  private static async attachUnresolvedReviewThreads(
    repoInfo: GithubRepoInfo,
    token: string,
    prNode: GraphqlPullRequestNode,
    info: PrInfo
  ): Promise<void> {
    const key = this.reviewThreadCacheKey(repoInfo, prNode.number, prNode.updatedAt)
    const cached = this.unresolvedThreadCache.get(key)
    if (
      cached &&
      Date.now() - cached.fetchedAt < this.UNRESOLVED_THREAD_CACHE_TTL_MS
    ) {
      info.pendingCommentCount = cached.count
      info.hasPendingComments = cached.count > 0
      return
    }

    const unresolvedCount = await this.fetchUnresolvedReviewThreadCount(repoInfo, token, prNode.number)
    info.pendingCommentCount = unresolvedCount
    info.hasPendingComments = unresolvedCount > 0
    this.updateReviewThreadCache(repoInfo, prNode.number, prNode.updatedAt, unresolvedCount)
  }

  private static async fetchUnresolvedReviewThreadCount(
    repoInfo: GithubRepoInfo,
    token: string,
    number: number
  ): Promise<number> {
    let cursor: string | null = null
    let unresolvedCount = 0

    while (true) {
      const query = `
        query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                nodes {
                  isResolved
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        }
      `

      const payload = await this.fetchGraphqlJson<GraphqlReviewThreadsResponse>(query, {
        owner: repoInfo.owner,
        name: repoInfo.name,
        number,
        cursor,
      }, token)

      const threads = payload.data?.repository?.pullRequest?.reviewThreads
      if (!threads) return 0

      const nodes = Array.isArray(threads.nodes) ? threads.nodes : []
      unresolvedCount += nodes.filter((thread) => !thread.isResolved).length

      if (!threads.pageInfo?.hasNextPage) {
        return unresolvedCount
      }
      cursor = threads.pageInfo.endCursor ?? null
      if (!cursor) {
        return unresolvedCount
      }
    }
  }

  private static async fetchGraphqlJson<T extends { errors?: Array<{ message?: string }> }>(
    query: string,
    variables: Record<string, string | number | null>,
    token: string
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    let response: Response
    try {
      response = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'constellagent-desktop',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 401 || response.status === 403) {
      throw new GithubAuthError(`GitHub API auth failed (${response.status})`)
    }
    if (!response.ok) {
      throw new Error(`GitHub API request failed (${response.status})`)
    }

    const payload = await response.json() as T
    if (payload.errors && payload.errors.length > 0) {
      if (this.hasAuthError(payload.errors)) {
        throw new GithubAuthError(payload.errors[0]?.message ?? 'GitHub auth error')
      }
      throw new Error(payload.errors[0]?.message ?? 'GraphQL query failed')
    }

    return payload
  }

  private static rollupStateToStatus(rollupState: string | undefined): CheckStatus {
    const state = rollupState?.toUpperCase()
    if (!state) return 'none'
    if (state === 'FAILURE' || state === 'ERROR') return 'failing'
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
    if (state === 'SUCCESS') return 'passing'
    return 'none'
  }
}
