import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
import { useFileWatcher } from '../../hooks/useFileWatcher'
import type { GitLogEntry } from '@shared/git-types'
import styles from './GitGraph.module.css'

// ── Lane Colors ──

const LANE_COLORS = [
  '#638cff', // blue
  '#e5a63b', // yellow/orange
  '#e560a4', // pink/magenta
  '#4ec990', // green
  '#e58a3b', // orange
  '#4ec9c9', // cyan
  '#b580e5', // purple
]

function laneColor(laneIdx: number): string {
  return LANE_COLORS[laneIdx % LANE_COLORS.length]
}

// ── Constants ──

const LANE_WIDTH = 20
const ROW_HEIGHT = 36
const DOT_R = 5.5
const LINE_W = 2.5
const SHADOW_W = 6

// ── Graph Computation ──

interface BranchLine {
  points: { x: number; y: number }[]
  color: string
}

interface CommitDot {
  cx: number
  cy: number
  color: string
  hash: string
  isCurrent: boolean
  isMerge: boolean
}

interface GraphData {
  branches: BranchLine[]
  dots: CommitDot[]
  maxLanes: number
}

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2 + 8
}

/**
 * Compute the git graph layout — GitLens-style.
 *
 * Algorithm overview:
 *   - `lanes` is an ordered array where lanes[i] = the commit hash that lane i
 *     is "waiting for" (i.e. the next commit that should appear on that lane).
 *   - When a commit appears, it occupies the LOWEST lane waiting for it.
 *   - Any OTHER lanes also waiting for the same hash are converged into the
 *     commit's lane with a diagonal curve (from the extra lane down into the
 *     commit's lane) and then freed.
 *   - The commit's first parent inherits the commit's lane (straight line down).
 *   - Additional parents (merge) either connect to an existing lane with a
 *     curve, or allocate a new lane with a fork-out curve.
 *   - Each active lane gets a vertical continuation point every row to keep the
 *     line continuous.
 */
