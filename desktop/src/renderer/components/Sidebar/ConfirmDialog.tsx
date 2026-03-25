import { useCallback, useEffect, useState } from 'react'
import styles from './ConfirmDialog.module.css'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
  destructive?: boolean
  tip?: string
  loading?: boolean
  secondaryConfirmLabel?: string
  onSecondaryConfirm?: () => void
}

const EXIT_DURATION = 150

export function ConfirmDialog({ title, message, confirmLabel = 'Delete', onConfirm, onCancel, destructive = false, tip, loading = false, secondaryConfirmLabel, onSecondaryConfirm }: Props) {
  const [exiting, setExiting] = useState(false)

  const animateExit = useCallback((cb: () => void) => {
    if (exiting) return
    setExiting(true)
    setTimeout(() => cb(), EXIT_DURATION)
  }, [exiting])

  const handleCancel = useCallback(() => {
    if (loading) return
    animateExit(onCancel)
  }, [loading, animateExit, onCancel])

  const handleConfirm = useCallback(() => {
    if (loading) return
    animateExit(onConfirm)
  }, [loading, animateExit, onConfirm])

  const handleSecondary = useCallback(() => {
    if (loading || !onSecondaryConfirm) return
    animateExit(onSecondaryConfirm)
  }, [loading, animateExit, onSecondaryConfirm])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (loading || exiting) return
    if (e.key === 'Escape') handleCancel()
    if (e.key === 'Enter') {
      e.preventDefault()
      handleConfirm()
    }
  }, [handleConfirm, handleCancel, loading, exiting])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const btnClass = destructive ? styles.destructiveBtn : styles.confirmBtn

  return (
    <div className={`${styles.overlay} ${exiting ? styles.overlayExiting : ''}`} onClick={loading ? undefined : handleCancel}>
      <div className={`${styles.dialog} ${exiting ? styles.dialogExiting : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className={styles.title}>{title}</div>
        <div className={styles.message}>{message}</div>
        {tip && <div className={styles.tip}>{tip}</div>}
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={handleCancel} disabled={loading || exiting}>Cancel</button>
          {secondaryConfirmLabel && onSecondaryConfirm && (
            <button
              className={`${styles.secondaryBtn} ${loading ? styles.btnLoading : ''}`}
              onClick={handleSecondary}
              disabled={loading || exiting}
            >
              {secondaryConfirmLabel}
            </button>
          )}
          <button
            className={`${btnClass} ${loading ? styles.btnLoading : ''}`}
            onClick={handleConfirm}
            autoFocus
            disabled={loading || exiting}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
