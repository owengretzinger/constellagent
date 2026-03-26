import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { copyFile, mkdir, readdir, rm } from 'fs/promises'
import { promisify } from 'util'
import { basename, dirname, join, resolve } from 'path'
import type { GraphiteBranchInfo, GraphiteStackInfo } from '../shared/graphite-types'

const execFileAsync = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trimEnd()
}

/**
 * Parse graphite branch metadata from git config.
 * Returns a map of branchName → parentBranch.
 */
async function parseGraphiteMetadata(repoPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const output = await git(['config', '--get-regexp', '^graphite\\.branch\\.'], repoPath)
    // Lines like: graphite.branch.feat-x.parent main
    for (const line of output.split('\n')) {
      if (!line) continue
      // graphite.branch.<name>.parent <value>
      const match = line.match(/^graphite\.branch\.(.+)\.parent\s+(.+)$/)
      if (match) {
        map.set(match[1], match[2])
      }
    }
  } catch {
    // No graphite metadata or git config error — return empty map
  }
  return map
}

/**
 * Build a linear stack chain containing a given branch.
 * Walks up from the branch to find the root, then walks down to find the full chain.
 */
function buildStackChain(
  branchName: string,
  parentMap: Map<string, string>,
): GraphiteBranchInfo[] | null {
  // Check if branch is in the graphite metadata
  if (!parentMap.has(branchName)) return null

  // Build child map (parent → children)
  const childMap = new Map<string, string[]>()
  for (const [child, parent] of parentMap) {
    const children = childMap.get(parent) ?? []
    children.push(child)
    childMap.set(parent, children)
  }

  // Walk up to find root (a branch whose parent is not itself a graphite branch)
  let root = branchName
  const visited = new Set<string>()
  while (parentMap.has(root) && !visited.has(root)) {
    visited.add(root)
    const parent = parentMap.get(root)!
    if (!parentMap.has(parent)) {
      // parent is the trunk (e.g. main) — root stays as current
      break
    }
    root = parent
  }

  // Walk down from root to build the chain
  const chain: GraphiteBranchInfo[] = []
  let current: string | undefined = root
  const chainVisited = new Set<string>()
  while (current && !chainVisited.has(current)) {
    chainVisited.add(current)
    chain.push({
      name: current,
      parent: parentMap.get(current) ?? null,
    })
    // Find the next child in the chain
    const children: string[] = childMap.get(current) ?? []
    // If there's exactly one child, follow it. If multiple, prefer the one
    // that's in the ancestry of our target branch.
    if (children.length === 0) break
    if (children.length === 1) {
      current = children[0]
    } else {
      // Multiple children — find the one that leads to branchName
      current = children.find((c: string) => {
        let walk: string | undefined = branchName
        const walkVisited = new Set<string>()
        while (walk && !walkVisited.has(walk)) {
          walkVisited.add(walk)
          if (walk === c) return true
          walk = parentMap.get(walk)
        }
        return false
      }) ?? children[0]
    }
  }

  return chain.length > 0 ? chain : null
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next',
  '.nuxt', '.turbo', '.cache', '.parcel-cache', '__pycache__',
  '.tox', '.venv', 'venv', 'out',
])

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

export class GraphiteService {
  /**
   * Get the graphite stack info for a worktree.
   * Reads graphite metadata from git config, finds the stack containing
   * the current branch, and returns it ordered root → tip.
   */
  static async getStackInfo(repoPath: string, worktreePath: string): Promise<GraphiteStackInfo | null> {
    const parentMap = await parseGraphiteMetadata(repoPath)
    if (parentMap.size === 0) return null

    let currentBranch: string
    try {
      currentBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath)
    } catch {
      return null
    }
    if (!currentBranch || currentBranch === 'HEAD') return null

    const chain = buildStackChain(currentBranch, parentMap)
    if (!chain) return null

    return { branches: chain, currentBranch }
  }

  /**
   * Checkout a branch in the given worktree.
   */
  static async checkoutBranch(worktreePath: string, branch: string): Promise<string> {
    await git(['checkout', branch], worktreePath)
    return branch
  }

  /**
   * Clone an entire Graphite stack into a new worktree.
   * Creates a worktree at the tip branch, then creates local tracking branches for the rest.
   */
  static async cloneStack(
    repoPath: string,
    name: string,
    prBranches: { name: string; parent: string | null }[],
  ): Promise<{ worktreePath: string; branch: string }> {
    if (prBranches.length === 0) throw new Error('No branches in stack')

    // Fetch latest
    await git(['fetch', '--prune', 'origin'], repoPath).catch(() => {})

    const tipBranch = prBranches[prBranches.length - 1].name
    const parentDir = dirname(repoPath)
    const repoName = basename(repoPath)
    const safeName = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 80) || 'stack'
    const worktreePath = resolve(parentDir, `${repoName}-ws-${safeName}`)

    // Clean stale worktree refs
    await git(['worktree', 'prune'], repoPath).catch(() => {})

    // Remove existing directory if present
    if (existsSync(worktreePath)) {
      await rm(worktreePath, { recursive: true, force: true })
    }

    // Check if tip branch exists locally
    const tipExists = await git(['rev-parse', '--verify', `refs/heads/${tipBranch}`], repoPath)
      .then(() => true, () => false)

    // Create worktree at tip
    if (tipExists) {
      await git(['worktree', 'add', worktreePath, tipBranch], repoPath)
    } else {
      // Create from remote tracking branch
      const remoteExists = await git(['rev-parse', '--verify', `refs/remotes/origin/${tipBranch}`], repoPath)
        .then(() => true, () => false)
      if (remoteExists) {
        await git(['worktree', 'add', '-b', tipBranch, worktreePath, `origin/${tipBranch}`], repoPath)
      } else {
        throw new Error(`Branch "${tipBranch}" not found locally or on origin`)
      }
    }

    // Create local tracking branches for all non-tip branches
    for (const entry of prBranches) {
      if (entry.name === tipBranch) continue
      const exists = await git(['rev-parse', '--verify', `refs/heads/${entry.name}`], repoPath)
        .then(() => true, () => false)
      if (!exists) {
        const remoteExists = await git(['rev-parse', '--verify', `refs/remotes/origin/${entry.name}`], repoPath)
          .then(() => true, () => false)
        if (remoteExists) {
          await git(['branch', '--track', entry.name, `origin/${entry.name}`], repoPath).catch(() => {})
        }
      }
    }

    // Write graphite parent metadata so the stack is discoverable
    for (const entry of prBranches) {
      if (entry.parent != null) {
        await git(
          ['config', `graphite.branch.${entry.name}.parent`, entry.parent],
          repoPath,
        ).catch(() => {})
      }
    }

    // Copy .env files from main repo
    await copyEnvFiles(repoPath, worktreePath, repoPath)

    return { worktreePath, branch: tipBranch }
  }

  /**
   * Discover the graphite stack containing a given PR branch.
   * Fetches from origin first to ensure branches are up to date.
   */
  static async getStackForPr(
    repoPath: string,
    prBranch: string,
  ): Promise<{ name: string; parent: string | null }[] | null> {
    // Fetch to get latest remote branches and graphite config
    await git(['fetch', '--prune', 'origin'], repoPath).catch(() => {})

    const parentMap = await parseGraphiteMetadata(repoPath)
    if (parentMap.size === 0) return null

    const chain = buildStackChain(prBranch, parentMap)
    if (!chain) return null

    return chain.map((b) => ({ name: b.name, parent: b.parent }))
  }
}
