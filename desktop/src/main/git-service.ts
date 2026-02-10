import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { promisify } from 'util'
import { basename, dirname, join, resolve } from 'path'

const execFileAsync = promisify(execFile)

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

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trimEnd()
}

/** Extract a user-friendly message from a git exec error */
function friendlyGitError(err: unknown, fallback: string): string {
  const stderr = (err as any)?.stderr as string | undefined
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

export class GitService {
  static async listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
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
        worktrees.push(info as WorktreeInfo)
      }
    }
    return worktrees
  }

  static async createWorktree(
    repoPath: string,
    name: string,
    branch: string,
    newBranch: boolean,
    force = false
  ): Promise<string> {
    const parentDir = dirname(repoPath)
    const repoName = basename(repoPath)
    const worktreePath = resolve(parentDir, `${repoName}-ws-${name}`)

    // Clean up stale worktree refs
    await git(['worktree', 'prune'], repoPath).catch(() => {})

    if (existsSync(worktreePath)) {
      if (!force) {
        throw new Error('WORKTREE_PATH_EXISTS')
      }
      await rm(worktreePath, { recursive: true, force: true })
    }

    // Pre-check if branch exists so we never need -b retry
    const branchExists = await git(['rev-parse', '--verify', `refs/heads/${branch}`], repoPath)
      .then(() => true, () => false)

    const args = ['worktree', 'add']
    if (force) args.push('--force')
    if (newBranch && !branchExists) {
      args.push('-b', branch)
    }
    args.push(worktreePath)
    if (!newBranch || branchExists) {
      args.push(branch)
    }

    try {
      await git(args, repoPath)
    } catch (err) {
      const msg = friendlyGitError(err, 'Failed to create worktree')
      if (msg === 'BRANCH_CHECKED_OUT' && !force) throw new Error(msg)
      throw new Error(msg)
    }
    return worktreePath
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
    return git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
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
