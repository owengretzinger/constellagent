import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
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

function computeGraph(entries: GitLogEntry[]): GraphData {
  const lanes: (string | null)[] = []
  // Track which BranchLine index each lane belongs to
  const laneBranch: (number | null)[] = []
  const branches: BranchLine[] = []
  const dots: CommitDot[] = []
  let maxLanes = 1

  for (let i = 0; i < entries.length; i++) {
    const { hash, parents } = entries[i]
    const y = i * ROW_HEIGHT + ROW_HEIGHT / 2

    // Find which lane this commit lands on
    let commitLane = lanes.indexOf(hash)
    if (commitLane === -1) {
      commitLane = lanes.indexOf(null)
      if (commitLane === -1) {
        commitLane = lanes.length
        lanes.push(hash)
        laneBranch.push(null)
      } else {
        lanes[commitLane] = hash
      }
    }

    // If this lane has no branch yet, start one
    if (laneBranch[commitLane] == null) {
      const idx = branches.length
      branches.push({ points: [], color: laneColor(commitLane) })
      laneBranch[commitLane] = idx
    }

    const cx = commitLane * LANE_WIDTH + LANE_WIDTH / 2 + 8
    const dotPoint = { x: cx, y }

    // Add point to this lane's branch
    branches[laneBranch[commitLane]!].points.push(dotPoint)

    dots.push({
      cx,
      cy: y,
      color: laneColor(commitLane),
      hash,
      isCurrent: i === 0,
      isMerge: parents.length > 1,
    })

    const newMergeLanes = new Set<number>()

    if (parents.length === 0) {
      // Root commit — close lane
      lanes[commitLane] = null
      laneBranch[commitLane] = null
    } else {
      // First parent continues in the same lane
      lanes[commitLane] = parents[0]

      // Additional parents (merge) — find or create lanes
      for (let p = 1; p < parents.length; p++) {
        const parentHash = parents[p]
        let parentLane = lanes.indexOf(parentHash)
        if (parentLane === -1) {
          parentLane = lanes.indexOf(null)
          if (parentLane === -1) {
            parentLane = lanes.length
            lanes.push(parentHash)
            laneBranch.push(null)
          } else {
            lanes[parentLane] = parentHash
          }
        }

        const parentX = parentLane * LANE_WIDTH + LANE_WIDTH / 2 + 8

        // Standalone merge curve (short 2-point path)
        branches.push({
          points: [
            { x: cx, y },
            { x: parentX, y: y + ROW_HEIGHT },
          ],
          color: laneColor(parentLane),
        })

        // Start a separate continuation branch for this lane if needed
        if (laneBranch[parentLane] == null) {
          const contIdx = branches.length
          branches.push({ points: [], color: laneColor(parentLane) })
          laneBranch[parentLane] = contIdx
          newMergeLanes.add(parentLane)
        }
      }
    }

    // Add vertical continuation points for all active lanes (except the commit lane, already added)
    // Skip lanes just created for merges — they start on the next row
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] != null && l !== commitLane && laneBranch[l] != null && !newMergeLanes.has(l)) {
        const lx = l * LANE_WIDTH + LANE_WIDTH / 2 + 8
        branches[laneBranch[l]!].points.push({ x: lx, y })
      }
    }

    // Collapse trailing null lanes
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop()
      laneBranch.pop()
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
      // Vertical segment
      parts.push(`L ${cur.x},${cur.y}`)
    } else {
      // S-curve: horizontal departure, vertical arrival
      const midY = (prev.y + cur.y) / 2
      parts.push(
        `C ${cur.x},${prev.y} ${cur.x},${midY} ${cur.x},${cur.y}`,
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
  useEffect(() => {
    if (!isActive) return
    window.api.fs.watchDir(worktreePath)
    const unsub = window.api.fs.onDirChanged((changedDir: string) => {
      if (changedDir === worktreePath) loadLog()
    })
    return () => {
      unsub()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, isActive, loadLog])

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
