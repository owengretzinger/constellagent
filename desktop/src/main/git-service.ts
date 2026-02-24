import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, rm } from 'fs/promises'
import { promisify } from 'util'
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from 'path'
import type { CreateWorktreeProgress } from '../shared/workspace-creation'
import {
  execInPath,
  formatTargetPath,
  parsePathTarget,
  remotePathExists,
  removeRemotePath,
  unwrapPathForTarget,
} from './remote-exec'

const execFileAsync = promisify(execFile)

type CreateWorktreeProgressReporter = (progress: CreateWorktreeProgress) => void

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  isBare: boolean
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
  const { stdout } = await execInPath(cwd, 'git', args, {
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

function ensureWithinParent(
  parentDir: string,
  candidatePath: string,
  relFn: (from: string, to: string) => string = relative,
  isAbsFn: (path: string) => boolean = isAbsolute
): void {
  const relPath = relFn(parentDir, candidatePath)
  if (relPath.startsWith('..') || isAbsFn(relPath)) {
    throw new Error('Invalid workspace name')
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next'])

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

  static async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const target = parsePathTarget(repoPath)
    const output = await git(['worktree', 'list', '--porcelain'], repoPath)
    if (!output) return []

    const worktrees: WorktreeInfo[] = []
    const blocks = output.split('\n\n')

    for (const block of blocks) {
      const lines = block.split('\n')
      const info: Partial<WorktreeInfo> = { isBare: false }
      for (const line of lines) {
        if (line.startsWith('worktree ')) info.path = line.slice(9)
        else if (line.startsWith('HEAD ')) info.head = line.slice(5)
        else if (line.startsWith('branch ')) info.branch = line.slice(7).replace('refs/heads/', '')
        else if (line === 'bare') info.isBare = true
      }
      if (info.path) {
        info.path = formatTargetPath(target, info.path)
        worktrees.push(info as WorktreeInfo)
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

    const target = parsePathTarget(repoPath)
    const repoFsPath = target.kind === 'ssh' ? target.path : repoPath
    const parentDir = target.kind === 'ssh' ? posix.dirname(repoFsPath) : dirname(repoFsPath)
    const repoName = target.kind === 'ssh' ? posix.basename(repoFsPath) : basename(repoFsPath)
    const safeWorktreeName = sanitizeWorktreeName(name)
    const worktreeFsPath = target.kind === 'ssh'
      ? posix.resolve(parentDir, `${repoName}-ws-${safeWorktreeName}`)
      : resolve(parentDir, `${repoName}-ws-${safeWorktreeName}`)
    ensureWithinParent(
      parentDir,
      worktreeFsPath,
      target.kind === 'ssh' ? posix.relative : relative,
      target.kind === 'ssh' ? posix.isAbsolute : isAbsolute
    )
    const worktreePath = formatTargetPath(target, worktreeFsPath)

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
    const worktreeExists = target.kind === 'ssh'
      ? await remotePathExists(target.host, worktreeFsPath)
      : existsSync(worktreeFsPath)
    if (worktreeExists) {
      if (!force) {
        throw new Error('WORKTREE_PATH_EXISTS')
      }
      if (target.kind === 'ssh') {
        await removeRemotePath(target.host, worktreeFsPath)
      } else {
        await rm(worktreeFsPath, { recursive: true, force: true })
      }
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
      if (!remoteExists && target.kind === 'local') {
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
            ], { cwd: repoFsPath })
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
      args.push('-b', branch, worktreeFsPath)
      if (baseBranch) args.push(baseBranch)
    } else {
      args.push(worktreeFsPath, branch)
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
      message: target.kind === 'ssh' ? 'Skipping env copy for SSH worktree...' : 'Copying env files...',
    })
    if (target.kind === 'local') {
      await copyEnvFiles(repoFsPath, worktreeFsPath, repoFsPath)
    }

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

    const target = parsePathTarget(repoPath)
    const repoFsPath = target.kind === 'ssh' ? target.path : repoPath
    const parentDir = target.kind === 'ssh' ? posix.dirname(repoFsPath) : dirname(repoFsPath)
    const repoName = target.kind === 'ssh' ? posix.basename(repoFsPath) : basename(repoFsPath)
    const safeWorktreeName = sanitizeWorktreeName(name)
    const worktreeFsPath = target.kind === 'ssh'
      ? posix.resolve(parentDir, `${repoName}-ws-${safeWorktreeName}`)
      : resolve(parentDir, `${repoName}-ws-${safeWorktreeName}`)
    ensureWithinParent(
      parentDir,
      worktreeFsPath,
      target.kind === 'ssh' ? posix.relative : relative,
      target.kind === 'ssh' ? posix.isAbsolute : isAbsolute
    )
    const worktreePath = formatTargetPath(target, worktreeFsPath)

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
    const worktreeExists = target.kind === 'ssh'
      ? await remotePathExists(target.host, worktreeFsPath)
      : existsSync(worktreeFsPath)
    if (worktreeExists) {
      if (!force) {
        throw new Error('WORKTREE_PATH_EXISTS')
      }
      if (target.kind === 'ssh') {
        await removeRemotePath(target.host, worktreeFsPath)
      } else {
        await rm(worktreeFsPath, { recursive: true, force: true })
      }
    }

    reportCreateWorktreeProgress(onProgress, {
      stage: 'create-worktree',
      message: 'Creating worktree...',
    })
    const args = ['worktree', 'add']
    if (force) args.push('--force')
    args.push(worktreeFsPath, branch)

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
      message: target.kind === 'ssh' ? 'Skipping env copy for SSH worktree...' : 'Copying env files...',
    })
    if (target.kind === 'local') {
      await copyEnvFiles(repoFsPath, worktreeFsPath, repoFsPath)
    }

    return { worktreePath, branch }
  }

  static async removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
    try {
      const target = parsePathTarget(repoPath)
      const worktree = unwrapPathForTarget(target, worktreePath)
      await git(['worktree', 'remove', worktree, '--force'], repoPath)
    } catch (err) {
      throw new Error(friendlyGitError(err, 'Failed to remove worktree'))
    }
  }

  static async getTopLevel(cwd: string): Promise<string> {
    const topLevel = await git(['rev-parse', '--show-toplevel'], cwd)
    const target = parsePathTarget(cwd)
    return target.kind === 'ssh' ? formatTargetPath(target, topLevel) : topLevel
  }

  static async getCurrentBranch(worktreePath: string): Promise<string> {
    const target = parsePathTarget(worktreePath)
    if (target.kind === 'local' && !existsSync(worktreePath)) return ''
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

    for (const line of output.split('\n')) {
      const indexStatus = line[0]
      const workStatus = line[1]
      const path = line.slice(3)

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
}
