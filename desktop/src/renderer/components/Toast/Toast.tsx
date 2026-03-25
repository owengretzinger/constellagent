import { useEffect, useState, useCallback, useRef } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Toast } from '../../store/types'
import styles from './Toast.module.css'

const EXIT_MS = 150

function ToastItem({ toast }: { toast: Toast }) {
  const dismissToast = useAppStore((s) => s.dismissToast)
  const [exiting, setExiting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  const startExit = useCallback(() => {
    if (exiting) return
    setExiting(true)
    timerRef.current = setTimeout(() => dismissToast(toast.id), EXIT_MS)
  }, [exiting, dismissToast, toast.id])

  useEffect(() => {
    const timer = setTimeout(startExit, 5000)
    return () => { clearTimeout(timer); clearTimeout(timerRef.current) }
  }, [toast.id, startExit])

  return (
    <div
      className={`${styles.toast} ${styles[toast.type]} ${exiting ? styles.exiting : ''}`}
      onClick={startExit}
    >
      <span className={styles.message}>{toast.message}</span>
    </div>
  )
}

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts)
  if (toasts.length === 0) return null

  return (
    <div className={styles.container}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
