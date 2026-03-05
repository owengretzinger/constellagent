import { useEffect, useState, useCallback, useRef } from 'react'
import { Tree, NodeRendererProps, NodeApi } from 'react-arborist'
import { useAppStore } from '../../store/app-store'
import styles from './RightPanel.module.css'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  gitStatus?: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
}

interface Props {
  worktreePath: string
  isActive?: boolean
}

function basename(p: string) {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

/** Recursively open or close all descendants of a node */
function toggleRecursive(node: NodeApi<FileNode>) {
  if (node.isOpen) {
    closeRecursive(node)
  } else {
    openRecursive(node)
  }
}

function openRecursive(node: NodeApi<FileNode>) {
  node.open()
  if (node.children) {
    for (const child of node.children) {
      if (child.isInternal) openRecursive(child)
    }
  }
}

function closeRecursive(node: NodeApi<FileNode>) {
  if (node.children) {
    for (const child of node.children) {
      if (child.isInternal) closeRecursive(child)
    }
  }
  node.close()
}

const GIT_STATUS_CLASS: Record<string, string> = {
  modified: styles.gitModified,
  added: styles.gitAdded,
  deleted: styles.gitDeleted,
  renamed: styles.gitRenamed,
  untracked: styles.gitUntracked,
}

function Node({ node, style }: NodeRendererProps<FileNode>) {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const tabs = useAppStore((s) => s.tabs)
  const openFileTab = useAppStore((s) => s.openFileTab)

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const isActiveFile =
    node.isLeaf &&
    activeTab?.type === 'file' &&
    activeTab.filePath === node.data.path

  const gitClass = node.data.gitStatus
    ? GIT_STATUS_CLASS[node.data.gitStatus] || ''
    : ''

  const handleClick = (e: React.MouseEvent) => {
    if (node.isInternal) {
      if (e.altKey) {
        toggleRecursive(node)
      } else {
        node.toggle()
      }
    } else {
      openFileTab(node.data.path)
    }
  }

  return (
    <div
      style={style}
      className={`${styles.treeNode} ${isActiveFile ? styles.treeNodeActive : ''}`}
      onClick={handleClick}
    >
      <span className={styles.treeChevron}>
        {node.isInternal ? (node.isOpen ? '▾' : '▸') : ''}
      </span>
      <span className={`${styles.treeName} ${gitClass}`}>
        {node.data.name}
      </span>
    </div>
  )
}

export function FileTree({ worktreePath, isActive }: Props) {
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(400)

  const fetchTree = useCallback(() => {
    window.api.fs.getTreeWithStatus(worktreePath).then((nodes: FileNode[]) => {
      // Wrap in root node
      const root: FileNode = {
        name: basename(worktreePath),
        path: worktreePath,
        type: 'directory',
        children: nodes,
      }
      setTree([root])
    }).catch(() => {})
  }, [worktreePath])

  // Initial fetch
  useEffect(() => {
    fetchTree()
  }, [fetchTree])

  // Auto-refresh on filesystem changes
  useEffect(() => {
    window.api.fs.watchDir(worktreePath)
    const unsub = window.api.fs.onDirChanged((changedDir: string) => {
      if (changedDir === worktreePath) fetchTree()
    })
    return () => {
      unsub()
      window.api.fs.unwatchDir(worktreePath)
    }
  }, [worktreePath, fetchTree])

  // Re-fetch when tab becomes visible (git ops only touch .git/ which the watcher ignores)
  useEffect(() => {
    if (isActive) fetchTree()
  }, [isActive, fetchTree])

  // Measure container height for virtualization
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeight(entry.contentRect.height)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div ref={containerRef} className={styles.treeContainer}>
      {!tree ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Loading files...</span>
        </div>
      ) : (
        <Tree<FileNode>
          key={worktreePath}
          data={tree}
          idAccessor="path"
          openByDefault={false}
          initialOpenState={{ [worktreePath]: true }}
          disableDrag={true}
          disableDrop={true}
          disableEdit={true}
          disableMultiSelection={true}
          rowHeight={26}
          indent={14}
          width="100%"
          height={height}
        >
          {Node}
        </Tree>
      )}
    </div>
  )
}
