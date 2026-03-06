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

type PendingAction =
  | { kind: 'newFile'; parentPath: string }
  | { kind: 'newFolder'; parentPath: string }
  | { kind: 'rename'; nodePath: string; currentName: string }

function basename(p: string) {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function dirpath(p: string) {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(0, i) : p
}

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

interface ContextMenuState {
  x: number
  y: number
  node: NodeApi<FileNode>
}

interface NodeProps extends NodeRendererProps<FileNode> {
  pendingAction: PendingAction | null
  onFinishAction: (name: string | null) => void
  onContextMenu: (e: React.MouseEvent, node: NodeApi<FileNode>) => void
}

function InlineInput({ defaultValue, onCommit }: { defaultValue: string; onCommit: (value: string | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (defaultValue) {
      const dotIdx = defaultValue.lastIndexOf('.')
      el.setSelectionRange(0, dotIdx > 0 ? dotIdx : defaultValue.length)
    }
  }, [defaultValue])

  const commit = () => {
    const val = inputRef.current?.value.trim() ?? ''
    onCommit(val || null)
  }

  return (
    <input
      ref={inputRef}
      className={styles.inlineInput}
      defaultValue={defaultValue}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        if (e.key === 'Escape') { e.preventDefault(); onCommit(null) }
        e.stopPropagation()
      }}
      onClick={(e) => e.stopPropagation()}
    />
  )
}

function Node({ node, style, pendingAction, onFinishAction, onContextMenu }: NodeProps) {
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

  const isRenaming =
    pendingAction?.kind === 'rename' &&
    pendingAction.nodePath === node.data.path

  const isNewItemParent =
    (pendingAction?.kind === 'newFile' || pendingAction?.kind === 'newFolder') &&
    pendingAction.parentPath === node.data.path

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
    <>
      <div
        style={style}
        className={`${styles.treeNode} ${isActiveFile ? styles.treeNodeActive : ''}`}
        onClick={handleClick}
        onContextMenu={(e) => onContextMenu(e, node)}
      >
        <span className={styles.treeChevron}>
          {node.isInternal ? (node.isOpen ? '▾' : '▸') : ''}
        </span>
        {isRenaming ? (
          <InlineInput defaultValue={node.data.name} onCommit={onFinishAction} />
        ) : (
          <span className={`${styles.treeName} ${gitClass}`}>
            {node.data.name}
          </span>
        )}
      </div>
      {isNewItemParent && node.isOpen && (
        <div
          className={styles.treeNode}
          style={{ paddingLeft: (style.paddingLeft as number ?? 0) + 14 }}
        >
          <span className={styles.treeChevron}>
            {pendingAction?.kind === 'newFolder' ? '▸' : ''}
          </span>
          <InlineInput defaultValue="" onCommit={onFinishAction} />
        </div>
      )}
    </>
  )
}

export function FileTree({ worktreePath, isActive }: Props) {
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(400)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const openFileTab = useAppStore((s) => s.openFileTab)

  const fetchTree = useCallback(() => {
    window.api.fs.getTreeWithStatus(worktreePath).then((nodes: FileNode[]) => {
      const root: FileNode = {
        name: basename(worktreePath),
        path: worktreePath,
        type: 'directory',
        children: nodes,
      }
      setTree([root])
    }).catch(() => {})
  }, [worktreePath])

  useEffect(() => {
    fetchTree()
  }, [fetchTree])

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

  useEffect(() => {
    if (isActive) fetchTree()
  }, [isActive, fetchTree])

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

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return
    const dismiss = () => setContextMenu(null)
    window.addEventListener('click', dismiss)
    return () => window.removeEventListener('click', dismiss)
  }, [contextMenu])

  const handleContextMenu = useCallback((e: React.MouseEvent, node: NodeApi<FileNode>) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, node })
  }, [])

  const handleFinishAction = useCallback(async (name: string | null) => {
    const action = pendingAction
    setPendingAction(null)
    if (!name || !action) return

    try {
      if (action.kind === 'newFile') {
        const newPath = `${action.parentPath}/${name}`
        await window.api.fs.createFile(newPath)
        openFileTab(newPath)
      } else if (action.kind === 'newFolder') {
        await window.api.fs.createDirectory(`${action.parentPath}/${name}`)
      } else if (action.kind === 'rename') {
        const newPath = `${dirpath(action.nodePath)}/${name}`
        if (newPath !== action.nodePath) {
          await window.api.fs.rename(action.nodePath, newPath)
        }
      }
    } catch (err) {
      console.error('File operation failed:', err)
    }
  }, [pendingAction, openFileTab])

  const handleMenuAction = useCallback((action: string) => {
    const node = contextMenu?.node
    setContextMenu(null)
    if (!node) return

    const targetDir = node.data.type === 'directory' ? node.data.path : dirpath(node.data.path)

    if (action === 'newFile') {
      if (node.isInternal && !node.isOpen) node.open()
      setPendingAction({ kind: 'newFile', parentPath: targetDir })
    } else if (action === 'newFolder') {
      if (node.isInternal && !node.isOpen) node.open()
      setPendingAction({ kind: 'newFolder', parentPath: targetDir })
    } else if (action === 'rename') {
      setPendingAction({ kind: 'rename', nodePath: node.data.path, currentName: node.data.name })
    } else if (action === 'delete') {
      const isDir = node.data.type === 'directory'
      const label = isDir ? 'folder' : 'file'
      if (window.confirm(`Delete ${label} "${node.data.name}"?`)) {
        window.api.fs.delete(node.data.path).catch((err: unknown) =>
          console.error('Delete failed:', err)
        )
      }
    } else if (action === 'copyPath') {
      navigator.clipboard.writeText(node.data.path)
    } else if (action === 'copyRelativePath') {
      const rel = node.data.path.startsWith(worktreePath + '/')
        ? node.data.path.slice(worktreePath.length + 1)
        : node.data.name
      navigator.clipboard.writeText(rel)
    }
  }, [contextMenu, worktreePath])

  const isRootNode = contextMenu?.node.data.path === worktreePath

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
          {(props) => (
            <Node
              {...props}
              pendingAction={pendingAction}
              onFinishAction={handleFinishAction}
              onContextMenu={handleContextMenu}
            />
          )}
        </Tree>
      )}

      {contextMenu && (
        <div
          className={styles.contextMenu}
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className={styles.contextMenuItem} onClick={() => handleMenuAction('newFile')}>
            New File
          </button>
          <button className={styles.contextMenuItem} onClick={() => handleMenuAction('newFolder')}>
            New Folder
          </button>
          {!isRootNode && (
            <>
              <div className={styles.contextMenuDivider} />
              <button className={styles.contextMenuItem} onClick={() => handleMenuAction('rename')}>
                Rename
              </button>
              <button className={`${styles.contextMenuItem} ${styles.contextMenuDanger}`} onClick={() => handleMenuAction('delete')}>
                Delete
              </button>
            </>
          )}
          <div className={styles.contextMenuDivider} />
          <button className={styles.contextMenuItem} onClick={() => handleMenuAction('copyPath')}>
            Copy Path
          </button>
          <button className={styles.contextMenuItem} onClick={() => handleMenuAction('copyRelativePath')}>
            Copy Relative Path
          </button>
        </div>
      )}
    </div>
  )
}
