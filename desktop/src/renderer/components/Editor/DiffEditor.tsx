import { useEffect, useState, useCallback, useRef, memo } from 'react'
import { PatchDiff } from '@pierre/diffs/react'
import { useAppStore } from '../../store/app-store'
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
  isBinary: boolean
}

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

function patchIndicatesBinary(patch: string): boolean {
  if (!patch) return false
  return /^\s*Binary files /m.test(patch) || /^\s*GIT binary patch\b/m.test(patch)
}

const BINARY_EXTENSIONS = new Set([
  // Images
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff', 'tif',
  // Documents
  'pdf',
  // Archives / packages
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'dmg', 'pkg',
  // Audio / video
  'mp3', 'wav', 'flac', 'm4a', 'ogg', 'mp4', 'mov', 'avi', 'mkv', 'webm',
  // Fonts
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  // Binaries / data
  'exe', 'dll', 'so', 'dylib', 'wasm', 'bin', 'dat', 'db', 'sqlite',
])

function pathIndicatesBinary(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase()
  if (!ext || ext === filePath.toLowerCase()) return false
  return BINARY_EXTENSIONS.has(ext)
}

function contentIndicatesBinary(text: string): boolean {
  // Heuristic: NUL bytes or lots of control/replacement characters usually mean "not text".
  const sample = text.slice(0, 8000)
  if (sample.includes('\u0000')) return true

  let suspicious = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    if (code === 9 || code === 10 || code === 13) continue // tab/newline/carriage return
    if (code === 0xfffd || code < 32) suspicious++
  }

  return sample.length > 0 && suspicious / sample.length > 0.1
}

// ── Per-file diff section ──

interface DiffFileSectionProps {
  data: DiffFileData
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
  const parts = data.filePath.split('/')
  const fileName = parts.pop()
  const dir = parts.length > 0 ? parts.join('/') + '/' : ''

  const fullPath = data.filePath.startsWith('/')
    ? data.filePath
    : `${worktreePath}/${data.filePath}`

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
      {data.isBinary ? (
        <div className={styles.binaryDiffNotice}>
          <span className={styles.binaryDiffNoticeText}>
            Non-text file. Diff not shown.
          </span>
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

export function DiffViewer({ worktreePath, active }: Props) {
  const [files, setFiles] = useState<DiffFileData[]>([])
  const [loading, setLoading] = useState(true)
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const openFileTab = useAppStore((s) => s.openFileTab)
  const inline = settings.diffInline

  // Load all changed files
  const loadFiles = useCallback(async () => {
    try {
      const statuses: FileStatus[] = await window.api.git.getStatus(worktreePath)
      const results = await Promise.all(
        statuses.map(async (file) => {
          let patch = await window.api.git.getFileDiff(worktreePath, file.path)
          let isBinary =
            patchIndicatesBinary(patch) ||
            (pathIndicatesBinary(file.path) && (file.status === 'added' || file.status === 'untracked' || file.status === 'renamed'))

          // For added/untracked files, git diff returns empty — build synthetic patch
          if (!patch && !isBinary && (file.status === 'added' || file.status === 'untracked')) {
            const fullPath = file.path.startsWith('/')
              ? file.path
              : `${worktreePath}/${file.path}`
            const content = await window.api.fs.readFile(fullPath)
            if (contentIndicatesBinary(content)) {
              isBinary = true
              return { filePath: file.path, patch: '', status: file.status, isBinary }
            }
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

          return { filePath: file.path, patch: patch || '', status: file.status, isBinary }
        }),
      )
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
            key={f.filePath}
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
