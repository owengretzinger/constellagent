import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project } from '../../store/types'
import styles from './WorkspaceDialog.module.css'

interface Props {
  project: Project
  onConfirm: (name: string, branch: string, newBranch: boolean) => void
  onCancel: () => void
}

export function WorkspaceDialog({ project, onConfirm, onCancel }: Props) {
  const [name, setName] = useState(`ws-${Date.now().toString(36)}`)
  const [branches, setBranches] = useState<string[]>([])
  const [selectedBranch, setSelectedBranch] = useState('main')
  const [isNewBranch, setIsNewBranch] = useState(true)
  const [newBranchName, setNewBranchName] = useState('')
  const [loading, setLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    window.api.git.getBranches(project.repoPath).then((b) => {
      setBranches(b)
      if (b.length > 0 && !b.includes('main')) {
        setSelectedBranch(b[0])
      }
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [project.repoPath])

  const handleSubmit = useCallback(() => {
    const branch = isNewBranch ? (newBranchName || name) : selectedBranch
    onConfirm(name, branch, isNewBranch)
  }, [name, isNewBranch, newBranchName, selectedBranch, onConfirm])

  // Close picker on click outside
  useEffect(() => {
    if (!pickerOpen) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit()
    if (e.key === 'Escape') onCancel()
  }, [handleSubmit, onCancel])

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.title}>New Workspace</div>

        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          placeholder="workspace-name"
        />

        <label className={styles.label}>Branch</label>
        <div className={styles.branchToggle}>
          <button
            className={`${styles.toggleBtn} ${isNewBranch ? styles.active : ''}`}
            onClick={() => setIsNewBranch(true)}
          >
            New branch
          </button>
          <button
            className={`${styles.toggleBtn} ${!isNewBranch ? styles.active : ''}`}
            onClick={() => setIsNewBranch(false)}
          >
            Existing
          </button>
        </div>

        {isNewBranch ? (
          <input
            className={styles.input}
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            placeholder={name || 'branch-name'}
          />
        ) : (
          <div className={styles.branchInputRow} ref={pickerRef}>
            <input
              className={styles.input}
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              disabled={loading}
              placeholder="Branch name"
            />
            <button
              className={styles.pickerBtn}
              onClick={() => setPickerOpen((v) => !v)}
              disabled={loading}
              type="button"
            >
              &#9662;
            </button>
            {pickerOpen && (
              <div className={styles.pickerDropdown}>
                {branches.map((b) => (
                  <div
                    key={b}
                    className={`${styles.pickerOption} ${b === selectedBranch ? styles.pickerOptionActive : ''}`}
                    onClick={() => { setSelectedBranch(b); setPickerOpen(false) }}
                  >
                    {b}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button className={styles.createBtn} onClick={handleSubmit} disabled={!name.trim()}>
            Create
          </button>
        </div>
      </div>
    </div>
  )
}
