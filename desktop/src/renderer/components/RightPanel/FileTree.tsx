import { useEffect, useRef, useState, useCallback } from 'react'
import { FileTree as TreesFileTree, useFileTree } from '@pierre/trees/react'
import type { ContextMenuItem, ContextMenuOpenContext, GitStatusEntry } from '@pierre/trees'
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

interface TreeData {
  paths: string[]
  filePaths: Set<string>
  gitStatus: GitStatusEntry[]
}

function toRelativePath(worktreePath: string, filePath: string): string {
  const prefix = worktreePath.endsWith('/') ? worktreePath : `${worktreePath}/`
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
}

function toAbsolutePath(worktreePath: string, filePath: string): string {
  return `${worktreePath.replace(/\/$/, '')}/${filePath}`
}

function flattenTree(worktreePath: string, nodes: FileNode[]): TreeData {
  const paths: string[] = []
  const filePaths = new Set<string>()
  const gitStatus: GitStatusEntry[] = []

  const visit = (node: FileNode) => {
    const relPath = toRelativePath(worktreePath, node.path)
    if (!relPath) return

    paths.push(node.type === 'directory' ? `${relPath}/` : relPath)
    if (node.type === 'file') filePaths.add(relPath)
    if (node.gitStatus) gitStatus.push({ path: relPath, status: node.gitStatus })

    for (const child of node.children ?? []) visit(child)
  }

  for (const node of nodes) visit(node)
  return { paths, filePaths, gitStatus }
}

interface TreesViewProps {
  worktreePath: string
  tree: TreeData
}

function TreesView({ worktreePath, tree }: TreesViewProps) {
  const openFileTab = useAppStore((s) => s.openFileTab)
  const filePathsRef = useRef(tree.filePaths)

  filePathsRef.current = tree.filePaths

  const { model } = useFileTree({
    paths: tree.paths,
    gitStatus: tree.gitStatus,
    id: `workspace-files-${worktreePath}`,
    initialExpansion: 1,
    initialSelectedPaths: [],
    itemHeight: 26,
    search: true,
    flattenEmptyDirectories: true,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1)
      if (!selectedPath || !filePathsRef.current.has(selectedPath)) return
      openFileTab(toAbsolutePath(worktreePath, selectedPath))
    },
  })

  const handleOpen = useCallback((item: ContextMenuItem, context: ContextMenuOpenContext) => {
    if (item.kind !== 'file') return
    openFileTab(toAbsolutePath(worktreePath, item.path))
    context.close()
  }, [openFileTab, worktreePath])

  const handleCopyPath = useCallback((item: ContextMenuItem, context: ContextMenuOpenContext) => {
    const path = toAbsolutePath(worktreePath, item.path)
    window.api.clipboard.writeText(path)
    context.close()
  }, [worktreePath])

  const handleCopyRelativePath = useCallback((item: ContextMenuItem, context: ContextMenuOpenContext) => {
    window.api.clipboard.writeText(item.path.replace(/\/$/, ''))
    context.close()
  }, [])

  useEffect(() => {
    model.resetPaths(tree.paths)
    model.setGitStatus(tree.gitStatus)
  }, [model, tree.paths, tree.gitStatus])

  return (
    <TreesFileTree
      model={model}
      className={styles.treesHost}
      style={{ height: '100%' }}
      renderContextMenu={(item, context) => (
        <div className={styles.treeContextMenu} data-file-tree-context-menu-root="true">
          {item.kind === 'file' ? (
            <button type="button" onClick={() => handleOpen(item, context)}>
              Open
            </button>
          ) : null}
          <button type="button" onClick={() => handleCopyPath(item, context)}>
            Copy Path
          </button>
          <button type="button" onClick={() => handleCopyRelativePath(item, context)}>
            Copy Relative Path
          </button>
        </div>
      )}
    />
  )
}

export function FileTree({ worktreePath, isActive }: Props) {
  const [tree, setTree] = useState<TreeData | null>(null)

  const fetchTree = useCallback(() => {
    window.api.fs.getTreeWithStatus(worktreePath).then((nodes: FileNode[]) => {
      setTree(flattenTree(worktreePath, nodes))
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

  return (
    <div className={styles.treeContainer}>
      {!tree ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyText}>Loading files...</span>
        </div>
      ) : (
        <TreesView key={worktreePath} worktreePath={worktreePath} tree={tree} />
      )}
    </div>
  )
}
