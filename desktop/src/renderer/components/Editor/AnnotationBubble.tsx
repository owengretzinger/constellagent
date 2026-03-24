import { useState, useRef, useEffect, type ReactNode } from 'react'
import type { Annotation } from '../../../shared/diff-annotation-types'
import type { DiffLineAnnotation } from '@pierre/diffs'
import styles from './AnnotationBubble.module.css'

// ── Existing annotation display ──

interface AnnotationBubbleProps {
  annotation: DiffLineAnnotation<Annotation>
  onResolve: (id: string) => void
  onDelete: (id: string) => void
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}

export function AnnotationBubble({ annotation, onResolve, onDelete }: AnnotationBubbleProps): ReactNode {
  const a = annotation.metadata
  return (
    <div className={`${styles.annotationBubble} ${a.resolved ? styles.resolved : ''}`}>
      <div className={styles.annotationHeader}>
        <span className={styles.annotationAuthor}>{a.author}</span>
        <span className={styles.annotationTime}>{formatTime(a.createdAt)}</span>
      </div>
      <div className={styles.annotationBody}>{a.body}</div>
      <div className={styles.annotationActions}>
        {!a.resolved && (
          <button className={`${styles.annotationBtn} ${styles.resolveBtn}`} onClick={() => onResolve(a.id)}>
            Resolve
          </button>
        )}
        <button className={`${styles.annotationBtn} ${styles.deleteBtn}`} onClick={() => onDelete(a.id)}>
          Delete
        </button>
      </div>
    </div>
  )
}

// ── Inline input for creating a new annotation ──

interface AnnotationInputProps {
  onSubmit: (body: string) => void
  onCancel: () => void
}

export function AnnotationInput({ onSubmit, onCancel }: AnnotationInputProps): ReactNode {
  const [body, setBody] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (body.trim()) onSubmit(body.trim())
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className={styles.annotationInput}>
      <textarea
        ref={textareaRef}
        className={styles.annotationTextarea}
        placeholder="Add a review comment..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className={styles.annotationInputActions}>
        <button className={styles.cancelBtn} onClick={onCancel}>
          Cancel
        </button>
        <button
          className={styles.submitBtn}
          disabled={!body.trim()}
          onClick={() => onSubmit(body.trim())}
        >
          Comment
        </button>
      </div>
    </div>
  )
}
