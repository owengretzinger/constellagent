import { execFile } from 'child_process'
import { promisify } from 'util'
import type { PrInfo, PrLookupResult, CheckStatus, PrState } from '../shared/github-types'

const execFileAsync = promisify(execFile)

export class GithubService {
  private static ghAvailable: boolean | null = null
  private static repoChecks = new Map<string, boolean>()
  private static cache = new Map<string, { data: PrInfo | null; ts: number }>()
  private static CACHE_TTL = 60_000

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
    const cached = this.repoChecks.get(repoPath)
    if (cached !== undefined) return cached
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
        cwd: repoPath,
        timeout: 5000,
      })
      const isGh = stdout.includes('github.com')
      this.repoChecks.set(repoPath, isGh)
      return isGh
    } catch {
      this.repoChecks.set(repoPath, false)
      return false
    }
  }

  static async getPrStatuses(repoPath: string, branches: string[]): Promise<PrLookupResult> {
    if (!(await this.isGhAvailable())) {
      return { available: false, error: 'gh_not_installed', data: {} }
    }
    if (!(await this.isGithubRepo(repoPath))) {
      return { available: false, error: 'not_github_repo', data: {} }
    }

    const now = Date.now()
    const result: Record<string, PrInfo | null> = {}
    const uncached: string[] = []

    for (const branch of branches) {
      const key = `${repoPath}:${branch}`
      const cached = this.cache.get(key)
      if (cached && now - cached.ts < this.CACHE_TTL) {
        result[branch] = cached.data
      } else {
        uncached.push(branch)
      }
    }

    const settled = await Promise.allSettled(
      uncached.map((branch) => this.fetchPrForBranch(repoPath, branch))
    )

    for (let i = 0; i < uncached.length; i++) {
      const branch = uncached[i]
      const key = `${repoPath}:${branch}`
      const pr = settled[i].status === 'fulfilled' ? settled[i].value : null
      result[branch] = pr
      this.cache.set(key, { data: pr, ts: now })
    }

    return { available: true, data: result }
  }

  private static async fetchPrForBranch(repoPath: string, branch: string): Promise<PrInfo | null> {
    try {
      // Fetch open PR first — if a branch has multiple PRs (e.g. after rebase
      // onto a new base), we want the current open one, not a stale closed one.
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr', 'list',
          '--head', branch,
          '--state', 'open',
          '--limit', '1',
          '--json', 'number,state,title,url,statusCheckRollup,updatedAt',
        ],
        { cwd: repoPath, timeout: 10_000 }
      )

      let prs = JSON.parse(stdout)

      // No open PR — check for merged/closed (show final state)
      if (!prs || prs.length === 0) {
        const { stdout: allStdout } = await execFileAsync(
          'gh',
          [
            'pr', 'list',
            '--head', branch,
            '--state', 'all',
            '--limit', '5',
            '--json', 'number,state,title,url,statusCheckRollup,updatedAt',
          ],
          { cwd: repoPath, timeout: 10_000 }
        )
        prs = JSON.parse(allStdout)
        if (!prs || prs.length === 0) return null
        // Pick most recently updated
        prs.sort((a: { updatedAt: string }, b: { updatedAt: string }) =>
          b.updatedAt.localeCompare(a.updatedAt)
        )
      }

      const pr = prs[0]
      return {
        number: pr.number,
        state: pr.state.toLowerCase() as PrState,
        title: pr.title,
        url: pr.url,
        checkStatus: this.rollupToStatus(pr.statusCheckRollup),
        updatedAt: pr.updatedAt,
      }
    } catch {
      return null
    }
  }

  private static rollupToStatus(
    rollup: Array<{ status?: string; conclusion?: string; state?: string }> | undefined
  ): CheckStatus {
    if (!rollup || rollup.length === 0) return 'none'

    let hasFailure = false
    let hasPending = false

    for (const check of rollup) {
      const conclusion = check.conclusion?.toUpperCase()
      const state = check.state?.toUpperCase()
      const status = check.status?.toUpperCase()

      if (
        conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'CANCELLED' ||
        state === 'FAILURE' || state === 'ERROR'
      ) {
        hasFailure = true
      } else if (
        status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'PENDING' ||
        state === 'PENDING'
      ) {
        hasPending = true
      }
    }

    if (hasFailure) return 'failing'
    if (hasPending) return 'pending'
    return 'passing'
  }
}
