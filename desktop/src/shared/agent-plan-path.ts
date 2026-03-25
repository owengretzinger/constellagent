/** Workspace-relative dirs where coding agents write plan markdown. */
export const AGENT_PLAN_RELATIVE_DIRS = [
  '.cursor/plans',
  '.claude/plans',
  '.codex/plans',
  '.gemini/plans',
] as const

export type AgentPlanDir = (typeof AGENT_PLAN_RELATIVE_DIRS)[number]

export const PLAN_DIR_TO_AGENT: Record<string, string> = {
  '.cursor/plans': 'cursor',
  '.claude/plans': 'claude-code',
  '.codex/plans': 'codex',
  '.gemini/plans': 'gemini',
}

export const AGENT_TO_PLAN_DIR: Record<string, AgentPlanDir> = {
  cursor: '.cursor/plans',
  'claude-code': '.claude/plans',
  codex: '.codex/plans',
  gemini: '.gemini/plans',
}

export const AGENT_PLAN_DIRS_LABEL =
  '.cursor/plans, .claude/plans, .codex/plans, .gemini/plans'

const PRIVATE_PREFIX = '/private'

/** Absolute path variants that can refer to the same directory (macOS /private aliasing). */
function absolutePathVariants(p: string): string[] {
  const norm = p.replace(/\/+$/, '') || '/'
  const out = [norm]
  if (norm.startsWith(PRIVATE_PREFIX)) {
    const stripped = norm.slice(PRIVATE_PREFIX.length) || '/'
    if (!out.includes(stripped)) out.push(stripped)
  } else if (norm.startsWith('/')) {
    const withPrivate = PRIVATE_PREFIX + norm
    if (!out.includes(withPrivate)) out.push(withPrivate)
  }
  return out
}

/**
 * Path from `worktreePath` to `filePath` using `/` segments, or null if the file is not under the worktree.
 * Handles macOS `/private/var/...` vs `/var/...` style mismatches between UI-stored paths and Node/fs paths.
 */
export function relativePathInWorktree(worktreePath: string, filePath: string): string | null {
  const wVars = absolutePathVariants(worktreePath)
  const fVars = absolutePathVariants(filePath)
  for (const w of wVars) {
    for (const f of fVars) {
      if (f === w) return ''
      if (w === '/') {
        if (f.startsWith('/')) return f.slice(1)
        continue
      }
      const prefix = `${w}/`
      if (f.startsWith(prefix)) return f.slice(prefix.length)
    }
  }
  return null
}

function isUnderAgentPlanDirs(root: string, filePath: string): boolean {
  if (!root) return false
  const rel = relativePathInWorktree(root, filePath)
  if (rel === null) return false
  return AGENT_PLAN_RELATIVE_DIRS.some((d) => rel.startsWith(d + '/') || rel === d)
}

function agentForPlanPathUnderRoot(root: string, filePath: string): string | null {
  if (!root) return null
  const rel = relativePathInWorktree(root, filePath)
  if (rel === null) return null
  for (const dir of AGENT_PLAN_RELATIVE_DIRS) {
    if (rel.startsWith(dir + '/') || rel === dir) {
      return PLAN_DIR_TO_AGENT[dir] ?? null
    }
  }
  return null
}

/**
 * True if `filePath` is under known agent plan dirs inside the workspace worktree
 * or (when `userHome` is set) under the same relative dirs in the user home directory
 * — e.g. Claude Code `~/.claude/plans/*.md`.
 */
export function isAgentPlanPath(worktreePath: string, filePath: string, userHome?: string): boolean {
  if (worktreePath && isUnderAgentPlanDirs(worktreePath, filePath)) return true
  if (userHome && isUnderAgentPlanDirs(userHome, filePath)) return true
  return false
}

/** Return the agent key for a plan file path, or null if not under a known plan dir. */
export function agentForPlanPath(worktreePath: string, filePath: string, userHome?: string): string | null {
  return (
    agentForPlanPathUnderRoot(worktreePath, filePath) ??
    (userHome ? agentForPlanPathUnderRoot(userHome, filePath) : null)
  )
}

/** True if `a` and `b` are the same absolute path (macOS /private aliases included). */
export function pathsEqualOrAlias(a: string, b: string): boolean {
  const av = absolutePathVariants(a)
  const bv = absolutePathVariants(b)
  return av.some((x) => bv.includes(x))
}

export interface AgentPlanEntry {
  path: string
  mtimeMs: number
  agent: string
  built?: boolean
  codingAgent?: string | null
  /** Absolute path: worktree root this plan was indexed under, or user home for dot-agent plan dirs. */
  planSourceRoot?: string
}

/** Constellagent-owned frontmatter metadata stored under a namespaced key. */
export interface PlanMeta {
  built: boolean
  codingAgent: string | null
  /** CLI harness for Build; null means use the plan file's folder agent. */
  buildHarness: PlanAgent | null
}

export const PLAN_META_DEFAULTS: PlanMeta = {
  built: false,
  codingAgent: null,
  buildHarness: null,
}

export type PlanAgent = 'cursor' | 'claude-code' | 'codex' | 'gemini'
export type RelocateMode = 'copy' | 'move'
