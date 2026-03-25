import { useRef, useState, useEffect, useCallback, type ReactNode } from 'react'
import {
  sendAddToChatText,
  selectionOverlapsElement,
} from '../../utils/add-to-chat'
import styles from './AddToChatMarkdownSurface.module.css'

interface Props {
  filePath: string
  children: ReactNode
  /** Optional inner class for max-width column */
  className?: string
}

export function AddToChatMarkdownSurface({ filePath, children, className }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [floating, setFloating] = useState<{ top: number; left: number } | null>(null)

  const updateFloating = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      setFloating(null)
      return
    }
    const text = sel.toString().trim()
    if (!text) {
      setFloating(null)
      return
    }
    if (!selectionOverlapsElement(wrap, sel)) {
      setFloating(null)
      return
    }
    const r = sel.getRangeAt(0).getBoundingClientRect()
    const b = wrap.getBoundingClientRect()
    const left = Math.min(
      Math.max(r.left - b.left + r.width / 2, 56),
      b.width - 56,
    )
    const top = Math.max(r.top - b.top - 40, 8)
    setFloating({ left, top })
  }, [])

  useEffect(() => {
    const onSel = () => {
      requestAnimationFrame(updateFloating)
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [updateFloating])

  const handleAdd = () => {
    const text = window.getSelection()?.toString() ?? ''
    sendAddToChatText(filePath, 'markdown', text)
    setFloating(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div
      ref={wrapRef}
      className={`${styles.previewWrap} ${className ?? ''}`}
      data-constellagent-md-preview=""
      data-constellagent-file-path={filePath}
      onMouseUp={updateFloating}
    >
      {children}
      {floating && (
        <button
          type="button"
          className={styles.floatBtn}
          style={{ left: floating.left, top: floating.top }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleAdd}
        >
          Add to Chat ⌘L
        </button>
      )}
    </div>
  )
}
