import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, rm, writeFile } from 'fs/promises'
import { promisify } from 'util'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type { CreateWorktreeProgress } from '../shared/workspace-creation'
import type { GitLogEntry } from '../shared/git-types'
import type { SyncProgress, SyncResult } from '../shared/sync-types'
import { SKIP_DIRS as FILE_SKIP_DIRS } from './file-service'

const execFileAsync = promisify(execFile)

type CreateWorktreeProgressReporter = (progress: CreateWorktreeProgress) => void

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  isBare: boolean
  /** Set when git porcelain includes a standalone `detached` line (not on any branch) */
  isDetached?: boolean
}

export interface FileStatus {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

export interface FileDiff {
  path: string
  hunks: string // raw unified diff text
}

export interface PrWorktreeResult {
  worktreePath: string
  branch: string
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trimEnd()
}

/** Extract a user-friendly message from a git exec error */
function friendlyGitError(err: unknown, fallback: string): string {
  const stderr =
    typeof err === 'object' && err !== null && 'stderr' in err
      ? String((err as { stderr?: unknown }).stderr ?? '')
      : undefined
  if (!stderr) return fallback

  // "fatal: 'branch' is already used by worktree at '/path'"
  const alreadyUsed = stderr.match(/fatal: '([^']+)' is already (?:checked out|used by worktree) at '([^']+)'/)
  if (alreadyUsed) return 'BRANCH_CHECKED_OUT'

  // "fatal: invalid reference: branch-name"
  if (stderr.includes('invalid reference')) {
    const ref = stderr.match(/invalid reference: (.+)/)?.[1]?.trim()
    return ref ? `Branch "${ref}" not found` : 'Branch not found'
  }

  // "fatal: a branch named 'X' already exists"
  if (stderr.includes('a branch named')) return 'BRANCH_ALREADY_EXISTS'

  // "fatal: '/path' already exists"
  if (stderr.includes('already exists')) return 'WORKTREE_PATH_EXISTS'

  // "fatal: not a git repository"
  if (stderr.includes('not a git repository')) return 'Not a git repository'

  // Generic: grab the fatal line
  const fatal = stderr.match(/fatal: (.+)/)?.[1]?.trim()
  if (fatal) return fatal

  return fallback
}

/** Sanitize user-facing workspace names for safe filesystem directory names */
function sanitizeWorktreeName(name: string): string {
  const sanitized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80)
  return sanitized || 'workspace'
}

function ensureWithinParent(parentDir: string, candidatePath: string): void {
  const relPath = relative(parentDir, candidatePath)
  if (relPath.startsWith('..') || isAbsolute(relPath)) {
    throw new Error('Invalid workspace name')
  }
}

const SKIP_DIRS = new Set([...FILE_SKIP_DIRS, 'out'])
const DEFAULT_GITIGNORE = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.DS_Store',
  '*.log',
].join('\n') + '\n'

async function copyEnvFiles(dir: string, destRoot: string, srcRoot: string): Promise<void> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
        await copyEnvFiles(join(dir, entry.name), destRoot, srcRoot)
      } else if (entry.isFile() && entry.name.startsWith('.env')) {
        const rel = join(dir, entry.name).slice(srcRoot.length + 1)
        const dest = join(destRoot, rel)
        if (!existsSync(dest)) {
          await mkdir(dirname(dest), { recursive: true }).catch(() => {})
          await copyFile(join(dir, entry.name), dest).catch(() => {})
        }
      }
    }
  } catch {}
}

function reportCreateWorktreeProgress(
  onProgress: CreateWorktreeProgressReporter | undefined,
  progress: CreateWorktreeProgress
): void {
  onProgress?.(progress)
}

export class GitService {
  private static async hasRemote(repoPath: string, remoteName: string): Promise<boolean> {
    return git(['remote', 'get-url', remoteName], repoPath).then(
      () => true,
      () => false,
    )
  }

  static async isGitRepo(dirPath: string): Promise<boolean> {
    return git(['rev-parse', '--show-toplevel'], dirPath).then(
      () => true,
      () => false,
    )
  }

