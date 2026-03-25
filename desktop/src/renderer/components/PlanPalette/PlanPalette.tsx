import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
import { relativePathInWorktree, pathsEqualOrAlias } from '../../../shared/agent-plan-path'
import { GeminiIcon } from '../Icons/GeminiIcon'
import { CursorIcon } from '../Icons/CursorIcon'
import claudeIcon from '../../assets/agent-icons/claude.svg'
import openaiIcon from '../../assets/agent-icons/openai.svg'
import qoStyles from '../QuickOpen/QuickOpen.module.css'
import styles from './PlanPalette.module.css'

interface PlanEntry {
  path: string
  mtimeMs: number
  agent: string
  built?: boolean
  codingAgent?: string | null
  planSourceRoot?: string
}

export interface PlanPaletteWorktreeOption {
  path: string
  label: string
}

interface Props {
  worktreePath: string
  /** All worktrees in the current project (used to load plans and filter by checkout). */
  projectWorktrees: PlanPaletteWorktreeOption[]
}

type AgentFilter = 'all' | 'cursor' | 'claude-code' | 'codex' | 'gemini'
type SourceFilter = 'all' | 'worktree' | 'home'
type WorktreeFilterKey = 'all' | '__home__' | string

const AGENTS: { key: AgentFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'claude-code', label: 'Claude' },
  { key: 'codex', label: 'Codex' },
  { key: 'gemini', label: 'Gemini' },
]

const SOURCES: { key: SourceFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'worktree', label: 'This worktree' },
  { key: 'home', label: 'Home (~)' },
]

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function relPath(p: string, base: string, userHome: string | null): string {
  if (userHome) {
    const relH = relativePathInWorktree(userHome, p)
    if (relH !== null) return `~/${relH}`
  }
  return p.startsWith(base) ? p.slice(base.length + 1) : p
}

function formatAge(mtimeMs: number): string {
  const delta = Date.now() - mtimeMs
  const mins = Math.floor(delta / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function entryMatchesWorktree(
  entry: PlanEntry,
  filter: WorktreeFilterKey,
  userHome: string | null,
  activeWorktree: string,
): boolean {
  if (filter === 'all') return true
  if (filter === '__home__') {
    if (userHome && entry.planSourceRoot && pathsEqualOrAlias(entry.planSourceRoot, userHome)) return true
    if (!entry.planSourceRoot && userHome) {
      return (
        relativePathInWorktree(userHome, entry.path) !== null
        && relativePathInWorktree(activeWorktree, entry.path) === null
      )
    }
    return false
  }
  if (entry.planSourceRoot && pathsEqualOrAlias(entry.planSourceRoot, filter)) return true
  if (!entry.planSourceRoot) return relativePathInWorktree(filter, entry.path) !== null
  return false
}

function AgentChipIcon({ agent }: { agent: AgentFilter }) {
  if (agent === 'all') return null
  if (agent === 'claude-code') return <img src={claudeIcon} alt="Claude" />
  if (agent === 'codex') return <img src={openaiIcon} alt="Codex" />
  if (agent === 'gemini') return <GeminiIcon />
  if (agent === 'cursor') return <CursorIcon />
  return null
}

function AgentRowIcon({ agent }: { agent: string }) {
  if (agent === 'claude-code') return <img src={claudeIcon} alt="" style={{ width: 14, height: 14 }} />
  if (agent === 'codex') return <img src={openaiIcon} alt="" style={{ width: 14, height: 14 }} />
  if (agent === 'gemini') return <GeminiIcon className={qoStyles.resultIcon} />
  if (agent === 'cursor') return <CursorIcon className={qoStyles.resultIcon} />
  return <span className={qoStyles.resultIcon}>·</span>
}

function dedupeWorktreeScanPaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of paths) {
    if (!p) continue
    const k = p.replace(/\/+$/, '') || '/'
    if (seen.has(k)) continue
    seen.add(k)
    out.push(p)
  }
  return out
}

