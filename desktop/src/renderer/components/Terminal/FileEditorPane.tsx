import { FileEditor } from '../Editor/FileEditor'
import styles from './FileEditorPane.module.css'

interface Props {
  filePath: string
  paneId: string
  onFocus?: (paneId: string) => void
  isFocusedPane?: boolean
  worktreePath?: string
}

/**
 * Thin wrapper around FileEditor for use inside split panes.
 * Adds focus tracking and split-specific styling without cluttering the standalone editor.
 */
export function FileEditorPane({ filePath, paneId, onFocus, isFocusedPane, worktreePath }: Props) {
  const handleMouseDown = () => {
    if (onFocus) onFocus(paneId)
  }

  // Use the paneId as a stable tabId for save/unsaved tracking within the split
  return (
    <div
      className={`${styles.fileEditorPane} ${isFocusedPane ? styles.focusedPane : ''}`}
      onMouseDown={handleMouseDown}
    >
      <FileEditor
        tabId={paneId}
        filePath={filePath}
        active={true}
        worktreePath={worktreePath}
      />
    </div>
  )
}