  static async initRepo(dirPath: string): Promise<void> {
    if (await this.isGitRepo(dirPath)) {
      throw new Error('Directory is already inside a git repository')
    }

    try {
      await git(['init'], dirPath)

      const gitignorePath = join(dirPath, '.gitignore')
      if (!existsSync(gitignorePath)) {
        await writeFile(gitignorePath, DEFAULT_GITIGNORE, 'utf-8')
      }

      await git(['add', '.gitignore'], dirPath)
      await git([
        '-c', 'user.name=Constellagent',
        '-c', 'user.email=noreply@constellagent',
        'commit',
        '--no-gpg-sign',
        '--no-verify',
        '-m', 'Initial commit',
      ], dirPath)
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Failed to initialize repository'))
    }
  }

  static async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const cwd = (repoPath ?? '').trim()
    if (!cwd.length) return []
    if (!existsSync(cwd)) return []

    let output: string
    try {
      output = await git(['worktree', 'list', '--porcelain'], cwd)
    } catch {
      // Stale/moved projects, non-repo folders, or empty IPC path — avoid throwing and
      // spamming Electron's "Error occurred in handler for 'git:list-worktrees'" log.
      return []
    }
    if (!output) return []

    const worktrees: WorktreeInfo[] = []
    const blocks = output.split('\n\n')

