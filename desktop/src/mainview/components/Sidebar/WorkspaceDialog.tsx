import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project } from '../../store/types'
import styles from './WorkspaceDialog.module.css'

/** Live-sanitize a string into a valid git branch name as the user types */
function toBranchName(input: string): string {
  return input
    .replace(/\s+/g, '-')
    .replace(/[\x00-\x1f\x7f~^:?*[\]\\]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
}

interface Props {
  project: Project
  onConfirm: (name: string, branch: string, newBranch: boolean, baseBranch?: string) => void
  onCancel: () => void
  isCreating?: boolean
  createProgressMessage?: string
  showSlowCreateMessage?: boolean
}

export function WorkspaceDialog({
  project,
  onConfirm,
  onCancel,
  isCreating = false,
  createProgressMessage = '',
  showSlowCreateMessage = false,
}: Props) {
  const [name, setName] = useState(`ws-${Date.now().toString(36)}`)
  const [branches, setBranches] = useState<string[]>([])
  const [selectedBranch, setSelectedBranch] = useState('')
  const [isNewBranch, setIsNewBranch] = useState(true)
  const [newBranchName, setNewBranchName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [loading, setLoading] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [basePickerOpen, setBasePickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)
  const basePickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const loadBranches = async () => {
      try {
        // Detect default branch from remote
        const defaultBranch = await window.api.git.getDefaultBranch(project.repoPath)
          .then((ref) => ref.replace(/^origin\//, ''))
          .catch(() => '')

        const b = await window.api.git.getBranches(project.repoPath).catch(() => [] as string[])
        setBranches(b)

        if (defaultBranch && b.includes(defaultBranch)) {
          setSelectedBranch(defaultBranch)
          setBaseBranch(defaultBranch)
        } else if (b.length > 0) {
          setSelectedBranch(b[0])
          setBaseBranch(b[0])
        }
      } finally {
        setLoading(false)
      }
    }
    loadBranches()
  }, [project.repoPath])

  const handleSubmit = useCallback(() => {
    if (isCreating) return
    const branch = isNewBranch ? (newBranchName || name) : selectedBranch
    onConfirm(name, branch, isNewBranch, isNewBranch ? baseBranch : undefined)
  }, [name, isNewBranch, newBranchName, selectedBranch, baseBranch, onConfirm, isCreating])

  // Close pickers on click outside
  useEffect(() => {
    if (!pickerOpen && !basePickerOpen) return
    const handler = (e: MouseEvent) => {
      if (pickerOpen && pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
      if (basePickerOpen && basePickerRef.current && !basePickerRef.current.contains(e.target as Node)) {
        setBasePickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen, basePickerOpen])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isCreating) return
    if (e.key === 'Enter') handleSubmit()
    if (e.key === 'Escape') onCancel()
  }, [handleSubmit, onCancel, isCreating])

  return (
    <div className={styles.overlay} onClick={() => { if (!isCreating) onCancel() }}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className={styles.title}>New Workspace</div>

        <label className={styles.label}>Name</label>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          disabled={isCreating}
          placeholder="workspace-name"
        />

        <label className={styles.label}>Branch</label>
        <div className={styles.branchToggle}>
          <button
            className={`${styles.toggleBtn} ${isNewBranch ? styles.active : ''}`}
            onClick={() => setIsNewBranch(true)}
            disabled={isCreating}
          >
            New branch
          </button>
          <button
            className={`${styles.toggleBtn} ${!isNewBranch ? styles.active : ''}`}
            onClick={() => setIsNewBranch(false)}
            disabled={isCreating}
          >
            Existing
          </button>
        </div>

        {isNewBranch ? (
          <>
            <input
              className={styles.input}
              value={newBranchName}
              onChange={(e) => setNewBranchName(toBranchName(e.target.value))}
              disabled={isCreating}
              placeholder={toBranchName(name) || 'branch-name'}
            />
            <label className={styles.label}>Base branch</label>
            <div className={styles.branchInputRow} ref={basePickerRef}>
              <input
                className={styles.input}
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                disabled={loading || isCreating}
                placeholder="Base branch"
              />
              <button
                className={styles.pickerBtn}
                onClick={() => setBasePickerOpen((v) => !v)}
                disabled={loading || isCreating}
                type="button"
              >
                &#9662;
              </button>
              {basePickerOpen && (
                <div className={styles.pickerDropdown}>
                  {branches.map((b) => (
                    <div
                      key={b}
                      className={`${styles.pickerOption} ${b === baseBranch ? styles.pickerOptionActive : ''}`}
                      onClick={() => { setBaseBranch(b); setBasePickerOpen(false) }}
                    >
                      {b}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className={styles.branchInputRow} ref={pickerRef}>
            <input
              className={styles.input}
              value={selectedBranch}
              onChange={(e) => setSelectedBranch(e.target.value)}
              disabled={loading || isCreating}
              placeholder="Branch name"
            />
            <button
              className={styles.pickerBtn}
              onClick={() => setPickerOpen((v) => !v)}
              disabled={loading || isCreating}
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

        {isCreating && (
          <div className={styles.createStatus} role="status" aria-live="polite">
            <span className={styles.createSpinner} />
            <span>{createProgressMessage || 'Creating workspace...'}</span>
          </div>
        )}
        {isCreating && showSlowCreateMessage && (
          <div className={styles.createSlowNote}>
            Taking longer than usual. Git network sync may be slow.
          </div>
        )}

        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel} disabled={isCreating}>Cancel</button>
          <button className={styles.createBtn} onClick={handleSubmit} disabled={!name.trim() || isCreating}>
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
