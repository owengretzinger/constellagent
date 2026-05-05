import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'fs/promises'
import { promisify } from 'util'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import type { CreateWorktreeProgress } from '../shared/workspace-creation'
import type { WorkingTreeDiffEntry, WorkingTreeFileStatus } from '../shared/diff-types'

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
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trimEnd()
}

const SYNTHETIC_PATCH_SIZE_LIMIT = 1024 * 1024 // 1MB

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff', 'tif',
  'pdf',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'dmg', 'pkg',
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'exe', 'dll', 'so', 'dylib', 'wasm', 'bin', 'dat', 'db', 'sqlite',
])

function pathIndicatesBinary(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext || ext === filePath.toLowerCase()) return false
  return BINARY_EXTENSIONS.has(ext)
}

function patchIndicatesBinary(patch: string): boolean {
  if (!patch) return false
  return /^\s*Binary files /m.test(patch) || /^\s*GIT binary patch\b/m.test(patch)
}

function bufferLooksBinary(buf: Buffer): boolean {
  const sampleEnd = Math.min(8192, buf.length)
  for (let i = 0; i < sampleEnd; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

interface PorcelainEntry {
  newPath: string
  oldPath?: string
  xy: string // 2-char from porcelain v2 (e.g. "M.", ".M", "??")
  isUntracked: boolean
}

// Parse `git status --porcelain=v2 -z` output into raw entries. Records are
// NUL-delimited; rename/copy (type 2) entries consume an additional
// NUL-terminated old-path field.
function parsePorcelainV2(output: string): PorcelainEntry[] {
  const result: PorcelainEntry[] = []
  if (!output) return result
  const records = output.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    const head = record[0]
    if (head === '?') {
      result.push({ newPath: record.slice(2), xy: '??', isUntracked: true })
    } else if (head === '!') {
      // ignored — skip
    } else if (head === '1') {
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const path = parts.slice(8).join(' ')
      result.push({ newPath: path, xy, isUntracked: false })
    } else if (head === '2') {
      const parts = record.split(' ')
      const xy = parts[1] ?? '..'
      const newPath = parts.slice(9).join(' ')
      const oldPath = records[i + 1] ?? ''
      i++ // consume old-path record
      result.push({ newPath, oldPath, xy, isUntracked: false })
    } else if (head === 'u') {
      const parts = record.split(' ')
      const xy = parts[1] ?? 'UU'
      const path = parts.slice(10).join(' ')
      result.push({ newPath: path, xy, isUntracked: false })
    }
  }
  return result
}

function statusFromCode(code: string): WorkingTreeFileStatus {
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R' || code === 'C') return 'renamed'
  return 'modified'
}

function combinedStatus(entry: PorcelainEntry): WorkingTreeFileStatus {
  if (entry.isUntracked) return 'untracked'
  const x = entry.xy[0]
  const y = entry.xy[1]
  const pick = x !== '.' && x !== ' ' ? x : y
  return statusFromCode(pick)
}

// Split a unified diff output into a per-new-path map.
function parseDiffByFile(diffOutput: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!diffOutput) return map
  const parts = diffOutput.split(/^diff --git /m).filter(Boolean)
  for (const part of parts) {
    const section = 'diff --git ' + part
    // Prefer `+++ b/path` (most reliable, including for renames)
    const plusMatch = section.match(/^\+\+\+ b\/(.+)$/m)
    if (plusMatch) {
      map.set(plusMatch[1], section)
      continue
    }
    // Pure deletion: extract `a/path` from header line
    const firstLine = part.split('\n')[0]
    const aMatch = firstLine.match(/^a\/(.+?) b\//)
    if (aMatch) {
      map.set(aMatch[1], section)
    }
  }
  return map
}

async function buildUntrackedEntry(
  worktreePath: string,
  path: string
): Promise<WorkingTreeDiffEntry> {
  const fullPath = isAbsolute(path) ? path : join(worktreePath, path)

  if (pathIndicatesBinary(path)) {
    return { path, status: 'untracked', patch: '', isBinary: true, tooLarge: false }
  }

  let fileSize = 0
  try {
    fileSize = (await stat(fullPath)).size
  } catch {
    return { path, status: 'untracked', patch: '', isBinary: false, tooLarge: false }
  }

  if (fileSize > SYNTHETIC_PATCH_SIZE_LIMIT) {
    return { path, status: 'untracked', patch: '', isBinary: false, tooLarge: true }
  }

  let buf: Buffer
  try {
    buf = await readFile(fullPath)
  } catch {
    return { path, status: 'untracked', patch: '', isBinary: false, tooLarge: false }
  }

  if (bufferLooksBinary(buf)) {
    return { path, status: 'untracked', patch: '', isBinary: true, tooLarge: false }
  }

  const lines = buf.toString('utf8').split('\n')
  const patch = [
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n')

  return { path, status: 'untracked', patch, isBinary: false, tooLarge: false }
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
      ['status', '--porcelain=v2', '-z', '-uall'],
      worktreePath
    )
    const entries = parsePorcelainV2(output)
    const results: FileStatus[] = []
    for (const entry of entries) {
      if (entry.isUntracked) {
        results.push({ path: entry.newPath, status: 'untracked', staged: false })
        continue
      }
      const x = entry.xy[0]
      const y = entry.xy[1]
      if (x !== '.' && x !== ' ') {
        results.push({ path: entry.newPath, status: statusFromCode(x), staged: true })
      }
      if (y !== '.' && y !== ' ') {
        results.push({ path: entry.newPath, status: statusFromCode(y), staged: false })
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

  static async getWorkingTreeDiff(worktreePath: string): Promise<WorkingTreeDiffEntry[]> {
    const statusOutput = await git(
      ['status', '--porcelain=v2', '-z', '-uall'],
      worktreePath
    )
    const parsed = parsePorcelainV2(statusOutput)

    // Collapse to one entry per new-path (preserve first occurrence)
    const seen = new Map<string, PorcelainEntry>()
    for (const entry of parsed) {
      if (!seen.has(entry.newPath)) seen.set(entry.newPath, entry)
    }
    const entries = Array.from(seen.values())

    // Single combined diff for all tracked changes (since HEAD)
    let diffByPath = new Map<string, string>()
    let trackedTooLarge = false
    try {
      const diffOutput = await git(
        ['-c', 'core.quotepath=false', 'diff', '-M', 'HEAD'],
        worktreePath
      )
      diffByPath = parseDiffByFile(diffOutput)
    } catch {
      trackedTooLarge = true
    }

    return Promise.all(
      entries.map(async (entry): Promise<WorkingTreeDiffEntry> => {
        if (entry.isUntracked) {
          return buildUntrackedEntry(worktreePath, entry.newPath)
        }

        const status = combinedStatus(entry)
        const path = entry.newPath
        const oldPath = entry.oldPath

        if (trackedTooLarge) {
          return { path, oldPath, status, patch: '', isBinary: false, tooLarge: true }
        }

        let patch = diffByPath.get(path) ?? ''
        const isBinary = patchIndicatesBinary(patch)

        // Pure-deletion fallback (no diff section emitted in some edge cases)
        if (!patch && status === 'deleted') {
          patch = `--- a/${path}\n+++ /dev/null\n@@ -1,0 +0,0 @@\n`
        }

        return { path, oldPath, status, patch, isBinary, tooLarge: false }
      })
    )
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
