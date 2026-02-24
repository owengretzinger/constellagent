import { useState, useCallback } from 'react'
import styles from './AddRemoteProjectDialog.module.css'

interface Props {
  onConfirm: (host: string, remotePath: string) => void
  onCancel: () => void
  isSubmitting?: boolean
}

export function AddRemoteProjectDialog({ onConfirm, onCancel, isSubmitting = false }: Props) {
  const [host, setHost] = useState('')
  const [remotePath, setRemotePath] = useState('')

  const handleSubmit = useCallback(() => {
    const trimmedHost = host.trim()
    const trimmedPath = remotePath.trim()
    if (!trimmedHost || !trimmedPath || isSubmitting) return
    onConfirm(trimmedHost, trimmedPath)
  }, [host, remotePath, isSubmitting, onConfirm])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && !isSubmitting) onCancel()
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }, [handleSubmit, isSubmitting, onCancel])

  const canSubmit = host.trim().length > 0 && remotePath.trim().length > 0 && !isSubmitting

  return (
    <div className={styles.overlay} onClick={() => { if (!isSubmitting) onCancel() }}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.title}>Add Remote Project</div>
        <div className={styles.hint}>
          Connect using an SSH host alias from your <code>~/.ssh/config</code>.
        </div>

        <label className={styles.label}>SSH Host Alias</label>
        <input
          className={styles.input}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="mini"
          autoFocus
          disabled={isSubmitting}
        />

        <label className={styles.label}>Remote Repo Path</label>
        <input
          className={styles.input}
          value={remotePath}
          onChange={(e) => setRemotePath(e.target.value)}
          placeholder="/Users/you/dev/repo"
          disabled={isSubmitting}
        />

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </button>
          <button className={styles.addBtn} onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting ? 'Adding...' : 'Add Remote'}
          </button>
        </div>
      </div>
    </div>
  )
}
