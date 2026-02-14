import { useState, useEffect, useCallback, useRef } from 'react'
import type { Project } from '../../store/types'
import { parsePrUrl, parsePrNumber } from '../../../shared/pr-url'
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

/** Check if a string looks like a PR reference (URL or #number) */
function isPrRef(value: string): boolean {
  return parsePrUrl(value) !== null || parsePrNumber(value) !== null
}

/** Extract PR info from a PR reference string */
function extractPrInfo(value: string): { number: number; repoSlug?: string } | null {
  const parsed = parsePrUrl(value)
  if (parsed) return { number: parsed.number, repoSlug: `${parsed.owner}/${parsed.repo}` }
  const num = parsePrNumber(value)
  if (num !== null) return { number: num }
  return null
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
  const [prResolving, setPrResolving] = useState(false)
  const [prError, setPrError] = useState('')
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

  /** Resolve a PR reference to its branch name via gh CLI */
  const resolvePr = useCallback(async (value: string, target: 'branch' | 'baseBranch') => {
    const prInfo = extractPrInfo(value)
    if (prInfo === null) return false

    setPrResolving(true)
    setPrError('')
    try {
      const result = await window.api.github.resolvePr(project.repoPath, prInfo.number, prInfo.repoSlug)
      if (target === 'branch') {
        setSelectedBranch(result.branch)
        setName(`pr-${result.number}`)
      } else {
        setBaseBranch(result.branch)
      }
      setPrError('')
      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to resolve PR'
      setPrError(msg)
      return false
    } finally {
      setPrResolving(false)
    }
  }, [project.repoPath])

  const handleSubmit = useCallback(async () => {
    if (isCreating || prResolving) return
    const branch = isNewBranch ? (newBranchName || name) : selectedBranch
    const base = isNewBranch ? baseBranch : undefined

    // Auto-resolve PR references on submit instead of passing raw URLs as branch names
    if (!isNewBranch && isPrRef(branch)) {
      const resolved = await resolvePr(branch, 'branch')
      // resolvePr updates selectedBranch on success; the user can then submit again
      if (!resolved) return
      // Don't proceed — let the user review the resolved branch and submit again
      return
    }
    if (isNewBranch && base && isPrRef(base)) {
      const resolved = await resolvePr(base, 'baseBranch')
      if (!resolved) return
      return
    }

    onConfirm(name, branch, isNewBranch, base)
  }, [name, isNewBranch, newBranchName, selectedBranch, baseBranch, onConfirm, isCreating, prResolving, resolvePr])

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
    if (e.key === 'Escape') { onCancel(); return }

    if (e.key === 'Enter') {
      // If the focused input has a PR reference, resolve it instead of submitting
      const target = e.target as HTMLInputElement
      if (target.tagName === 'INPUT') {
        const value = target.value.trim()
        if (isPrRef(value)) {
          e.preventDefault()
          e.stopPropagation()
          // Determine which field is focused
          if (isNewBranch) {
            // In new-branch mode, only the base branch input can have a PR ref
            resolvePr(value, 'baseBranch')
          } else {
            // In existing-branch mode, the branch input can have a PR ref
            resolvePr(value, 'branch')
          }
          return
        }
      }
      handleSubmit()
    }
  }, [handleSubmit, onCancel, isCreating, isNewBranch, resolvePr])

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
                onChange={(e) => { setBaseBranch(e.target.value); setPrError('') }}
                disabled={loading || isCreating || prResolving}
                placeholder="Branch name, PR URL, or #123 (press Enter to resolve)"
              />
              {prResolving && <span className={styles.prSpinner} />}
              <button
                className={styles.pickerBtn}
                onClick={() => setBasePickerOpen((v) => !v)}
                disabled={loading || isCreating || prResolving}
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
            {prError && <div className={styles.prError}>{prError}</div>}
          </>
        ) : (
          <>
            <div className={styles.branchInputRow} ref={pickerRef}>
              <input
                className={styles.input}
                value={selectedBranch}
                onChange={(e) => { setSelectedBranch(e.target.value); setPrError('') }}
                disabled={loading || isCreating || prResolving}
                placeholder="Branch name, PR URL, or #123 (press Enter to resolve)"
              />
              {prResolving && <span className={styles.prSpinner} />}
              <button
                className={styles.pickerBtn}
                onClick={() => setPickerOpen((v) => !v)}
                disabled={loading || isCreating || prResolving}
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
                      onClick={() => { setSelectedBranch(b); setPickerOpen(false); setPrError('') }}
                    >
                      {b}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {prError && <div className={styles.prError}>{prError}</div>}
          </>
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
          <button className={styles.createBtn} onClick={handleSubmit} disabled={!name.trim() || isCreating || prResolving}>
            {isCreating ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
