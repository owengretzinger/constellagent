import { useEffect, useRef } from 'react'
import { FileEditor } from '../Editor/FileEditor'
import type { FileEditorHandle } from '../Editor/FileEditor'
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
  const editorRef = useRef<FileEditorHandle>(null)

  const handleMouseDown = () => {
    if (onFocus) onFocus(paneId)
  }

  // Focus the Monaco editor when this pane becomes focused (e.g. Ctrl+Tab)
  useEffect(() => {
    if (isFocusedPane) {
      editorRef.current?.focus()
    }
  }, [isFocusedPane])

  // Use the paneId as a stable tabId for save/unsaved tracking within the split
  return (
    <div
      className={`${styles.fileEditorPane} ${isFocusedPane ? styles.focusedPane : ''}`}
      onMouseDown={handleMouseDown}
    >
      <FileEditor
        ref={editorRef}
        tabId={paneId}
        filePath={filePath}
        active={true}
        worktreePath={worktreePath}
      />
    </div>
  )
}
