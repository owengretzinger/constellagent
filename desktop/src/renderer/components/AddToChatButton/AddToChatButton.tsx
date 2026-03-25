import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../../store/app-store'
import { sendActiveSelectionToAgent } from '../../utils/add-to-chat'
import styles from './AddToChatButton.module.css'

interface Position {
  x: number
  y: number
}

export function AddToChatButton() {
  const [pos, setPos] = useState<Position | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const updatePosition = useCallback(() => {
    // Check Monaco editor selection first
    const ed = useAppStore.getState().activeMonacoEditor
    if (ed) {
      const sel = ed.getSelection()
      if (sel && !sel.isEmpty()) {
        const visPos = ed.getScrolledVisiblePosition({
          lineNumber: sel.endLineNumber,
          column: sel.endColumn,
        })
        if (visPos) {
          const domNode = ed.getDomNode()
          if (domNode) {
            const rect = domNode.getBoundingClientRect()
            setPos({
              x: rect.left + visPos.left,
              y: rect.top + visPos.top + visPos.height + 4,
            })
            return
          }
        }
      }
    }

    // Fallback: window selection (markdown preview)
    const winSel = window.getSelection()
    if (winSel && winSel.toString().trim()) {
      const target = winSel.anchorNode?.parentElement
      if (target?.closest?.('[class*="editorContainer"]') || target?.closest?.('[class*="markdownPreview"]') || target?.closest?.('[class*="MarkdownPreview"]')) {
        const range = winSel.getRangeAt(0)
        const rect = range.getBoundingClientRect()
        if (rect.width > 0) {
          setPos({
            x: rect.right,
            y: rect.bottom + 4,
          })
          return
        }
      }
    }

    setPos(null)
  }, [])

  useEffect(() => {
    const onSelection = () => {
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(updatePosition, 200)
    }

    document.addEventListener('selectionchange', onSelection)

    let disposable: { dispose(): void } | undefined
    const checkMonaco = () => {
      const ed = useAppStore.getState().activeMonacoEditor
      if (ed) {
        disposable?.dispose()
        disposable = ed.onDidChangeCursorSelection(() => {
          clearTimeout(timerRef.current)
          timerRef.current = setTimeout(updatePosition, 200)
        })
      }
    }

    let prevEditor = useAppStore.getState().activeMonacoEditor
    const unsub = useAppStore.subscribe((s) => {
      if (s.activeMonacoEditor !== prevEditor) {
        prevEditor = s.activeMonacoEditor
        checkMonaco()
      }
    })
    checkMonaco()

    return () => {
      document.removeEventListener('selectionchange', onSelection)
      clearTimeout(timerRef.current)
      disposable?.dispose()
      unsub()
    }
  }, [updatePosition])

  const handleClick = useCallback(() => {
    if (sendActiveSelectionToAgent()) {
      setPos(null)
    }
  }, [])

  if (!pos) return null

  return (
    <button
      className={styles.button}
      style={{ left: pos.x, top: pos.y }}
      onClick={handleClick}
      onMouseDown={(e) => e.preventDefault()}
    >
      Add to Chat <span className={styles.shortcut}>⌘L</span>
    </button>
  )
}
