import { useEffect, useState, useCallback } from 'react'
import { useAppStore } from '../../store/app-store'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './RightPanel.module.css'

interface FileStatus {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

interface Props {
  worktreePath: string
  workspaceId: string
  isActive?: boolean
}

const STATUS_LABELS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

export function ChangedFiles({ worktreePath, workspaceId, isActive }: Props) {
  const [files, setFiles] = useState<FileStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [commitMsg, setCommitMsg] = useState('')
  const openDiffTab = useAppStore((s) => s.openDiffTab)
  const setGitFileStatuses = useAppStore((s) => s.setGitFileStatuses)

  const refresh = useCallback(() => {
    window.api.git.getStatus(worktreePath).then(setFiles).catch(() => {})
  }, [worktreePath])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.git.getStatus(worktreePath).then((statuses) => {
      if (!cancelled) {
        setFiles(statuses)
        setLoading(false)
      }
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [worktreePath])

  // Watch filesystem for changes and auto-refresh
  useEffect(() => {
    window.api.fs.watchDir(worktreePath)

    const cleanup = window.api.fs.onDirChanged((changedPath) => {
      if (changedPath === worktreePath) {
        refresh()
      }
    })

    return () => {
      cleanup()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, refresh])

  // Re-fetch when tab becomes visible (git ops only touch .git/ which the watcher ignores)
  useEffect(() => {
    if (isActive) refresh()
  }, [isActive, refresh])

  // Push git file statuses to Zustand store for tab badges
  useEffect(() => {
    const statusMap = new Map<string, string>()
    for (const f of files) {
      statusMap.set(f.path, f.status)
    }
    setGitFileStatuses(worktreePath, statusMap)
  }, [files, worktreePath, setGitFileStatuses])

  const staged = files.filter((f) => f.staged)
  const unstaged = files.filter((f) => !f.staged)

  const runGitOp = useCallback(async (op: () => Promise<void>) => {
    setBusy(true)
    try {
      await op()
    } catch (err) {
      console.error('[ChangedFiles] git operation failed:', err)
    } finally {
      refresh()
      setBusy(false)
    }
  }, [refresh])

  const stageFiles = useCallback((paths: string[]) => {
    runGitOp(() => window.api.git.stage(worktreePath, paths))
  }, [worktreePath, runGitOp])

  const unstageFiles = useCallback((paths: string[]) => {
    runGitOp(() => window.api.git.unstage(worktreePath, paths))
  }, [worktreePath, runGitOp])

  const discardFiles = useCallback((file: FileStatus) => {
    const op = file.status === 'untracked'
      ? () => window.api.git.discard(worktreePath, [], [file.path])
      : () => window.api.git.discard(worktreePath, [file.path], [])
    runGitOp(async () => {
      await op()
      window.dispatchEvent(new CustomEvent('git:files-changed', {
        detail: { worktreePath, paths: [file.path] },
      }))
    })
  }, [worktreePath, runGitOp])

  const handleCommit = useCallback(() => {
    if (!commitMsg.trim() || staged.length === 0) return
    const committedPaths = staged.map((f) => f.path)
    runGitOp(async () => {
      await window.api.git.commit(worktreePath, commitMsg.trim())
      setCommitMsg('')
      window.dispatchEvent(new CustomEvent('git:files-changed', {
        detail: { worktreePath, paths: committedPaths },
      }))
    })
  }, [worktreePath, commitMsg, staged, runGitOp])

  const openDiff = useCallback((path: string) => {
    openDiffTab(workspaceId)
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('diff:scrollToFile', { detail: path }))
    })
  }, [openDiffTab, workspaceId])

