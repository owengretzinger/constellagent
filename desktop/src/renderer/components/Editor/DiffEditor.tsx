import { useEffect, useState, useCallback, useRef, memo } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import { useAppStore } from '../../store/app-store'
import type { WorkingTreeDiffEntry } from '@shared/diff-types'
import styles from './Editor.module.css'

interface Props {
  worktreePath: string
  active: boolean
}

const STATUS_LABELS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

// ── Per-file diff section ──

interface DiffFileSectionProps {
  data: WorkingTreeDiffEntry
  inline: boolean
  worktreePath: string
  onOpenFile: (filePath: string) => void
}

const DiffFileSection = memo(function DiffFileSection({
  data,
  inline,
  worktreePath,
  onOpenFile,
}: DiffFileSectionProps) {
  const parts = data.path.split('/')
  const fileName = parts.pop()
  const dir = parts.length > 0 ? parts.join('/') + '/' : ''

  const fullPath = data.path.startsWith('/')
    ? data.path
    : `${worktreePath}/${data.path}`

  const notice = data.isBinary
    ? 'Non-text file. Diff not shown.'
    : data.tooLarge
      ? 'File too large to diff.'
      : null

  return (
    <div className={styles.diffFileSection} id={`diff-${data.path}`}>
      <div
        className={styles.fileHeader}
        onClick={() => onOpenFile(fullPath)}
      >
        <span className={`${styles.fileHeaderBadge} ${styles[data.status] || ''}`}>
          {STATUS_LABELS[data.status] || '?'}
        </span>
        <span className={styles.fileHeaderPath}>
          {dir && <span className={styles.fileHeaderDir}>{dir}</span>}
          {fileName}
        </span>
      </div>
      {notice ? (
        <div className={styles.binaryDiffNotice}>
          <span className={styles.binaryDiffNoticeText}>{notice}</span>
        </div>
      ) : (
        <PatchDiff
          patch={data.patch}
          options={{
            theme: 'tokyo-night',
            themeType: 'dark',
            diffStyle: inline ? 'unified' : 'split',
            diffIndicators: 'bars',
            lineDiffType: 'word-alt',
            overflow: 'scroll',
            expandUnchanged: false,
            disableFileHeader: true,
          }}
        />
      )}
    </div>
  )
})

// ── File strip (jump nav) ──

function FileStrip({
  files,
  activeFile,
}: {
  files: WorkingTreeDiffEntry[]
  activeFile: string | null
}) {
  const scrollTo = (filePath: string) => {
    const el = document.getElementById(`diff-${filePath}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className={styles.fileStrip}>
      {files.map((f) => (
        <button
          key={f.path}
          className={`${styles.fileStripItem} ${f.path === activeFile ? styles.active : ''}`}
          onClick={() => scrollTo(f.path)}
        >
          {f.path.split('/').pop()}
        </button>
      ))}
    </div>
  )
}

// ── Main DiffViewer ──

export function DiffViewer({ worktreePath, active }: Props) {
  const [files, setFiles] = useState<WorkingTreeDiffEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openFileTab = useAppStore((s) => s.openFileTab)
  const inline = settings.diffInline

  const loadFiles = useCallback(async () => {
    try {
      const results = await window.api.git.getWorkingTreeDiff(worktreePath)
      setFiles(results)
    } catch (err) {
      console.error('Failed to load diffs:', err)
    } finally {
      setLoading(false)
    }
  }, [worktreePath])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // Auto-refresh on filesystem changes
  useEffect(() => {
    window.api.fs.watchDir(worktreePath)
    const unsub = window.api.fs.onDirChanged((changedDir: string) => {
      if (changedDir === worktreePath) loadFiles()
    })
    return () => {
      unsub()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, loadFiles])

  // Listen for scroll-to-file events from ChangedFiles panel
  useEffect(() => {
    const handler = (e: Event) => {
      const filePath = (e as CustomEvent<string>).detail
      // Small delay to let tab render if newly created
      requestAnimationFrame(() => {
        const el = document.getElementById(`diff-${filePath}`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
    window.addEventListener('diff:scrollToFile', handler)
    return () => window.removeEventListener('diff:scrollToFile', handler)
  }, [])

  // IntersectionObserver to highlight active file in strip
  useEffect(() => {
    if (!scrollAreaRef.current || files.length === 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = entry.target.id
            if (id.startsWith('diff-')) {
              setActiveFile(id.slice(5))
            }
          }
        }
      },
      { root: scrollAreaRef.current, threshold: 0.3 },
    )

    for (const f of files) {
      const el = document.getElementById(`diff-${f.path}`)
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [files])

  if (loading) {
    return (
      <div className={styles.diffViewerContainer}>
        <div className={styles.diffEmpty}>
          <span className={styles.diffEmptyText}>Loading changes...</span>
        </div>
      </div>
    )
  }

  if (files.length === 0) {
    return (
      <div className={styles.diffViewerContainer}>
        <div className={styles.diffEmpty}>
          <span className={styles.diffEmptyIcon}>&#10003;</span>
          <span className={styles.diffEmptyText}>No changes</span>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.diffViewerContainer}>
      {/* Toolbar */}
      <div className={styles.diffToolbar}>
        <span className={styles.diffFileCount}>
          {files.length} changed file{files.length !== 1 ? 's' : ''}
        </span>
        <div className={styles.diffToggle}>
          <button
            className={`${styles.diffToggleOption} ${!inline ? styles.active : ''}`}
            onClick={() => updateSettings({ diffInline: false })}
          >
            Side by side
          </button>
          <button
            className={`${styles.diffToggleOption} ${inline ? styles.active : ''}`}
            onClick={() => updateSettings({ diffInline: true })}
          >
            Inline
          </button>
        </div>
      </div>

      {/* File strip */}
      <FileStrip files={files} activeFile={activeFile} />

      {/* Stacked diffs */}
      <div ref={scrollAreaRef} className={styles.diffScrollArea}>
        {files.map((f) => (
          <DiffFileSection
            key={f.path}
            data={f}
            inline={inline}
            worktreePath={worktreePath}
            onOpenFile={openFileTab}
          />
        ))}
      </div>
    </div>
  )
}
