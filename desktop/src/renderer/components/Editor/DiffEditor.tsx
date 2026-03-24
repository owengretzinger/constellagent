import { useEffect, useState, useCallback, useRef, memo, useMemo } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import type { DiffLineAnnotation, AnnotationSide } from '@pierre/diffs'
import { useAppStore } from '../../store/app-store'
import { isMarkdownDocumentPath } from '../../utils/markdown-path'
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary'
import { AnnotationBubble, AnnotationInput } from './AnnotationBubble'
import type { Annotation } from '../../../shared/diff-annotation-types'
import { generateAnnotationId } from '../../../shared/diff-annotation-types'
import styles from './Editor.module.css'

interface FileStatus {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  staged: boolean
}

interface DiffFileData {
  filePath: string
  patch: string
  status: string
}

interface Props {
  worktreePath: string
  active: boolean
  commitHash?: string
  commitMessage?: string
}

const STATUS_LABELS: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

// ── Per-file diff section ──

interface PendingAnnotation {
  line: number
  side: AnnotationSide
}

interface DiffFileSectionProps {
  data: DiffFileData
  inline: boolean
  worktreePath: string
  onOpenFile: (filePath: string) => void
  annotations: Annotation[]
  onAddAnnotation: (file: string, line: number, side: AnnotationSide, body: string) => void
  onResolveAnnotation: (id: string) => void
  onDeleteAnnotation: (id: string) => void
}

const DiffFileSection = memo(function DiffFileSection({
  data,
  inline,
  worktreePath,
  onOpenFile,
  annotations,
  onAddAnnotation,
  onResolveAnnotation,
  onDeleteAnnotation,
}: DiffFileSectionProps) {
  const [pending, setPending] = useState<PendingAnnotation | null>(null)
  const parts = data.filePath.split('/')
  const fileName = parts.pop()
  const dir = parts.length > 0 ? parts.join('/') + '/' : ''

  const fullPath = data.filePath.startsWith('/')
    ? data.filePath
    : `${worktreePath}/${data.filePath}`

  // Filter annotations for this file and map to Pierre's format
  const fileAnnotations = useMemo(() => {
    return annotations
      .filter((a) => a.file === data.filePath)
      .map((a): DiffLineAnnotation<Annotation> => ({
        side: a.side,
        lineNumber: a.line,
        metadata: a,
      }))
  }, [annotations, data.filePath])

  // Include pending annotation as a temporary annotation for input rendering
  const allAnnotations = useMemo(() => {
    if (!pending) return fileAnnotations
    // Add a placeholder for the pending input
    const placeholder: DiffLineAnnotation<Annotation> = {
      side: pending.side,
      lineNumber: pending.line,
      metadata: {
        id: '__pending__',
        file: data.filePath,
        line: pending.line,
        side: pending.side,
        body: '',
        author: 'human',
        resolved: false,
        createdAt: new Date().toISOString(),
      },
    }
    return [...fileAnnotations, placeholder]
  }, [fileAnnotations, pending, data.filePath])

  const handleLineNumberClick = useCallback(
    (props: { lineNumber: number; annotationSide: AnnotationSide }) => {
      setPending({ line: props.lineNumber, side: props.annotationSide })
    },
    [],
  )

  const handleSubmit = useCallback(
    (body: string) => {
      if (!pending) return
      onAddAnnotation(data.filePath, pending.line, pending.side, body)
      setPending(null)
    },
    [pending, data.filePath, onAddAnnotation],
  )

  const handleCancel = useCallback(() => setPending(null), [])

  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<Annotation>) => {
      const a = annotation.metadata
      if (a.id === '__pending__') {
        return <AnnotationInput onSubmit={handleSubmit} onCancel={handleCancel} />
      }
      return (
        <AnnotationBubble
          annotation={annotation}
          onResolve={onResolveAnnotation}
          onDelete={onDeleteAnnotation}
        />
      )
    },
    [handleSubmit, handleCancel, onResolveAnnotation, onDeleteAnnotation],
  )

  return (
    <div className={styles.diffFileSection} id={`diff-${data.filePath}`}>
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
      {data.patch ? (
        <ErrorBoundary
          fallback={
            <div style={{ padding: 12, color: '#888', fontSize: 13 }}>
              Failed to render diff for this file.
            </div>
          }
        >
          <PatchDiff<Annotation>
            patch={data.patch}
            lineAnnotations={allAnnotations}
            renderAnnotation={renderAnnotation}
            options={{
              theme: 'tokyo-night',
              themeType: 'dark',
              diffStyle: inline ? 'unified' : 'split',
              diffIndicators: 'bars',
              lineDiffType: 'word-alt',
              overflow: 'scroll',
              expandUnchanged: false,
              disableFileHeader: true,
              onLineNumberClick: handleLineNumberClick,
            }}
          />
        </ErrorBoundary>
      ) : (
        <div style={{ padding: 12, color: '#888', fontSize: 13 }}>No diff available</div>
      )}
    </div>
  )
})

// ── File strip (jump nav) ──

function FileStrip({
  files,
  activeFile,
}: {
  files: DiffFileData[]
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
          key={f.filePath}
          className={`${styles.fileStripItem} ${f.filePath === activeFile ? styles.active : ''}`}
          onClick={() => scrollTo(f.filePath)}
        >
          {f.filePath.split('/').pop()}
        </button>
      ))}
    </div>
  )
}

// ── Main DiffViewer ──