  if (loading) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyText}>Checking changes...</span>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className={styles.emptyState}>
        <span className={styles.emptyIcon}>✓</span>
        <span className={styles.emptyText}>No changes</span>
      </div>
    )
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleCommit()
    }
  }

  return (
    <div className={styles.changedFilesList}>
      {/* Commit input */}
      <div className={styles.commitArea}>
        <textarea
          className={styles.commitInput}
          placeholder="Commit message"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
        />
        <Tooltip label="Commit staged changes" shortcut="⌘↵">
          <button
            className={styles.commitButton}
            disabled={busy || !commitMsg.trim() || staged.length === 0}
            onClick={handleCommit}
          >
            Commit
          </button>
        </Tooltip>
      </div>

      {/* Staged section */}
      {staged.length > 0 && (
        <div className={styles.changeSection}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionLabel}>Staged Changes</span>
            <span className={styles.sectionCount}>{staged.length}</span>
            <span className={styles.sectionActions}>
              <Tooltip label="Unstage All">
                <button
                  className={styles.sectionAction}
                  disabled={busy}
                  onClick={() => unstageFiles(staged.map((f) => f.path))}
                >
                  −
                </button>
              </Tooltip>
            </span>
          </div>
          {staged.map((file) => (
            <FileRow
              key={`staged-${file.path}`}
              file={file}
              busy={busy}
              onAction={() => unstageFiles([file.path])}
              actionLabel="−"
              actionTitle="Unstage"
              onOpenDiff={openDiff}
            />
          ))}
        </div>
      )}

      {/* Unstaged section */}
      {unstaged.length > 0 && (
        <div className={styles.changeSection}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionLabel}>Changes</span>
            <span className={styles.sectionCount}>{unstaged.length}</span>
            <span className={styles.sectionActions}>
              <Tooltip label="Discard All">
                <button
                  className={styles.sectionAction}
                  disabled={busy}
                  onClick={() => {
                    const tracked = unstaged.filter((f) => f.status !== 'untracked').map((f) => f.path)
                    const untracked = unstaged.filter((f) => f.status === 'untracked').map((f) => f.path)
                    const allPaths = unstaged.map((f) => f.path)
                    runGitOp(async () => {
                      await window.api.git.discard(worktreePath, tracked, untracked)
                      window.dispatchEvent(new CustomEvent('git:files-changed', {
                        detail: { worktreePath, paths: allPaths },
                      }))
                    })
                  }}
                >
                  ↩
                </button>
              </Tooltip>
              <Tooltip label="Stage All">
                <button
                  className={styles.sectionAction}
                  disabled={busy}
                  onClick={() => stageFiles(unstaged.map((f) => f.path))}
                >
                  +
                </button>
              </Tooltip>
            </span>
          </div>
          {unstaged.map((file) => (
            <FileRow
              key={`unstaged-${file.path}`}
              file={file}
              busy={busy}
              onAction={() => stageFiles([file.path])}
              actionLabel="+"
              actionTitle="Stage"
              onDiscard={() => discardFiles(file)}
              onOpenDiff={openDiff}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FileRow({
  file,
  busy,
  onAction,
  actionLabel,
  actionTitle,
  onDiscard,
  onOpenDiff,
}: {
  file: FileStatus
  busy: boolean
  onAction: () => void
  actionLabel: string
  actionTitle: string
  onDiscard?: () => void
  onOpenDiff: (path: string) => void
}) {
  const parts = file.path.split('/')
  const fileName = parts.pop()
  const dir = parts.length > 0 ? parts.join('/') + '/' : ''

  return (
    <div className={styles.changedFile}>
      <span className={`${styles.statusBadge} ${styles[file.status]}`}>
        {STATUS_LABELS[file.status]}
      </span>
      <span
        className={styles.changePath}
        onClick={() => onOpenDiff(file.path)}
      >
        {dir && <span className={styles.changeDir}>{dir}</span>}
        {fileName}
      </span>
      <span className={styles.fileActions}>
        {onDiscard && (
          <Tooltip label="Discard Changes">
            <button
              className={styles.fileActionBtn}
              disabled={busy}
              onClick={onDiscard}
            >
              ↩
            </button>
          </Tooltip>
        )}
        <Tooltip label={actionTitle}>
          <button
            className={styles.fileActionBtn}
            disabled={busy}
            onClick={onAction}
          >
            {actionLabel}
          </button>
        </Tooltip>
      </span>
    </div>
  )
}
