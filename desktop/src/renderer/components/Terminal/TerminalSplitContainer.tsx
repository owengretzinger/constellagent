import { useCallback } from 'react'
import { Allotment } from 'allotment'
import { useAppStore } from '../../store/app-store'
import { TerminalPanel } from './TerminalPanel'
import { FileEditorPane } from './FileEditorPane'
import type { SplitNode, Tab } from '../../store/types'
import styles from './TerminalSplitContainer.module.css'

type TerminalTab = Extract<Tab, { type: 'terminal' }>

interface ContainerProps {
  tab: TerminalTab
  active: boolean
  worktreePath?: string
}

export function TerminalSplitContainer({ tab, active, worktreePath }: ContainerProps) {
  const setFocusedPane = useAppStore((s) => s.setFocusedPane)

  const handlePaneFocus = useCallback(
    (paneId: string) => {
      setFocusedPane(tab.id, paneId)
    },
    [tab.id, setFocusedPane],
  )

  // No splits — render a single TerminalPanel in standalone mode
  if (!tab.splitRoot) {
    return (
      <TerminalPanel
        key={tab.ptyId}
        ptyId={tab.ptyId}
        active={active}
      />
    )
  }

  // Render the split tree inside a visibility-toggling wrapper
  return (
    <div className={`${styles.splitWrapper} ${active ? styles.active : styles.hidden}`}>
      <SplitTreeNode
        node={tab.splitRoot}
        focusedPaneId={tab.focusedPaneId}
        onPaneFocus={handlePaneFocus}
        worktreePath={worktreePath}
      />
    </div>
  )
}

interface SplitTreeProps {
  node: SplitNode
  focusedPaneId: string | undefined
  onPaneFocus: (paneId: string) => void
  worktreePath?: string
}

function SplitTreeNode({ node, focusedPaneId, onPaneFocus, worktreePath }: SplitTreeProps) {
  if (node.type === 'leaf') {
    // Render file editor pane for file leaves
    if (node.contentType === 'file') {
      return (
        <FileEditorPane
          filePath={node.filePath}
          paneId={node.id}
          onFocus={onPaneFocus}
          isFocusedPane={node.id === focusedPaneId}
          worktreePath={worktreePath}
        />
      )
    }

    // Render terminal pane for terminal leaves
    return (
      <TerminalPanel
        ptyId={node.ptyId}
        active={true}
        inSplit={true}
        paneId={node.id}
        onFocus={onPaneFocus}
        isFocusedPane={node.id === focusedPaneId}
      />
    )
  }

  // 'horizontal' = side by side, 'vertical' = stacked
  const isVertical = node.direction === 'vertical'

  return (
    <Allotment vertical={isVertical}>
      {node.children.map((child) => (
        <Allotment.Pane key={child.id} minSize={100}>
          <SplitTreeNode
            node={child}
            focusedPaneId={focusedPaneId}
            onPaneFocus={onPaneFocus}
            worktreePath={worktreePath}
          />
        </Allotment.Pane>
      ))}
    </Allotment>
  )
}
