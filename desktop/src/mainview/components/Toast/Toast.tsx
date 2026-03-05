import { useEffect } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Toast } from '../../store/types'
import styles from './Toast.module.css'

function ToastItem({ toast }: { toast: Toast }) {
  const dismissToast = useAppStore((s) => s.dismissToast)

  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), 5000)
    return () => clearTimeout(timer)
  }, [toast.id, dismissToast])

  return (
    <div
      className={`${styles.toast} ${styles[toast.type]}`}
      onClick={() => dismissToast(toast.id)}
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