    for (const block of blocks) {
      const lines = block.split('\n')
      const info: Partial<WorktreeInfo> = { isBare: false, isDetached: false }
      for (const line of lines) {
        if (line.startsWith('worktree ')) info.path = line.slice(9)
        else if (line.startsWith('HEAD ')) info.head = line.slice(5)
        else if (line.startsWith('branch ')) info.branch = line.slice(7).replace('refs/heads/', '')
        else if (line === 'bare') info.isBare = true
        else if (line === 'detached') info.isDetached = true
      }
      if (info.path) {
        worktrees.push({
          path: info.path,
          branch: info.branch ?? '',
          head: info.head ?? '',
          isBare: info.isBare ?? false,
          isDetached: info.isDetached || undefined,
        })
      }
    }
    return worktrees
  }

  /** Sanitize a string into a valid git branch name */
  static sanitizeBranchName(name: string): string {
    return name
      .trim()
      .replace(/\s+/g, '-')       // spaces → dashes
      .replace(/\.{2,}/g, '-')    // consecutive dots (..)
      .replace(/[\x00-\x1f\x7f~^:?*[\]\\]/g, '-') // control chars & git-illegal chars
      .replace(/\/{2,}/g, '/')    // collapse consecutive slashes
      .replace(/\/\./g, '/-')     // no component starting with dot
      .replace(/@\{/g, '-')       // no @{
      .replace(/\.lock(\/|$)/g, '-lock$1') // no .lock component
      .replace(/^[.\-/]+/, '')    // no leading dot, dash, or slash
      .replace(/[.\-/]+$/, '')    // no trailing dot, dash, or slash
  }

  static async getDefaultBranch(repoPath: string): Promise<string> {
    const hasOrigin = await this.hasRemote(repoPath, 'origin')

    if (hasOrigin) {
      // Best effort sync of origin/HEAD. Network hiccups should not block worktree creation.
      await git(['remote', 'set-head', 'origin', '--auto'], repoPath).catch(() => {})

      const ref = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath).catch(() => '')
      // "refs/remotes/origin/main" → "origin/main"
      if (ref) return ref.replace('refs/remotes/', '')

      // Fallback for repos where origin/HEAD is unset.
      for (const candidate of ['origin/main', 'origin/master']) {
        const exists = await git(['rev-parse', '--verify', `refs/remotes/${candidate}`], repoPath)
          .then(() => true, () => false)
        if (exists) return candidate
      }
    }

    const local = await git(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath).catch(() => '')
    if (local && local !== 'HEAD') return local

    for (const candidate of ['main', 'master']) {
      const exists = await git(['rev-parse', '--verify', `refs/heads/${candidate}`], repoPath)
        .then(() => true, () => false)
      if (exists) return candidate
    }

    return 'main'
  }

  static async createWorktree(
    repoPath: string,
    name: string,
    branch: string,
    newBranch: boolean,
    baseBranch?: string,
    force = false,
    onProgress?: CreateWorktreeProgressReporter
  ): Promise<string> {
    const requestedBranch = branch.trim()
    branch = GitService.sanitizeBranchName(requestedBranch)
    if (!branch) throw new Error('Branch name is empty after sanitization')

    const parentDir = dirname(repoPath)
    const repoName = basename(repoPath)
    const safeWorktreeName = sanitizeWorktreeName(name)
    const worktreePath = resolve(parentDir, `${repoName}-ws-${safeWorktreeName}`)
    ensureWithinParent(parentDir, worktreePath)

    // Clean up stale worktree refs
    reportCreateWorktreeProgress(onProgress, {
      stage: 'prune-worktrees',
      message: 'Cleaning stale worktree references...',
    })
    await git(['worktree', 'prune'], repoPath).catch(() => {})

    const hasOrigin = await GitService.hasRemote(repoPath, 'origin')

    // Fetch remote refs so worktree branches from latest state
    reportCreateWorktreeProgress(onProgress, {
      stage: 'fetch-origin',
      message: hasOrigin ? 'Syncing remote...' : 'No origin remote found; using local refs...',
    })
    if (hasOrigin) {
      // Best effort: local repos (or temporary network failures) should still work.
      await git(['fetch', '--prune', 'origin'], repoPath).catch(() => {})
    }

    // Auto-detect base branch when creating a new branch without explicit base
    if (newBranch && !baseBranch) {
      reportCreateWorktreeProgress(onProgress, {
        stage: 'resolve-default-branch',
        message: 'Resolving default base branch...',
      })
      baseBranch = await GitService.getDefaultBranch(repoPath)
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'prepare-worktree-dir',
      message: 'Preparing worktree directory...',
    })
    if (existsSync(worktreePath)) {
      if (!force) {
        throw new Error('WORKTREE_PATH_EXISTS')
      }
      await rm(worktreePath, { recursive: true, force: true })
    }

    // Pre-check if branch exists so we never need -b retry
    reportCreateWorktreeProgress(onProgress, {
      stage: 'inspect-branch',
      message: 'Checking branch state...',
    })
    let branchExists = await git(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath)
      .then(() => true, () => false)

    // If checking out an existing branch that doesn't exist locally or on origin,
    // try fetching it as a GitHub PR branch (fork PRs aren't included in normal fetch)
    if (!newBranch && !branchExists) {
      const remoteExists = hasOrigin
        ? await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], repoPath)
            .then(() => true, () => false)
        : false
      if (!remoteExists) {
        try {
          const headCandidates = [requestedBranch]
          if (requestedBranch.includes(':')) {
            const prBranch = requestedBranch.split(':')[1]
            if (prBranch && !headCandidates.includes(prBranch)) headCandidates.push(prBranch)
          }
          if (!headCandidates.includes(branch)) headCandidates.push(branch)

          let prNumber = ''
          for (const headCandidate of headCandidates) {
            const { stdout } = await execFileAsync('gh', [
              // Resolve repo from cwd for broad gh CLI compatibility.
              'pr', 'list', '--head', headCandidate, '--json', 'number',
              '--jq', '.[0].number',
            ], { cwd: repoPath })
            prNumber = stdout.trim()
            if (prNumber) break
          }
          if (prNumber) {
            await git(['fetch', 'origin', `pull/${prNumber}/head:${branch}`], repoPath)
            branchExists = true
          }
        } catch {
          // gh not available or no matching PR — fall through to normal error
        }
      }
    }

    const args = ['worktree', 'add']
    if (force) args.push('--force')
    if (newBranch && !branchExists) {
      args.push('-b', branch, worktreePath)
      if (baseBranch) args.push(baseBranch)
    } else {
      args.push(worktreePath, branch)
    }

    try {
      reportCreateWorktreeProgress(onProgress, {
        stage: 'create-worktree',
        message: 'Creating worktree...',
      })
      await git(args, repoPath)
    } catch (err) {
      const msg = friendlyGitError(err, 'Failed to create worktree')
      if (msg === 'BRANCH_CHECKED_OUT' && !force) throw new Error(msg)
      throw new Error(msg)
    }

    // Fast-forward existing branches to match upstream
    if (!newBranch || branchExists) {
      reportCreateWorktreeProgress(onProgress, {
        stage: 'sync-branch',
        message: 'Fast-forwarding branch...',
      })
      await git(['pull', '--ff-only'], worktreePath).catch(() => {})
    }

    // Copy .env files that are missing from the worktree (gitignored) from the main repo
    reportCreateWorktreeProgress(onProgress, {
      stage: 'copy-env-files',
      message: 'Copying env files...',
    })
    await copyEnvFiles(repoPath, worktreePath, repoPath)

    return worktreePath
  }

  static async createWorktreeFromPr(
    repoPath: string,
    name: string,
    prNumber: number,
    localBranch: string,
    force = false,
    onProgress?: CreateWorktreeProgressReporter
  ): Promise<PrWorktreeResult> {
    const parsedPrNumber = Number(prNumber)
    if (!Number.isInteger(parsedPrNumber) || parsedPrNumber <= 0) {
      throw new Error('Invalid pull request number')
    }

    const requestedBranch = localBranch.trim()
    const branch = GitService.sanitizeBranchName(requestedBranch)
    if (!branch) throw new Error('Branch name is empty after sanitization')

    const parentDir = dirname(repoPath)
    const repoName = basename(repoPath)
    const safeWorktreeName = sanitizeWorktreeName(name)
    const worktreePath = resolve(parentDir, `${repoName}-ws-${safeWorktreeName}`)
    ensureWithinParent(parentDir, worktreePath)

    reportCreateWorktreeProgress(onProgress, {
      stage: 'prune-worktrees',
      message: 'Cleaning stale worktree references...',
    })
    await git(['worktree', 'prune'], repoPath).catch(() => {})

    const hasOrigin = await GitService.hasRemote(repoPath, 'origin')
    if (!hasOrigin) {
      throw new Error('No origin remote found')
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'fetch-origin',
      message: `Fetching PR #${parsedPrNumber}...`,
    })
    try {
      await git(['fetch', '--prune', 'origin'], repoPath).catch(() => {})
      await git(['fetch', 'origin', `+pull/${parsedPrNumber}/head:${branch}`], repoPath)
    } catch (err) {
      const msg = friendlyGitError(err, `Failed to fetch PR #${parsedPrNumber}`)
      if (msg.includes('couldn\'t find remote ref') || msg.includes('no such remote ref')) {
        throw new Error(`Pull request #${parsedPrNumber} not found`)
      }
      throw new Error(msg)
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'prepare-worktree-dir',
      message: 'Preparing worktree directory...',
    })
    if (existsSync(worktreePath)) {
      if (!force) {
        throw new Error('WORKTREE_PATH_EXISTS')
      }
      await rm(worktreePath, { recursive: true, force: true })
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'create-worktree',
      message: 'Creating worktree...',
    })
    const args = ['worktree', 'add']
    if (force) args.push('--force')
    args.push(worktreePath, branch)

    try {
      await git(args, repoPath)
    } catch (err) {
      const msg = friendlyGitError(err, 'Failed to create worktree')
      if (msg === 'BRANCH_CHECKED_OUT' && !force) throw new Error(msg)
      throw new Error(msg)
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'sync-branch',
      message: 'Fast-forwarding branch...',
    })
    await git(['pull', '--ff-only'], worktreePath).catch(() => {})

    reportCreateWorktreeProgress(onProgress, {
      stage: 'copy-env-files',
      message: 'Copying env files...',
    })
    await copyEnvFiles(repoPath, worktreePath, repoPath)

    return { worktreePath, branch }
  }

  static async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      await git(['worktree', 'remove', worktreePath, '--force'], repoPath)
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Failed to remove worktree'))
    }
  }

  static async getTopLevel(cwd: string): Promise<string> {
    return git(['rev-parse', '--show-toplevel'], cwd)
  }

  static async getCurrentBranch(worktreePath: string): Promise<string> {
    if (!existsSync(worktreePath)) return ''
    try {
      return await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
    } catch {
      return ''
    }
  }

  static async getStatus(worktreePath: string): Promise<FileStatus[]> {
    const output = await git(
      ['status', '--porcelain=v1', '-uall'],
      worktreePath
    )
    if (!output) return []

    const results: FileStatus[] = []

    /** Porcelain rename/copy lines use `ORIG -> DEST`; use worktree destination path. */
    const porcelainPath = (raw: string): string => {
      const arrow = ' -> '
      const i = raw.lastIndexOf(arrow)
      return i >= 0 ? raw.slice(i + arrow.length).trim() : raw
    }

    for (const line of output.split('\n')) {
      const indexStatus = line[0]
      const workStatus = line[1]
      const path = porcelainPath(line.slice(3))

      if (indexStatus === '?' && workStatus === '?') {
        results.push({ path, status: 'untracked', staged: false })
        continue
      }

      // Staged entry (index has a real status)
      if (indexStatus !== ' ' && indexStatus !== '?') {
        const status: FileStatus['status'] =
          indexStatus === 'A' ? 'added' :
          indexStatus === 'D' ? 'deleted' :
          indexStatus === 'R' ? 'renamed' : 'modified'
        results.push({ path, status, staged: true })
      }

      // Unstaged entry (worktree has a real status)
      if (workStatus !== ' ' && workStatus !== '?') {
        const status: FileStatus['status'] =
          workStatus === 'D' ? 'deleted' : 'modified'
        results.push({ path, status, staged: false })
      }
    }

    return results
  }

  static async getDiff(worktreePath: string, staged: boolean): Promise<FileDiff[]> {
    const args = ['diff']
    if (staged) args.push('--staged')
    args.push('--unified=3')

    const output = await git(args, worktreePath)
    if (!output) return []

    // Split by file boundaries
    const files: FileDiff[] = []
    const parts = output.split(/^diff --git /m).filter(Boolean)

    for (const part of parts) {
      const firstLine = part.split('\n')[0]
      // Extract b/path from "a/path b/path"
      const match = firstLine.match(/b\/(.+)$/)
      if (match) {
        files.push({
          path: match[1],
          hunks: 'diff --git ' + part,
        })
      }
    }

    return files
  }

  static async getFileDiff(worktreePath: string, filePath: string): Promise<string> {
    try {
      // Try unstaged first
      const unstaged = await git(['diff', '--', filePath], worktreePath)
      if (unstaged) return unstaged
      // Then staged
      return await git(['diff', '--staged', '--', filePath], worktreePath)
    } catch {
      return ''
    }
  }

  static async getBranches(repoPath: string): Promise<string[]> {
    const [localOut, remoteOut] = await Promise.all([
      git(['branch', '--list', '--format=%(refname:short)'], repoPath),
      git(['branch', '-r', '--format=%(refname:short)'], repoPath).catch(() => ''),
    ])
    const seen = new Set<string>()
    const branches: string[] = []
    // Add local branches first
    for (const name of localOut.split('\n').filter(Boolean)) {
      seen.add(name)
      branches.push(name)
    }
    // Add remote branches, stripping remote prefix and deduplicating
    for (const raw of remoteOut.split('\n').filter(Boolean)) {
      if (raw.endsWith('/HEAD')) continue
      // "origin/feature-x" → "feature-x", "origin/feat/sub" → "feat/sub"
      const slash = raw.indexOf('/')
      const name = slash >= 0 ? raw.slice(slash + 1) : raw
      if (!seen.has(name)) {
        seen.add(name)
        branches.push(name)
      }
    }
    return branches
  }

  static async stage(worktreePath: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await git(['add', '--', ...paths], worktreePath)
  }

  static async unstage(worktreePath: string, paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await git(['reset', 'HEAD', '--', ...paths], worktreePath)
  }

  static async discard(worktreePath: string, paths: string[], untracked: string[]): Promise<void> {
    if (paths.length > 0) {
      await git(['checkout', '--', ...paths], worktreePath)
    }
    if (untracked.length > 0) {
      await git(['clean', '-f', '--', ...untracked], worktreePath)
    }
  }

  static async commit(worktreePath: string, message: string): Promise<void> {
    await git(['commit', '-m', message], worktreePath)
  }

  static async showFileAtHead(worktreePath: string, filePath: string): Promise<string | null> {
    try {
      return await git(['show', 'HEAD:' + filePath], worktreePath)
    } catch {
      return null // File is new/untracked
    }
  }

  static async getLog(worktreePath: string, maxCount = 80): Promise<GitLogEntry[]> {
    // Use git's %x00 escape so no literal null bytes appear in the argument string
    // (Node.js execFile rejects strings containing \x00)
    const format = '%H%x00%P%x00%s%x00%D%x00%an%x00%ar'
    const output = await git(
      ['log', '--all', '--topo-order', `--format=${format}`, '-n', String(maxCount)],
      worktreePath,
    )
    if (!output) return []

    const SEP = '\x00' // git outputs actual null bytes
    const entries: GitLogEntry[] = []
    for (const line of output.split('\n')) {
      if (!line) continue
      const parts = line.split(SEP)
      if (parts.length < 6) continue
      entries.push({
        hash: parts[0],
        parents: parts[1] ? parts[1].split(' ') : [],
        message: parts[2],
        refs: parts[3] ? parts[3].split(', ').map((r) => r.trim()).filter(Boolean) : [],
        author: parts[4],
        relativeDate: parts[5],
      })
    }
    return entries
  }

  static async getRemoteHeadHash(repoPath: string, branch: string): Promise<string> {
    const output = await git(['ls-remote', '--heads', 'origin', branch], repoPath)
    if (!output) return ''
    return output.split(/\s/)[0] || ''
  }

  static async syncWorktree(
    worktreePath: string,
    defaultBranch: string,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncResult> {
    const report = (stage: SyncProgress['stage'], message: string) =>
      onProgress?.({ worktreePath, stage, message })

    let didStash = false
    try {
      // Check if dirty
      report('stash', 'Checking for uncommitted changes...')
      const status = await git(['status', '--porcelain'], worktreePath)
      if (status.trim()) {
        await git(['stash', 'push', '-m', 'constellagent-sync'], worktreePath)
        didStash = true
      }

      // Fetch
      report('fetch', 'Fetching from origin...')
      await git(['fetch', 'origin'], worktreePath)

      // Rebase
      report('rebase', `Rebasing onto ${defaultBranch}...`)
      try {
        await git(['rebase', defaultBranch], worktreePath)
      } catch (rebaseErr) {
        // Abort rebase and restore stash
        await git(['rebase', '--abort'], worktreePath).catch(() => {})
        if (didStash) {
          await git(['stash', 'pop'], worktreePath).catch(() => {})
        }
        report('error', 'Rebase failed — aborted and restored')
        return {
          worktreePath,
          success: false,
          error: friendlyGitError(rebaseErr, 'Rebase failed'),
        }
      }

      // Stash pop
      if (didStash) {
        report('stash-pop', 'Restoring stashed changes...')
        try {
          await git(['stash', 'pop'], worktreePath)
        } catch {
          report('error', 'Stash pop had conflicts')
          return {
            worktreePath,
            success: true,
            stashPopConflict: true,
          }
        }
      }

      report('done', 'Sync complete')
      return { worktreePath, success: true }
    } catch (err) {
      report('error', friendlyGitError(err, 'Sync failed'))
      return {
        worktreePath,
        success: false,
        error: friendlyGitError(err, 'Sync failed'),
      }
    }
  }

  static async syncAllWorktrees(
    repoPath: string,
    onProgress?: (progress: SyncProgress) => void,
  ): Promise<SyncResult[]> {
    const defaultBranch = await GitService.getDefaultBranch(repoPath)
    const worktrees = await GitService.listWorktrees(repoPath)

    // Filter out bare worktrees and the one on the default branch
    const defaultBranchShort = defaultBranch.replace(/^origin\//, '')
    const toSync = worktrees.filter(
      (wt) => !wt.isBare && wt.branch !== defaultBranchShort,
    )

    const results: SyncResult[] = []
    for (const wt of toSync) {
      const result = await GitService.syncWorktree(wt.path, defaultBranch, onProgress)
      results.push(result)
    }
    return results
  }

  static async getCommitDiff(worktreePath: string, hash: string): Promise<string> {
    try {
      return await git(['show', '--format=', '--patch', hash], worktreePath)
    } catch {
      // Object may not be available locally (e.g. remote-only ref in a worktree).
      // Try fetching the object first, then retry.
      try {
        await git(['fetch', '--depth=1', 'origin', hash], worktreePath)
        return await git(['show', '--format=', '--patch', hash], worktreePath)
      } catch {
        return '' // Object is unreachable — return empty diff
      }
    }
  }

  /** Remote hash pointed to by origin HEAD (default branch tip). No fetch. */
  static async getRemoteHead(repoPath: string): Promise<string | null> {
    const hasOrigin = await this.hasRemote(repoPath, 'origin')
    if (!hasOrigin) return null
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', 'origin', 'HEAD'], {
        cwd: repoPath,
        maxBuffer: 1024 * 1024,
      })
      const line = stdout.trim().split('\n')[0]
      if (!line) return null
      const hash = line.split('\t')[0]?.trim()
      return hash || null
    } catch {
      return null
    }
  }

  /** Best-effort fetch so local origin/* matches remote before rebase. */
  static async fetchOrigin(repoPath: string): Promise<void> {
    const hasOrigin = await this.hasRemote(repoPath, 'origin')
    if (!hasOrigin) return
    await git(['fetch', '--prune', 'origin'], repoPath).catch(() => {})
  }
}
