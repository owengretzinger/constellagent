import { useEffect, useState, useCallback, useRef, memo, useMemo } from 'react'
import { PatchDiff, type DiffLineAnnotation } from '@pierre/diffs/react'
import type { DiffAnnotation, DiffAnnotationSide } from '@shared/diff-annotation-types'
import { useAppStore } from '../../store/app-store'
import { STATUS_LABELS } from '../../../shared/status-labels'
import { useFileWatcher } from '../../hooks/useFileWatcher'
import { isMarkdownDocumentPath } from '../../utils/markdown-path'
import { ErrorBoundary } from '../ErrorBoundary/ErrorBoundary'
import { AnnotationBubble, AnnotationComposer } from './AnnotationBubble'
import annotationUi from './AnnotationBubble.module.css'
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

/** Pierre LineSelectionManager payload (not re-exported from `@pierre/diffs/react`). */
interface PierreSelectedRange {
  start: number
  end: number
  side?: DiffAnnotationSide
  endSide?: DiffAnnotationSide
}

function normalizeDiffSelection(range: PierreSelectedRange): {
  side: DiffAnnotationSide
  lineNumber: number
  lineEnd: number
} {
  const side = (range.side ?? 'additions') as DiffAnnotationSide
  if (range.endSide != null && range.endSide !== side) {
    return { side, lineNumber: range.start, lineEnd: range.start }
  }
  const lo = Math.min(range.start, range.end)
  const hi = Math.max(range.start, range.end)
  return { side, lineNumber: lo, lineEnd: hi }
}

/** Unescape minimal C-style sequences Git uses in quoted diff paths. */
function unquoteGitPath(s: string): string {
  return s.replace(/\\([\\"])/g, '$1')
}

/**
 * Prefer `+++ b/…` / `--- a/…` (unified diff); fall back to first `diff --git` line; then `unknown`.
 */
function extractFilePathFromGitPatchSegment(part: string): string {
  const lines = part.split('\n')
  for (const line of lines) {
    if (line.startsWith('+++ /dev/null')) continue
    const quotedPlus = line.match(/^\+\+\+ "b\/((?:[^"\\]|\\.)*)"(?:\t.*)?$/)
    if (quotedPlus) return unquoteGitPath(quotedPlus[1])
    const plainPlus = line.match(/^\+\+\+ b\/(.+?)(?:\t|$)/)
    if (plainPlus) return plainPlus[1]
  }
  for (const line of lines) {
    if (!line.startsWith('--- a/') && !line.startsWith('--- "a/')) continue
    const quotedMinus = line.match(/^--- "a\/((?:[^"\\]|\\.)*)"(?:\t.*)?$/)
    if (quotedMinus) return unquoteGitPath(quotedMinus[1])
    const plainMinus = line.match(/^--- a\/(.+?)(?:\t|$)/)
    if (plainMinus) return plainMinus[1]
  }
  const firstLine = lines[0] || ''
  const diffCc = firstLine.match(/^diff --cc (.+)$/)
  if (diffCc) return diffCc[1].trim()
  const quotedGit = firstLine.match(/"b\/((?:[^"\\]|\\.)*)"\s*$/)
  if (quotedGit) return unquoteGitPath(quotedGit[1])
  const plainGit = firstLine.match(/\bb\/(.+)$/)
  if (plainGit) return plainGit[1]
  return 'unknown'
}

/** Split `git show` output into one blob per file (`diff --git` or merge `diff --cc`). */
function splitGitShowPatchIntoFiles(patchOutput: string): string[] {
  const trimmed = patchOutput.trimEnd()
  if (!trimmed) return []
  const headerRe = /^diff --(?:git|cc) /gm
  const matches = [...trimmed.matchAll(headerRe)]
  if (matches.length === 0) return [trimmed]
  return matches.map((m, i) => {
    const start = m.index!
    const end = i + 1 < matches.length ? (matches[i + 1]!.index as number) : trimmed.length
    return trimmed.slice(start, end).trimEnd()
  })
}

/**
 * Merge commits use combined diffs (`diff --cc`, `@@@` hunks). @pierre/diffs only supports
 * unified `diff --git` / `@@` patches — see its GIT_DIFF_FILE_BREAK_REGEX / FILE_CONTEXT_BLOB.
 */
