import { readdir, readFile as fsReadFile, writeFile as fsWriteFile, stat, rm, copyFile, mkdir } from 'fs/promises'
import { homedir } from 'os'
import { join, basename, relative } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  AGENT_PLAN_RELATIVE_DIRS,
  PLAN_DIR_TO_AGENT,
  AGENT_TO_PLAN_DIR,
  relativePathInWorktree,
} from '../shared/agent-plan-path'
import type { AgentPlanEntry, PlanAgent, PlanMeta } from '../shared/agent-plan-path'
import { readPlanMetaPrefix, readPlanMeta, writePlanMeta } from './plan-meta'

export { AGENT_PLAN_RELATIVE_DIRS, readPlanMeta, writePlanMeta }

const execFileAsync = promisify(execFile)

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  gitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
}

// Directories to always skip
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.DS_Store', 'dist', 'build',
  '.next', '.cache', '__pycache__', '.venv', 'venv',
  'coverage', '.nyc_output',
])

export class FileService {
  static async getTree(dirPath: string, depth = 0): Promise<FileNode[]> {
    if (depth > 8) return [] // prevent infinite recursion

    // Use git ls-files if in a git repo for gitignore respect
    if (depth === 0) {
      try {
        return await this.getGitTree(dirPath)
      } catch {
        // Fall back to manual traversal
      }
    }

    const entries = await readdir(dirPath, { withFileTypes: true })
    const nodes: FileNode[] = []

    const sorted = entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.gitignore')
      .filter((e) => !SKIP_DIRS.has(e.name))
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

    for (const entry of sorted) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const children = await this.getTree(fullPath, depth + 1)
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        })
      } else {
        nodes.push({
          name: entry.name,
          path: fullPath,
          type: 'file',
        })
      }
    }

    return nodes
  }

  private static async getGitTree(dirPath: string): Promise<FileNode[]> {
    const { stdout } = await execFileAsync(
      'git',
      ['ls-files', '--others', '--cached', '--exclude-standard'],
      { cwd: dirPath }
    )

    const files = stdout.trim().split('\n').filter(Boolean)
    return this.buildTreeFromPaths(dirPath, files)
  }

  private static buildTreeFromPaths(basePath: string, paths: string[]): FileNode[] {
    const root: FileNode = { name: '', path: basePath, type: 'directory', children: [] }

    for (const filePath of paths) {
      const parts = filePath.split('/')
      let current = root

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const isFile = i === parts.length - 1
        const fullPath = join(basePath, ...parts.slice(0, i + 1))

        if (isFile) {
          current.children!.push({ name: part, path: fullPath, type: 'file' })
        } else {
          let dir = current.children!.find(
            (c) => c.name === part && c.type === 'directory'
          )
          if (!dir) {
            dir = { name: part, path: fullPath, type: 'directory', children: [] }
            current.children!.push(dir)
          }
          current = dir
        }
      }
    }

    // Sort: directories first, then alphabetical
    const sortNodes = (nodes: FileNode[]): FileNode[] => {
      nodes.sort((a, b) => {
        if (a.type === 'directory' && b.type !== 'directory') return -1
        if (a.type !== 'directory' && b.type === 'directory') return 1
        return a.name.localeCompare(b.name)
      })
      for (const node of nodes) {
        if (node.children) sortNodes(node.children)
      }
      return nodes
    }

    return sortNodes(root.children || [])
  }

  static async readFile(filePath: string): Promise<string> {
    return fsReadFile(filePath, 'utf-8')
  }

  static async writeFile(filePath: string, content: string): Promise<void> {
    await fsWriteFile(filePath, content, 'utf-8')
  }

  static async deleteFile(filePath: string): Promise<void> {
    const info = await stat(filePath)
    await rm(filePath, { recursive: info.isDirectory(), force: false })
  }

  /** Collect `.md`/`.mdx` under `root/.cursor/plans`, `root/.claude/plans`, etc. */
  private static async collectPlanFilesUnderRoot(root: string): Promise<AgentPlanEntry[]> {
    const results: AgentPlanEntry[] = []

    const scanDir = async (dir: string, agent: string, depth: number) => {
      if (depth > 8) return
      let entries: Awaited<ReturnType<typeof readdir>>
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        const full = join(dir, ent.name)
        if (ent.isDirectory()) {
          await scanDir(full, agent, depth + 1)
        } else if (ent.isFile()) {
          const lower = full.toLowerCase()
          if (!lower.endsWith('.md') && !lower.endsWith('.mdx')) continue
          try {
            const fst = await stat(full)
            if (!fst.isFile()) continue
            const meta = await readPlanMetaPrefix(full)
            results.push({
              path: full,
              mtimeMs: fst.mtimeMs,
              agent,
              built: meta.built || undefined,
              codingAgent: meta.codingAgent,
            })
          } catch { /* race: deleted */ }
        }
      }
    }

    for (const rel of AGENT_PLAN_RELATIVE_DIRS) {
      const agent = PLAN_DIR_TO_AGENT[rel] ?? rel
      const dir = join(root, rel)
      try {
        const st = await stat(dir)
        if (!st.isDirectory()) continue
        await scanDir(dir, agent, 0)
      } catch { /* missing */ }
    }

    return results
  }

  /**
   * Workspace agent plan dirs plus the same relative dirs under the user home directory
   * (Claude Code default: ~/.claude/plans).
   */
  private static async collectPlanFiles(worktreePath: string): Promise<AgentPlanEntry[]> {
    const fromWt = await this.collectPlanFilesUnderRoot(worktreePath)
    let fromHome: AgentPlanEntry[] = []
    try {
      fromHome = await this.collectPlanFilesUnderRoot(homedir())
    } catch {
      /* ignore */
    }
    const seen = new Set<string>()
    const merged: AgentPlanEntry[] = []
    for (const e of [...fromWt, ...fromHome]) {
      if (seen.has(e.path)) continue
      seen.add(e.path)
      merged.push(e)
    }
    return merged
  }

  private static dedupeWorktreePaths(paths: string[]): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const p of paths) {
      if (!p || typeof p !== 'string') continue
      const k = p.replace(/\/+$/, '') || '/'
      if (seen.has(k)) continue
      seen.add(k)
      out.push(p)
    }
    return out
  }

  /**
   * Find the most recently modified `.md` / `.mdx` under known agent plan folders
   * in the workspace worktree (e.g. `.cursor/plans/*.plan.md`).
   */
  static async findNewestPlanMarkdown(worktreePath: string): Promise<string | null> {
    const all = await this.collectPlanFiles(worktreePath)
    if (all.length === 0) return null
    let best = all[0]
    for (let i = 1; i < all.length; i++) {
      if (all[i].mtimeMs > best.mtimeMs) best = all[i]
    }
    return best.path
  }

  /**
   * All plan markdowns sorted newest-first, capped at 200.
   * Pass one or more worktree roots (same project); each entry includes `planSourceRoot`.
   * Home plan dirs (~/.cursor/plans, etc.) are merged once; workspace paths win on duplicate paths.
   */
  static async listAgentPlanMarkdowns(worktreePathOrPaths: string | string[]): Promise<AgentPlanEntry[]> {
    const raw = Array.isArray(worktreePathOrPaths) ? worktreePathOrPaths : [worktreePathOrPaths]
    const uniqueWts = this.dedupeWorktreePaths(raw.filter(Boolean))
    if (uniqueWts.length === 0) return []

    const byPath = new Map<string, AgentPlanEntry>()
    for (const wt of uniqueWts) {
      const fromWt = await this.collectPlanFilesUnderRoot(wt)
      for (const e of fromWt) {
        byPath.set(e.path, { ...e, planSourceRoot: wt })
      }
    }
    let fromHome: AgentPlanEntry[] = []
    try {
      fromHome = await this.collectPlanFilesUnderRoot(homedir())
    } catch {
      /* ignore */
    }
    const homeRoot = homedir()
    for (const e of fromHome) {
      if (!byPath.has(e.path)) {
        byPath.set(e.path, { ...e, planSourceRoot: homeRoot })
      }
    }
    const all = [...byPath.values()]
    all.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return all.slice(0, 200)
  }

  /** Update constellagent-namespaced frontmatter on a plan file. */
  static async updatePlanMeta(filePath: string, patch: Partial<PlanMeta>): Promise<PlanMeta> {
    return writePlanMeta(filePath, patch)
  }

  /** Copy or move a plan to another agent's plan directory. Returns the new path. */
  static async relocateAgentPlan(
    worktreePath: string,
    filePath: string,
    targetAgent: PlanAgent,
    mode: 'copy' | 'move',
  ): Promise<string> {
    if (relativePathInWorktree(worktreePath, filePath) === null) {
      throw new Error('Plan file is not inside the workspace')
    }

    const targetRelDir = AGENT_TO_PLAN_DIR[targetAgent]
    if (!targetRelDir) throw new Error(`Unknown agent: ${targetAgent}`)

    const targetDir = join(worktreePath, targetRelDir)
    await mkdir(targetDir, { recursive: true })

    const name = basename(filePath)
    let dest = join(targetDir, name)

    // Handle name collision with incrementing suffix
    let attempt = 0
    while (true) {
      try {
        await stat(dest)
        attempt++
        const ext = name.lastIndexOf('.')
        const base = ext > 0 ? name.slice(0, ext) : name
        const suffix = ext > 0 ? name.slice(ext) : ''
        dest = join(targetDir, `${base}-${attempt}${suffix}`)
      } catch {
        break // doesn't exist — use this name
      }
    }

    if (mode === 'copy') {
      await copyFile(filePath, dest)
    } else {
      await copyFile(filePath, dest)
      await rm(filePath)
    }

    return dest
  }
}