export function PlanPalette({ worktreePath, projectWorktrees }: Props) {
  const [query, setQuery] = useState('')
  const [plans, setPlans] = useState<PlanEntry[]>([])
  const [userHome, setUserHome] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [agentFilter, setAgentFilter] = useState<AgentFilter>('all')
  const [worktreeFilter, setWorktreeFilter] = useState<WorktreeFilterKey>('all')
  const listRef = useRef<HTMLDivElement>(null)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const closePlanPalette = useAppStore((s) => s.closePlanPalette)

  const pathsToScan = useMemo(() => {
    const raw = projectWorktrees.length > 0 ? projectWorktrees.map((w) => w.path) : [worktreePath]
    return dedupeWorktreeScanPaths(raw)
  }, [projectWorktrees, worktreePath])

  const scanKey = pathsToScan.join('\0')

  useEffect(() => {
    void window.api.app.getHomeDir().then(setUserHome).catch(() => setUserHome(null))
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api.fs.listAgentPlanMarkdowns(pathsToScan).then((entries) => {
      if (!cancelled) setPlans(entries)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [scanKey])

  const filtered = useMemo(() => {
    let list = plans
    if (worktreeFilter !== 'all') {
      list = list.filter((p) => entryMatchesWorktree(p, worktreeFilter, userHome, worktreePath))
    }
    if (agentFilter !== 'all') {
      list = list.filter((p) => p.agent === agentFilter)
    }
    if (query.trim()) {
      const q = query.toLowerCase()
      list = list.filter((p) => basename(p.path).toLowerCase().startsWith(q))
    }
    return list.slice(0, 50)
  }, [plans, query, agentFilter, worktreeFilter, userHome, worktreePath])

  useEffect(() => { setSelectedIndex(0) }, [query, agentFilter, worktreeFilter])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[selectedIndex] as HTMLElement | undefined
    if (item) item.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const openSelected = useCallback(() => {
    const entry = filtered[selectedIndex]
    if (entry) {
      openMarkdownPreview(entry.path)
      closePlanPalette()
    }
  }, [filtered, selectedIndex, openMarkdownPreview, closePlanPalette])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePlanPalette()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openSelected()
    }
  }, [closePlanPalette, filtered.length, openSelected])

  const prefixLen = query.trim().length

  const displayBaseForEntry = useCallback(
    (entry: PlanEntry) => entry.planSourceRoot ?? worktreePath,
    [worktreePath],
  )

  return (
    <div className={qoStyles.overlay} onClick={closePlanPalette}>
      <div className={`${qoStyles.panel} ${styles.planPanel}`} onClick={(e) => e.stopPropagation()}>
        <div className={qoStyles.inputWrap}>
          <input
            className={qoStyles.input}
            type="text"
            placeholder="Search plans by name..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>

        <div className={styles.filterSection} role="group" aria-label="Plan filters">
          <div className={styles.filterRow}>
            <span className={styles.filterGroupLabel}>Worktree</span>
            <div className={styles.filterChips}>
              <button
                type="button"
                className={`${styles.chip} ${worktreeFilter === 'all' ? styles.chipActive : ''}`}
                onClick={() => setWorktreeFilter('all')}
                tabIndex={-1}
              >
                All
              </button>
              {projectWorktrees.map((w) => (
                <button
                  key={w.path}
                  type="button"
                  className={`${styles.chip} ${worktreeFilter === w.path ? styles.chipActive : ''}`}
                  onClick={() => setWorktreeFilter(w.path)}
                  tabIndex={-1}
                  title={w.path}
                >
                  {pathsEqualOrAlias(w.path, worktreePath) ? `${w.label} (active)` : w.label}
                </button>
              ))}
              <button
                type="button"
                className={`${styles.chip} ${worktreeFilter === '__home__' ? styles.chipActive : ''}`}
                onClick={() => setWorktreeFilter('__home__')}
                tabIndex={-1}
                title={userHome ? `Plans under ${userHome}` : 'User home plan folders'}
              >
                Home (~)
              </button>
            </div>
          </div>
          <div className={styles.filterRow}>
            <span className={styles.filterGroupLabel}>Agent folder</span>
            <div className={styles.filterChips}>
              {AGENTS.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  className={`${styles.chip} ${agentFilter === a.key ? styles.chipActive : ''}`}
                  onClick={() => setAgentFilter(a.key)}
                  tabIndex={-1}
                >
                  {a.key !== 'all' && (
                    <span className={styles.chipIcon}><AgentChipIcon agent={a.key} /></span>
                  )}
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={qoStyles.results} ref={listRef}>
          {filtered.length === 0 ? (
            <div className={qoStyles.empty}>
              {plans.length === 0 ? 'No plan files found' : 'No matching plans'}
            </div>
          ) : (
            filtered.map((entry, i) => {
              const name = basename(entry.path)
              const base = displayBaseForEntry(entry)
              const rel = relPath(entry.path, base, userHome)
              const dir = rel.slice(0, rel.length - name.length)
              return (
                <div
                  key={entry.path}
                  className={`${qoStyles.resultItem} ${i === selectedIndex ? qoStyles.selected : ''}`}
                  onClick={() => { openMarkdownPreview(entry.path); closePlanPalette() }}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <AgentRowIcon agent={entry.agent} />
                  <span className={qoStyles.resultPath}>
                    {dir && <span className={qoStyles.resultDir}>{dir}</span>}
                    <span className={qoStyles.resultName}>
                      {prefixLen > 0 ? (
                        <>
                          <span className={qoStyles.matchChar}>{name.slice(0, prefixLen)}</span>
                          {name.slice(prefixLen)}
                        </>
                      ) : name}
                    </span>
                  </span>
                  {entry.codingAgent && (
                    <span className={styles.agentLabel} title={entry.codingAgent}>{entry.codingAgent}</span>
                  )}
                  {entry.built ? (
                    <span className={`${styles.builtPill} ${styles.builtYes}`}>Built ✓</span>
                  ) : (
                    <span className={styles.builtPill}>Not built</span>
                  )}
                  <span className={styles.meta}>{formatAge(entry.mtimeMs)}</span>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