function computeGraph(entries: GitLogEntry[]): GraphData {
  // lanes[i] = hash that lane i is waiting for, or null if free
  const lanes: (string | null)[] = []
  // laneBranch[i] = index into `branches` for the running vertical line on lane i
  const laneBranch: (number | null)[] = []
  // Stable color per lane (index into LANE_COLORS)
  const laneColorIdx: number[] = []
  let nextColorIdx = 0

  const branches: BranchLine[] = []
  const dots: CommitDot[] = []
  let maxLanes = 1

  // ── Helpers ──

  function allocLane(hash: string): number {
    // Prefer reusing the lowest free lane (but not lane 0 unless it's the only option)
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] === null) {
        lanes[l] = hash
        if (laneColorIdx[l] === undefined) laneColorIdx[l] = nextColorIdx++
        if (laneBranch[l] === undefined) laneBranch[l] = null
        return l
      }
    }
    const l = lanes.length
    lanes.push(hash)
    laneBranch.push(null)
    laneColorIdx.push(nextColorIdx++)
    return l
  }

  function ensureBranch(lane: number): number {
    if (laneBranch[lane] != null) return laneBranch[lane]!
    while (laneColorIdx.length <= lane) laneColorIdx.push(nextColorIdx++)
    while (laneBranch.length <= lane) laneBranch.push(null)
    const idx = branches.length
    branches.push({ points: [], color: laneColor(laneColorIdx[lane]) })
    laneBranch[lane] = idx
    return idx
  }

  function closeLane(lane: number): void {
    lanes[lane] = null
    laneBranch[lane] = null
  }

  // ── Main loop ──

  for (let i = 0; i < entries.length; i++) {
    const { hash, parents } = entries[i]
    const y = i * ROW_HEIGHT + ROW_HEIGHT / 2
    const nextY = y + ROW_HEIGHT
    const prevY = y - ROW_HEIGHT

    // ── 1. Find or allocate the commit's lane ──
    let commitLane = -1
    let wasTracked = true
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] === hash) { commitLane = l; break }
    }
    if (commitLane === -1) {
      commitLane = allocLane(hash)
      wasTracked = false
    }

    const cx = laneX(commitLane)

    // ── 1b. Fork-in curve for untracked commits ──
    // If this commit wasn't previously tracked (it appeared fresh, e.g. a
    // branch tip from --all), and its first parent is already tracked on a
    // different lane, draw a fork-in curve from the parent's lane to this
    // commit's lane. This shows where the branch originates.
    if (!wasTracked && parents.length > 0) {
      const firstParent = parents[0]
      let parentLane = -1
      for (let l = 0; l < lanes.length; l++) {
        if (l === commitLane) continue
        if (lanes[l] === firstParent) { parentLane = l; break }
      }
      if (parentLane !== -1) {
        // Start the branch line with a curve from the parent's lane
        const bIdx = ensureBranch(commitLane)
        branches[bIdx].points.push({ x: laneX(parentLane), y: prevY })
      }
    }

    // ── 2. Converge OTHER lanes waiting for this hash ──
    // These are branches that were forked and now merge back into this commit.
    // Append the commit position to the existing branch line so the path
    // naturally curves from the lane's vertical run into the commit dot.
    const closedLanes = new Set<number>()
    for (let l = 0; l < lanes.length; l++) {
      if (l === commitLane) continue
      if (lanes[l] !== hash) continue

      const brIdx = laneBranch[l]
      if (brIdx != null) {
        // Append the commit position — buildPathD will draw an S-curve
        // from the last vertical point on this lane into (cx, y).
        branches[brIdx].points.push({ x: cx, y })
      } else {
        // No existing branch line — create a short convergence curve
        branches.push({
          points: [{ x: laneX(l), y: prevY }, { x: cx, y }],
          color: laneColor(laneColorIdx[l]),
        })
      }
      closeLane(l)
      closedLanes.add(l)
    }

    // ── 3. Add commit dot to its lane's branch line ──
    const brIdx = ensureBranch(commitLane)
    branches[brIdx].points.push({ x: cx, y })

    dots.push({
      cx,
      cy: y,
      color: laneColor(laneColorIdx[commitLane]),
      hash,
      isCurrent: i === 0,
      isMerge: parents.length > 1,
    })

    // ── 4. Assign parents to lanes ──
    const newLanes = new Set<number>()

    if (parents.length === 0) {
      // Root commit — close lane
      closeLane(commitLane)
      closedLanes.add(commitLane)
    } else {
      // First parent inherits the commit's lane (straight line continues)
      lanes[commitLane] = parents[0]

      // Additional parents (merge parents) — fork out
      for (let p = 1; p < parents.length; p++) {
        const ph = parents[p]

        // Check if this parent is already being tracked in some lane
        let pLane = -1
        for (let l = 0; l < lanes.length; l++) {
          if (lanes[l] === ph) { pLane = l; break }
        }

        if (pLane !== -1) {
          // Parent already tracked — draw a curve from commit to that lane
          branches.push({
            points: [{ x: cx, y }, { x: laneX(pLane), y: nextY }],
            color: laneColor(laneColorIdx[pLane]),
          })
        } else {
          // Allocate a new lane and start a branch with a fork-out curve
          pLane = allocLane(ph)
          while (laneColorIdx.length <= pLane) laneColorIdx.push(nextColorIdx++)
          while (laneBranch.length <= pLane) laneBranch.push(null)
          newLanes.add(pLane)

          // Start the new lane's branch with a curve from commit to new lane
          const bIdx = branches.length
          branches.push({
            points: [{ x: cx, y }, { x: laneX(pLane), y: nextY }],
            color: laneColor(laneColorIdx[pLane]),
          })
          laneBranch[pLane] = bIdx
        }
      }
    }

    // ── 5. Vertical continuation for all active lanes ──
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] == null) continue
      if (laneBranch[l] == null) continue
      if (newLanes.has(l)) continue
      if (closedLanes.has(l)) continue
      // Don't double-add the commit lane (already added in step 3)
      if (l === commitLane) continue
      branches[laneBranch[l]!].points.push({ x: laneX(l), y })
    }

    // ── 6. Trim trailing empty lanes ──
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      laneBranch.pop()
      laneColorIdx.pop()
    }

    maxLanes = Math.max(maxLanes, lanes.length, commitLane + 1)
  }

  return { branches, dots, maxLanes }
}

// ── Path Builder ──

function buildPathD(points: { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  const parts: string[] = [`M ${points[0].x},${points[0].y}`]

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]
    const cur = points[i]

    if (prev.x === cur.x) {
      // Vertical segment — straight line
      parts.push(`L ${cur.x},${cur.y}`)
    } else {
      // Diagonal transition — smooth S-curve using cubic Bezier.
      // Control points: depart vertically from prev, arrive vertically at cur.
      const dy = cur.y - prev.y
      const cpOffset = Math.min(Math.abs(dy) * 0.5, ROW_HEIGHT * 0.8)
      const cp1y = prev.y + cpOffset * Math.sign(dy)
      const cp2y = cur.y - cpOffset * Math.sign(dy)
      parts.push(
        `C ${prev.x},${cp1y} ${cur.x},${cp2y} ${cur.x},${cur.y}`,
      )
    }
  }

  return parts.join(' ')
}

// ── Graph Canvas ──

interface GraphCanvasProps {
  graph: GraphData
  entryCount: number
  onClickCommit: (hash: string) => void
}

