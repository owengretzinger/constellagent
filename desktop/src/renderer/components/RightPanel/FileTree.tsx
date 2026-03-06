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

function dirname(p: string) {
  const i = p.lastIndexOf('/')
  if (i <= 0) return '/'
  return p.slice(0, i)
}

function joinPath(parent: string, name: string) {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
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

type PendingAction =
  | {
      kind: 'create-file' | 'create-directory'
      parentPath: string
      title: string
      confirmLabel: string
    }
  | {
      kind: 'rename'
      parentPath: string
      targetPath: string
      title: string
      confirmLabel: string
    }

export function FileTree({ worktreePath, isActive }: Props) {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const tabs = useAppStore((s) => s.tabs)
  const openFileTab = useAppStore((s) => s.openFileTab)
  const retargetTabsForPath = useAppStore((s) => s.retargetTabsForPath)
  const closeTabsForPath = useAppStore((s) => s.closeTabsForPath)
  const showConfirmDialog = useAppStore((s) => s.showConfirmDialog)
  const dismissConfirmDialog = useAppStore((s) => s.dismissConfirmDialog)
  const addToast = useAppStore((s) => s.addToast)
  const [tree, setTree] = useState<FileNode[] | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [height, setHeight] = useState(400)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [pendingName, setPendingName] = useState('')

  const activeTab = tabs.find((t) => t.id === activeTabId)

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

  const showError = useCallback((fallback: string, error: unknown) => {
    const message = error instanceof Error ? error.message : fallback
    addToast({ id: crypto.randomUUID(), message, type: 'error' })
  }, [addToast])

  const startCreate = useCallback((parentPath: string, kind: 'create-file' | 'create-directory') => {
    setPendingAction({
      kind,
      parentPath,
      title: kind === 'create-file' ? `New file in ${basename(parentPath)}` : `New folder in ${basename(parentPath)}`,
      confirmLabel: kind === 'create-file' ? 'Create file' : 'Create folder',
    })
    setPendingName('')
  }, [])

  const startRename = useCallback((targetPath: string) => {
    setPendingAction({
      kind: 'rename',
      targetPath,
      parentPath: dirname(targetPath),
      title: `Rename ${basename(targetPath)}`,
      confirmLabel: 'Rename',
    })
    setPendingName(basename(targetPath))
  }, [])

  const cancelPendingAction = useCallback(() => {
    setPendingAction(null)
    setPendingName('')
  }, [])

  const submitPendingAction = useCallback(async () => {
    if (!pendingAction) return

    const name = pendingName.trim()
    if (!name) {
      showError('Name is required', new Error('Name is required'))
      return
    }
    if (name.includes('/') || name === '.' || name === '..') {
      showError('Invalid file name', new Error('Use a single file or folder name'))
      return
    }

    const nextPath = joinPath(pendingAction.parentPath, name)

    try {
      if (pendingAction.kind === 'create-file') {
        await window.api.fs.createFile(nextPath)
        openFileTab(nextPath)
      } else if (pendingAction.kind === 'create-directory') {
        await window.api.fs.createDirectory(nextPath)
      } else if (pendingAction.kind === 'rename') {
        if (nextPath === pendingAction.targetPath) {
          cancelPendingAction()
          return
        }
        await window.api.fs.renamePath(pendingAction.targetPath, nextPath)
        retargetTabsForPath(pendingAction.targetPath, nextPath)
      }

      cancelPendingAction()
      fetchTree()
    } catch (error) {
      showError('File operation failed', error)
    }
  }, [cancelPendingAction, fetchTree, openFileTab, pendingAction, pendingName, retargetTabsForPath, showError])

  const deletePath = useCallback(async (targetPath: string) => {
    try {
      await window.api.fs.deletePath(targetPath)
      closeTabsForPath(targetPath)
      fetchTree()
    } catch (error) {
      showError('Delete failed', error)
    }
  }, [closeTabsForPath, fetchTree, showError])

  const requestDelete = useCallback((node: NodeApi<FileNode>, skipConfirm: boolean) => {
    const targetPath = node.data.path
    const targetName = node.data.name
    const isDirectory = node.data.type === 'directory'

    if (skipConfirm) {
      void deletePath(targetPath)
      return
    }

    showConfirmDialog({
      title: isDirectory ? `Delete folder ${targetName}?` : `Delete file ${targetName}?`,
      message: isDirectory
        ? 'This deletes the folder and everything inside it.'
        : 'This permanently deletes the file from disk.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        dismissConfirmDialog()
        void deletePath(targetPath)
      },
    })
  }, [deletePath, dismissConfirmDialog, showConfirmDialog])

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
    const el = viewportRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeight(entry.contentRect.height)
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    if (!pendingAction) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [pendingAction])

  const Node = ({ node, style }: NodeRendererProps<FileNode>) => {
    const isRoot = node.data.path === worktreePath
    const isDirectory = node.data.type === 'directory'
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
        <div className={styles.treeActions}>
          {isDirectory && (
            <>
              <button
                className={`${styles.fileActionBtn} ${styles.treeActionBtn}`}
                title="New file"
                onClick={(e) => {
                  e.stopPropagation()
                  node.open()
                  startCreate(node.data.path, 'create-file')
                }}
              >
                +F
              </button>
              <button
                className={`${styles.fileActionBtn} ${styles.treeActionBtn}`}
                title="New folder"
                onClick={(e) => {
                  e.stopPropagation()
                  node.open()
                  startCreate(node.data.path, 'create-directory')
                }}
              >
                +D
              </button>
            </>
          )}
          {!isRoot && (
            <>
              <button
                className={`${styles.fileActionBtn} ${styles.treeActionBtn}`}
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation()
                  startRename(node.data.path)
                }}
              >
                R
              </button>
              <button
                className={`${styles.fileActionBtn} ${styles.treeActionBtn}`}
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation()
                  requestDelete(node, e.shiftKey)
                }}
              >
                X
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.treeContainer}>
      {pendingAction && (
        <form
          className={styles.treeActionBar}
          onSubmit={(e) => {
            e.preventDefault()
            void submitPendingAction()
          }}
        >
          <span className={styles.treeActionLabel}>{pendingAction.title}</span>
          <input
            ref={inputRef}
            className={styles.treeActionInput}
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                cancelPendingAction()
              }
            }}
            placeholder="name"
          />
          <button type="submit" className={styles.treeActionButton}>
            {pendingAction.confirmLabel}
          </button>
          <button
            type="button"
            className={styles.treeActionButtonSecondary}
            onClick={cancelPendingAction}
          >
            Cancel
          </button>
        </form>
      )}
      <div ref={viewportRef} className={styles.treeViewport}>
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
    </div>
  )
}
