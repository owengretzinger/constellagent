import { useState } from 'react'
import { useAppStore } from '../../store/app-store'
import styles from './Sidebar.module.css'

interface GraphiteStackProps {
  workspaceId: string
  projectId: string
  worktreePath: string
}

const COLLAPSED_PILL_COUNT = 3

export function GraphiteStack({ workspaceId, projectId, worktreePath }: GraphiteStackProps) {
  const stack = useAppStore((s) => s.graphiteStacks.get(workspaceId))
  const expanded = useAppStore((s) => s.graphiteStackExpanded)
  const toggleExpanded = useAppStore((s) => s.toggleGraphiteStackExpanded)
  const updateWorkspaceBranch = useAppStore((s) => s.updateWorkspaceBranch)
  const [checking, setChecking] = useState<string | null>(null)

  if (!stack || stack.branches.length <= 1) return null

  const pills = [...stack.branches].reverse()
  const canCollapse = pills.length > COLLAPSED_PILL_COUNT

  const handleCheckout = async (branchName: string) => {
    if (branchName === stack.currentBranch || checking) return
    setChecking(branchName)
    try {
      await window.api.graphite.checkoutBranch(worktreePath, branchName)
      updateWorkspaceBranch(workspaceId, branchName)
      useAppStore.getState().setGraphiteStack(workspaceId, {
        ...stack,
        currentBranch: branchName,
      })
    } catch {
      // Checkout failed — will be corrected by next poll
    } finally {
      setChecking(null)
    }
  }

  return (
    <div
      className={`${styles.graphiteStack} ${canCollapse && !expanded ? styles.graphiteStackCollapsed : ''}`}
    >
      {pills.map((b) => {
        const isCurrent = b.name === stack.currentBranch
        const isChecking = checking === b.name
        return (
          <button
            key={b.name}
            className={`${styles.graphiteBranch} ${isCurrent ? styles.graphiteBranchCurrent : ''} ${isChecking ? styles.graphiteBranchChecking : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              void handleCheckout(b.name)
            }}
            disabled={isCurrent || checking !== null}
            title={isCurrent ? `Current branch: ${b.name}` : `Switch to ${b.name}`}
          >
            <span className={styles.graphiteBranchName}>{b.name}</span>
          </button>
        )
      })}
      {canCollapse && (
        <button
          className={styles.graphiteStackToggle}
          onClick={(e) => {
            e.stopPropagation()
            toggleExpanded()
          }}
          title={expanded ? 'Collapse stack (⇧⌘T)' : `Show all ${pills.length} branches (⇧⌘T)`}
        >
          {expanded ? '▴ less' : `▾ ${pills.length - COLLAPSED_PILL_COUNT} more`}
        </button>
      )}
    </div>
  )
}
