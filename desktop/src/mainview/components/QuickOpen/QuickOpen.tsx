import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
import styles from './QuickOpen.module.css'

interface FileEntry {
  name: string
  path: string
  relativePath: string
}

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

interface Props {
  worktreePath: string
}

function flattenTree(nodes: FileNode[], basePath: string): FileEntry[] {
  const result: FileEntry[] = []
  function walk(list: FileNode[]) {
    for (const node of list) {
      if (node.type === 'file') {
        result.push({
          name: node.name,
          path: node.path,
          relativePath: node.path.startsWith(basePath)
            ? node.path.slice(basePath.length + 1)
            : node.path,
        })
      }
      if (node.children) walk(node.children)
    }
  }
  walk(nodes)
  return result
}

/** Simple fuzzy match: checks if query chars appear in order in target. Returns matched indices or null. */
function fuzzyMatch(query: string, target: string): number[] | null {
  const lowerQuery = query.toLowerCase()
  const lowerTarget = target.toLowerCase()
  const indices: number[] = []
  let qi = 0
  for (let ti = 0; ti < lowerTarget.length && qi < lowerQuery.length; ti++) {
    if (lowerTarget[ti] === lowerQuery[qi]) {
      indices.push(ti)
      qi++
    }
  }
  return qi === lowerQuery.length ? indices : null
}

function HighlightedPath({ text, indices }: { text: string; indices: number[] }) {
  const set = new Set(indices)
  // Split into dir + filename
  const lastSlash = text.lastIndexOf('/')
  const dir = lastSlash >= 0 ? text.slice(0, lastSlash + 1) : ''
  const name = lastSlash >= 0 ? text.slice(lastSlash + 1) : text

  const renderChars = (str: string, offset: number) =>
    str.split('').map((ch, i) => {
      const globalIdx = offset + i
      return set.has(globalIdx) ? (
        <span key={globalIdx} className={styles.matchChar}>{ch}</span>
      ) : (
        <span key={globalIdx}>{ch}</span>
      )
    })

  return (
    <span className={styles.resultPath}>
      {dir && <span className={styles.resultDir}>{renderChars(dir, 0)}</span>}
      <span className={styles.resultName}>{renderChars(name, dir.length)}</span>
    </span>
  )
}

export function QuickOpen({ worktreePath }: Props) {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<FileEntry[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const openFileTab = useAppStore((s) => s.openFileTab)
  const closeQuickOpen = useAppStore((s) => s.closeQuickOpen)

  // Load file tree on mount
  useEffect(() => {
    let cancelled = false
    window.api.fs.getTree(worktreePath).then((nodes: FileNode[]) => {
      if (!cancelled) setFiles(flattenTree(nodes, worktreePath))
    }).catch(() => {})
    return () => { cancelled = true }
  }, [worktreePath])

  // Filter + fuzzy match
  const filtered = useMemo(() => {
    if (!query.trim()) return files.slice(0, 50)
    const results: { entry: FileEntry; indices: number[]; score: number }[] = []
    for (const entry of files) {
      const indices = fuzzyMatch(query, entry.relativePath)
      if (indices) {
        // Score: prefer matches at start of filename, shorter paths, tighter clusters
        const nameStart = entry.relativePath.lastIndexOf('/') + 1
        const nameMatchCount = indices.filter((i) => i >= nameStart).length
        const score = -nameMatchCount * 10 + indices.length + entry.relativePath.length
        results.push({ entry, indices, score })
      }
    }
    results.sort((a, b) => a.score - b.score)
    return results.slice(0, 50)
  }, [query, files])

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Scroll selected into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[selectedIndex] as HTMLElement | undefined
    if (item) item.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const openSelected = useCallback(() => {
    const item = filtered[selectedIndex]
    if (item) {
      const entry = 'entry' in item ? item.entry : item
      openFileTab(entry.path)
      closeQuickOpen()
    }
  }, [filtered, selectedIndex, openFileTab, closeQuickOpen])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeQuickOpen()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      openSelected()
    }
  }, [closeQuickOpen, filtered.length, openSelected])

  return (
    <div className={styles.overlay} onClick={closeQuickOpen}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.inputWrap}>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            placeholder="Search files by name..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>
        <div className={styles.results} ref={listRef}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>
              {files.length === 0 ? 'Loading...' : 'No matching files'}
            </div>
          ) : (
            filtered.map((item, i) => {
              const entry = 'entry' in item ? item.entry : item
              const indices = 'indices' in item ? item.indices : []
              return (
                <div
                  key={entry.path}
                  className={`${styles.resultItem} ${i === selectedIndex ? styles.selected : ''}`}
                  onClick={() => {
                    openFileTab(entry.path)
                    closeQuickOpen()
                  }}
                  onMouseEnter={() => setSelectedIndex(i)}
                >
                  <span className={styles.resultIcon}>·</span>
                  <HighlightedPath text={entry.relativePath} indices={indices} />
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