export function DiffViewer({ worktreePath, active, commitHash, commitMessage }: Props) {
  const [files, setFiles] = useState<DiffFileData[]>([])
  const [loading, setLoading] = useState(true)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openFileTab = useAppStore((s) => s.openFileTab)
  const openMarkdownPreview = useAppStore((s) => s.openMarkdownPreview)
  const inline = settings.diffInline

  const openFileFromDiff = useCallback(
    (fullPath: string) => {
      if (isMarkdownDocumentPath(fullPath)) openMarkdownPreview(fullPath)
      else openFileTab(fullPath)
    },
    [openFileTab, openMarkdownPreview],
  )

  // ── Annotations ──

  const loadAnnotations = useCallback(async () => {
    try {
      const loaded = await window.api.annotations.load(worktreePath)
      setAnnotations(loaded)
    } catch (err) {
      console.error('Failed to load annotations:', err)
    }
  }, [worktreePath])

  // Load annotations on mount and when worktree changes
  useEffect(() => {
    loadAnnotations()
  }, [loadAnnotations])

  // Listen for annotation changes from the main process (file watcher)
  useEffect(() => {
    const unsub = window.api.annotations.onChanged((data) => {
      if (data.worktreePath === worktreePath) {
        setAnnotations(data.annotations)
      }
    })
    return unsub
  }, [worktreePath])

  const handleAddAnnotation = useCallback(
    async (file: string, line: number, side: AnnotationSide, body: string) => {
      const annotation: Annotation = {
        id: generateAnnotationId(),
        file,
        line,
        side,
        body,
        author: 'human',
        resolved: false,
        createdAt: new Date().toISOString(),
      }
      try {
        const updated = await window.api.annotations.add(worktreePath, annotation)
        setAnnotations(updated)
      } catch (err) {
        console.error('Failed to save annotation:', err)
      }
    },
    [worktreePath],
  )

  const handleResolveAnnotation = useCallback(
    async (id: string) => {
      try {
        const updated = await window.api.annotations.resolve(worktreePath, id)
        setAnnotations(updated)
      } catch (err) {
        console.error('Failed to resolve annotation:', err)
      }
    },
    [worktreePath],
  )

  const handleDeleteAnnotation = useCallback(
    async (id: string) => {
      try {
        const updated = await window.api.annotations.delete(worktreePath, id)
        setAnnotations(updated)
      } catch (err) {
        console.error('Failed to delete annotation:', err)
      }
    },
    [worktreePath],
  )

  // Load commit-specific diff
  const loadCommitDiff = useCallback(async () => {
    if (!commitHash) return
    try {
      const patchOutput = await window.api.git.getCommitDiff(worktreePath, commitHash)
      if (!patchOutput) {
        setFiles([])
        return
      }
      // Split by file boundaries
      const parts = patchOutput.split(/^diff --git /m).filter(Boolean)
      const results: DiffFileData[] = parts.map((part) => {
        const firstLine = part.split('\n')[0]
        const match = firstLine.match(/b\/(.+)$/)
        const filePath = match ? match[1] : 'unknown'
        return {
          filePath,
          patch: 'diff --git ' + part,
          status: 'modified', // commit diffs don't distinguish status easily
        }
      })
      setFiles(results)
    } catch (err) {
      console.error('Failed to load commit diff:', err)
    } finally {
      setLoading(false)
    }
  }, [worktreePath, commitHash])

  // Load working-tree changed files
  const loadFiles = useCallback(async () => {
    if (commitHash) return // handled by loadCommitDiff
    try {
      const statuses: FileStatus[] = await window.api.git.getStatus(worktreePath)
      const results = await Promise.all(
        statuses.map(async (file) => {
          let patch = await window.api.git.getFileDiff(worktreePath, file.path)

          // For added/untracked files, git diff returns empty — build synthetic patch
          if (!patch && (file.status === 'added' || file.status === 'untracked')) {
            const fullPath = file.path.startsWith('/')
              ? file.path
              : `${worktreePath}/${file.path}`
            const content = await window.api.fs.readFile(fullPath)
            if (content === null) return { filePath: file.path, patch: '', status: file.status }
            const lines = content.split('\n')
            patch = [
              `--- /dev/null`,
              `+++ b/${file.path}`,
              `@@ -0,0 +1,${lines.length} @@`,
              ...lines.map((l: string) => `+${l}`),
            ].join('\n')
          }

          // For deleted files with no diff, build synthetic removal patch
          if (!patch && file.status === 'deleted') {
            patch = `--- a/${file.path}\n+++ /dev/null\n@@ -1,0 +0,0 @@\n`
          }

          return { filePath: file.path, patch: patch || '', status: file.status }
        }),
      )
      setFiles(results)
    } catch (err) {
      console.error('Failed to load diffs:', err)
    } finally {
      setLoading(false)
    }
  }, [worktreePath, commitHash])

  useEffect(() => {
    setLoading(true)
    if (commitHash) {
      loadCommitDiff()
    } else {
      loadFiles()
    }
  }, [commitHash, loadCommitDiff, loadFiles])

  // Auto-refresh on filesystem changes (only for working-tree diffs)
  useEffect(() => {
    if (commitHash) return // commit diffs are immutable
    window.api.fs.watchDir(worktreePath)
    const unsub = window.api.fs.onDirChanged((changedDir: string) => {
      if (changedDir === worktreePath) loadFiles()
    })
    return () => {
      unsub()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, loadFiles, commitHash])

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
      const el = document.getElementById(`diff-${f.filePath}`)
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
          {commitHash
            ? `${commitHash.slice(0, 7)} ${commitMessage || ''}`
            : `${files.length} changed file${files.length !== 1 ? 's' : ''}`
          }
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
            key={f.filePath}
            data={f}
            inline={inline}
            worktreePath={worktreePath}
            onOpenFile={openFileFromDiff}
            annotations={annotations}
            onAddAnnotation={handleAddAnnotation}
            onResolveAnnotation={handleResolveAnnotation}
            onDeleteAnnotation={handleDeleteAnnotation}
          />
        ))}
      </div>
    </div>
  )
}
