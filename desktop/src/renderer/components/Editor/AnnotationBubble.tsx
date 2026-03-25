import { useState, useCallback } from 'react'
import {
  annotationLineEnd,
  type DiffAnnotation,
  type DiffAnnotationSide,
} from '../../../shared/diff-annotation-types'
import styles from './AnnotationBubble.module.css'

export function AnnotationBubble({
  annotation,
  worktreePath,
  onChanged,
}: {
  annotation: DiffAnnotation
  worktreePath: string
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true)
      try {
        await fn()
        onChanged()
      } finally {
        setBusy(false)
      }
    },
    [onChanged],
  )

  const end = annotationLineEnd(annotation)
  const rangeLabel =
    end !== annotation.lineNumber ? `L${annotation.lineNumber}–L${end}` : `L${annotation.lineNumber}`

  return (
    <div
      className={`${styles.bubble} ${annotation.resolved ? styles.bubbleResolved : ''}`}
      data-annotation-id={annotation.id}
    >
      <div className={styles.meta}>
        <span>
          {annotation.resolved ? 'Resolved' : 'Open'} · {rangeLabel}
        </span>
        <div className={styles.actions}>
          {!annotation.resolved && (
            <button
              type="button"
              className={styles.actionBtn}
              disabled={busy}
              onClick={() => run(() => window.api.annotations.resolve(worktreePath, annotation.id))}
            >
              Resolve
            </button>
          )}
          <button
            type="button"
            className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
            disabled={busy}
            onClick={() => run(() => window.api.annotations.delete(worktreePath, annotation.id))}
          >
            Delete
          </button>
        </div>
      </div>
      <div className={styles.body}>{annotation.body}</div>
    </div>
  )
}

export function AnnotationComposer({
  worktreePath,
  filePath,
  side,
  lineNumber,
  lineEnd,
  onCancel,
  onSaved,
}: {
  worktreePath: string
  filePath: string
  side: DiffAnnotationSide
  lineNumber: number
  lineEnd: number
  onCancel: () => void
  onSaved: () => void
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const trimmed = body.trim()
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await window.api.annotations.add(worktreePath, {
        filePath,
        side,
        lineNumber,
        ...(lineEnd > lineNumber ? { lineEnd } : {}),
        body: trimmed,
      })
      setBody('')
      onSaved()
    } catch (e) {
      console.error('Failed to add annotation:', e)
    } finally {
      setBusy(false)
    }
  }

  const sideLabel = side === 'additions' ? 'New' : 'Old'
  const lineLabel =
    lineEnd > lineNumber ? `lines ${lineNumber}–${lineEnd}` : `line ${lineNumber}`

  return (
    <div className={styles.composer} data-diff-annotation-composer>
      <div className={styles.composerLabel}>
        Comment on {sideLabel} {lineLabel}
      </div>
      <textarea
        className={styles.textarea}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Review note…"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <div className={styles.composerActions}>
        <button type="button" className={styles.composerBtn} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.composerBtn} ${styles.composerBtnPrimary}`}
          disabled={busy || !body.trim()}
          onClick={() => void submit()}
        >
          Add comment
        </button>
      </div>
    </div>
  )
}
