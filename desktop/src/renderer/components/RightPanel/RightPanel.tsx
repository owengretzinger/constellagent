import { useAppStore } from '../../store/app-store'
import { HookType } from '../../store/types'
import { FileTree } from './FileTree'
import { ChangedFiles } from './ChangedFiles'
import { RunBar } from '../RunBar/RunBar'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './RightPanel.module.css'

export function RightPanel() {
  const rightPanelMode = useAppStore((s) => s.rightPanelMode)
  const setRightPanelMode = useAppStore((s) => s.setRightPanelMode)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const workspaces = useAppStore((s) => s.workspaces)
  const projects = useAppStore((s) => s.projects)

  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const activeProject = workspace ? projects.find((p) => p.id === workspace.projectId) : undefined
  const hasRunHook = !!activeProject?.hooks?.some((h) => h.type === HookType.Run && h.command.trim())

  return (
    <div className={styles.rightPanel}>
      <div className={styles.header}>
        <div className={styles.modeToggle}>
          <Tooltip label="Files" shortcut="⇧⌘E">
            <button
              className={`${styles.modeButton} ${rightPanelMode === 'files' ? styles.active : ''}`}
              onClick={() => setRightPanelMode('files')}
            >
              Files
            </button>
          </Tooltip>
          <Tooltip label="Changes" shortcut="⇧⌘G">
            <button
              className={`${styles.modeButton} ${rightPanelMode === 'changes' ? styles.active : ''}`}
              onClick={() => setRightPanelMode('changes')}
            >
              Changes
            </button>
          </Tooltip>
        </div>
      </div>

      <div className={styles.content}>
        {!workspace ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}>📁</span>
            <span className={styles.emptyText}>
              Select a workspace to browse files
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: rightPanelMode === 'files' ? 'contents' : 'none' }}>
              <FileTree worktreePath={workspace.worktreePath} isActive={rightPanelMode === 'files'} />
            </div>
            <div style={{ display: rightPanelMode === 'changes' ? 'contents' : 'none' }}>
              <ChangedFiles
                worktreePath={workspace.worktreePath}
                workspaceId={workspace.id}
                isActive={rightPanelMode === 'changes'}
              />
            </div>
          </>
        )}
      </div>

      {hasRunHook && <RunBar />}
    </div>
  )
}