function isCombinedMergePatch(patch: string): boolean {
  return /^diff --cc /m.test(patch) || /^@@@ /m.test(patch)
}

// ── Per-file diff section ──

interface DiffFileSectionProps {
  data: DiffFileData
  inline: boolean
  worktreePath: string
  onOpenFile: (filePath: string) => void
  worktreeAnnotations: DiffAnnotation[]
  onAnnotationsChanged: () => void
  showPatchAnchorNote: boolean
}

const DiffFileSection = memo(function DiffFileSection({
  data,
  inline,
  worktreePath,
  onOpenFile,
  worktreeAnnotations,
  onAnnotationsChanged,
  showPatchAnchorNote,
}: DiffFileSectionProps) {
  const [selectedLines, setSelectedLines] = useState<PierreSelectedRange | null>(null)
  const [pendingRange, setPendingRange] = useState<{
    side: DiffAnnotationSide
    lineNumber: number
    lineEnd: number
  } | null>(null)

  const parts = data.filePath.split('/')
  const fileName = parts.pop()
  const dir = parts.length > 0 ? parts.join('/') + '/' : ''

  const fullPath = data.filePath.startsWith('/')
    ? data.filePath
    : `${worktreePath}/${data.filePath}`

  const fileAnnotations = useMemo(
    () => worktreeAnnotations.filter((a) => a.filePath === data.filePath),
    [worktreeAnnotations, data.filePath],
  )

  const lineAnnotations = useMemo((): DiffLineAnnotation<DiffAnnotation[]>[] => {
    const map = new Map<string, DiffAnnotation[]>()
    for (const a of fileAnnotations) {
      const key = `${a.side}:${a.lineNumber}`
      let arr = map.get(key)
      if (!arr) {
        arr = []
        map.set(key, arr)
      }
      arr.push(a)
    }
    for (const arr of map.values()) {
      arr.sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    }
    return [...map.entries()].map(([key, items]) => {
      const [side, ln] = key.split(':')
      return {
        side: side as DiffAnnotationSide,
        lineNumber: Number(ln),
        metadata: items,
      }
    })
  }, [fileAnnotations])

  /** Pierre renders annotation slots per (side, lineNumber); anchor composer at the lowest selected line. */
  const displayLineAnnotations = useMemo((): DiffLineAnnotation<DiffAnnotation[]>[] => {
    if (!pendingRange) return lineAnnotations
    const key = `${pendingRange.side}:${pendingRange.lineEnd}`
    if (lineAnnotations.some((a) => `${a.side}:${a.lineNumber}` === key)) {
      return lineAnnotations
    }
    return [
      ...lineAnnotations,
      {
        side: pendingRange.side,
        lineNumber: pendingRange.lineEnd,
        metadata: [],
      },
    ]
  }, [lineAnnotations, pendingRange])

  const handleLineSelectionStart = useCallback(() => {
    setPendingRange(null)
  }, [])

  const handleLineSelectionEnd = useCallback((range: PierreSelectedRange | null) => {
    setSelectedLines(range)
    if (!range) {
      setPendingRange(null)
      return
    }
    setPendingRange(normalizeDiffSelection(range))
  }, [])

  const patchOptions = useMemo(
    () => ({
      theme: 'tokyo-night' as const,
      themeType: 'dark' as const,
      diffStyle: inline ? ('unified' as const) : ('split' as const),
      diffIndicators: 'bars' as const,
      lineDiffType: 'word-alt' as const,
      overflow: 'scroll' as const,
      expandUnchanged: false,
      disableFileHeader: true,
      enableLineSelection: true,
      onLineSelectionStart: handleLineSelectionStart,
      onLineSelectionEnd: handleLineSelectionEnd,
    }),
    [inline, handleLineSelectionStart, handleLineSelectionEnd],
  )

  const clearSelectionAndComposer = useCallback(() => {
    setSelectedLines(null)
    setPendingRange(null)
  }, [])

  const renderAnnotation = useCallback(
    (ann: DiffLineAnnotation<DiffAnnotation[]>) => {
      const items = ann.metadata ?? []
      const showComposer =
        pendingRange != null &&
        ann.side === pendingRange.side &&
        ann.lineNumber === pendingRange.lineEnd
      if (!items.length && !showComposer) return null
      return (
        <div className={annotationUi.annotationStack}>
          {items.map((a) => (
            <AnnotationBubble
              key={a.id}
              annotation={a}
              worktreePath={worktreePath}
              onChanged={onAnnotationsChanged}
            />
          ))}
          {showComposer && (
            <AnnotationComposer
              worktreePath={worktreePath}
              filePath={data.filePath}
              side={pendingRange.side}
              lineNumber={pendingRange.lineNumber}
              lineEnd={pendingRange.lineEnd}
              onCancel={clearSelectionAndComposer}
              onSaved={() => {
                clearSelectionAndComposer()
                onAnnotationsChanged()
              }}
            />
          )}
        </div>
      )
    },
    [
      pendingRange,
      worktreePath,
      data.filePath,
      onAnnotationsChanged,
      clearSelectionAndComposer,
    ],
  )

  const hasAnnotationUi = displayLineAnnotations.length > 0
  const combinedMergePatch = isCombinedMergePatch(data.patch)

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
        combinedMergePatch ? (
          <>
            <p className={styles.combinedDiffNote}>
              Merge commit: combined diff (<code className={styles.combinedDiffCode}>diff --cc</code> /{' '}
              <code className={styles.combinedDiffCode}>@@@</code>) — showing raw patch. The rich diff
              viewer only supports unified <code className={styles.combinedDiffCode}>diff --git</code> format.
            </p>
            <pre className={styles.rawMergePatch}>{data.patch}</pre>
          </>
        ) : (
          <ErrorBoundary
            fallback={
              <div style={{ padding: 12, color: '#888', fontSize: 13 }}>
                Failed to render diff for this file.
              </div>
            }
          >
            <PatchDiff<DiffAnnotation[]>
              patch={data.patch}
              options={patchOptions}
              selectedLines={selectedLines}
              lineAnnotations={hasAnnotationUi ? displayLineAnnotations : undefined}
              renderAnnotation={hasAnnotationUi ? renderAnnotation : undefined}
            />
            {showPatchAnchorNote && fileAnnotations.length > 0 && (
              <p className={annotationUi.commitNote}>
                Comments reflect this patch; line anchors may not match other revisions.
              </p>
            )}
          </ErrorBoundary>
        )
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
  const [annotations, setAnnotations] = useState<DiffAnnotation[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
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

  const loadAnnotations = useCallback(async () => {
    try {
      const list = await window.api.annotations.load(worktreePath)
      setAnnotations(list)
    } catch (err) {
      console.error('Failed to load diff annotations:', err)
      setAnnotations([])
    }
  }, [worktreePath])

  useEffect(() => {
    void loadAnnotations()
  }, [loadAnnotations])

  useEffect(() => {
    const unsub = window.api.annotations.onChanged(({ worktreePath: wp }) => {
      if (wp === worktreePath) void loadAnnotations()
    })
    return unsub
  }, [worktreePath, loadAnnotations])

  // Load commit-specific diff
  const loadCommitDiff = useCallback(async () => {
    if (!commitHash) return
    try {
      const patchOutput = await window.api.git.getCommitDiff(worktreePath, commitHash)
      if (!patchOutput) {
        setFiles([])
        return
      }
      const parts = splitGitShowPatchIntoFiles(patchOutput)
      const results: DiffFileData[] = parts.map((part) => ({
        filePath: extractFilePathFromGitPatchSegment(part),
        patch: part,
        status: 'modified', // commit diffs don't distinguish status easily
      }))
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
            let content: string | null = null
            try {
              content = await window.api.fs.readFile(fullPath)
            } catch {
              content = null
            }
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
  useFileWatcher(worktreePath, loadFiles, !commitHash)

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

      <p className={styles.diffCommentHint}>
        Review comments: drag across the line numbers in the gutter (GitHub-style), then write your note below the
        diff. Click the same line again to clear the selection.
      </p>

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
            worktreeAnnotations={annotations}
            onAnnotationsChanged={loadAnnotations}
            showPatchAnchorNote={!!commitHash}
          />
        ))}
      </div>
    </div>
  )
}