function GraphCanvas({ graph, entryCount, onClickCommit }: GraphCanvasProps) {
  const width = graph.maxLanes * LANE_WIDTH + 16
  const height = entryCount * ROW_HEIGHT

  return (
    <svg className={styles.graphCanvas} width={width} height={height}>
      {/* Shadow paths */}
      {graph.branches.map((branch, i) => {
        const d = buildPathD(branch.points)
        return d ? (
          <path key={`s-${i}`} className={styles.shadow} d={d} />
        ) : null
      })}
      {/* Colored paths */}
      {graph.branches.map((branch, i) => {
        const d = buildPathD(branch.points)
        return d ? (
          <path
            key={`b-${i}`}
            className={styles.branchLine}
            stroke={branch.color}
            d={d}
          />
        ) : null
      })}
      {/* Commit dots */}
      {graph.dots.map((dot) => (
        dot.isCurrent ? (
          <circle
            key={dot.hash}
            cx={dot.cx}
            cy={dot.cy}
            r={DOT_R}
            className={styles.dotCurrent}
            stroke={dot.color}
            onClick={(e) => {
              e.stopPropagation()
              onClickCommit(dot.hash)
            }}
          />
        ) : dot.isMerge ? (
          <g key={dot.hash} onClick={(e) => { e.stopPropagation(); onClickCommit(dot.hash) }} style={{ cursor: 'pointer' }}>
            <circle cx={dot.cx} cy={dot.cy} r={DOT_R} className={styles.dotMerge} stroke={dot.color} />
            <circle cx={dot.cx} cy={dot.cy} r={2} className={styles.dotMergeInner} fill={dot.color} />
          </g>
        ) : (
          <circle
            key={dot.hash}
            cx={dot.cx}
            cy={dot.cy}
            r={DOT_R}
            className={styles.dotNormal}
            stroke={dot.color}
            fill={dot.color}
            onClick={(e) => {
              e.stopPropagation()
              onClickCommit(dot.hash)
            }}
          />
        )
      ))}
    </svg>
  )
}

// ── Ref Label ──

function RefLabel({ label }: { label: string }) {
  let cls = styles.refRemote
  if (label.startsWith('HEAD')) cls = styles.refHead
  else if (label.startsWith('tag:')) cls = styles.refTag
  else if (!label.includes('/')) cls = styles.refHead

  return (
    <span className={`${styles.refPill} ${cls}`}>
      {label}
    </span>
  )
}

// ── Main Component ──

interface GitGraphProps {
  worktreePath: string
  workspaceId: string
  isActive: boolean
}

export function GitGraph({ worktreePath, workspaceId, isActive }: GitGraphProps) {
  const [entries, setEntries] = useState<GitLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const openCommitDiffTab = useAppStore((s) => s.openCommitDiffTab)
  const hasAutoSelected = useRef(false)

  const loadLog = useCallback(async () => {
    try {
      const log = await window.api.git.getLog(worktreePath)
      setEntries(log)
      return log
    } catch (err) {
      console.error('Failed to load git log:', err)
      return []
    } finally {
      setLoading(false)
    }
  }, [worktreePath])

  // Load on mount and when worktreePath changes
  useEffect(() => {
    hasAutoSelected.current = false
    setLoading(true)
    loadLog()
  }, [loadLog])

  // Auto-select latest commit on first load when active
  useEffect(() => {
    if (!isActive || hasAutoSelected.current || entries.length === 0) return
    hasAutoSelected.current = true
    const latest = entries[0]
    setSelectedHash(latest.hash)
    openCommitDiffTab(workspaceId, latest.hash, latest.message)
  }, [isActive, entries, workspaceId, openCommitDiffTab])

  // Refresh on filesystem changes
  useFileWatcher(worktreePath, loadLog, isActive)

  const handleClickCommit = useCallback(
    (entry: GitLogEntry) => {
      setSelectedHash(entry.hash)
      openCommitDiffTab(workspaceId, entry.hash, entry.message)
    },
    [workspaceId, openCommitDiffTab],
  )

  const handleClickDot = useCallback(
    (hash: string) => {
      const entry = entries.find((e) => e.hash === hash)
      if (entry) handleClickCommit(entry)
    },
    [entries, handleClickCommit],
  )

  const graph = useMemo(() => computeGraph(entries), [entries])

  if (loading) {
    return <div className={styles.loading}>Loading commits...</div>
  }

  if (entries.length === 0) {
    return (
      <div className={styles.empty}>
        <span className={styles.emptyIcon}>&#128310;</span>
        <span className={styles.emptyText}>No commits yet</span>
      </div>
    )
  }

  const graphWidth = graph.maxLanes * LANE_WIDTH + 16

  return (
    <div className={styles.container}>
      <div className={styles.scrollArea}>
        <GraphCanvas
          graph={graph}
          entryCount={entries.length}
          onClickCommit={handleClickDot}
        />
        {entries.map((entry) => (
          <div
            key={entry.hash}
            className={`${styles.commitRow} ${entry.hash === selectedHash ? styles.selected : ''}`}
            onClick={() => handleClickCommit(entry)}
          >
            <div
              className={styles.graphColumn}
              style={{ width: graphWidth }}
            />
            <div className={styles.infoColumn}>
              <div className={styles.commitMessage}>{entry.message}</div>
              {entry.refs.length > 0 && (
                <div className={styles.refs}>
                  {entry.refs.map((ref) => (
                    <RefLabel key={ref} label={ref} />
                  ))}
                </div>
              )}
              <div className={styles.commitMeta}>
                <span className={styles.commitAuthor}>{entry.author}</span>
                <span className={styles.commitDate}>{entry.relativeDate}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
