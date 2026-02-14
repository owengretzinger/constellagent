import { useCallback, useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Tab } from '../../store/types'
import { resolveEditor } from '../../store/types'
import { getAllPtyIds } from '../../store/split-helpers'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './TabBar.module.css'

/** Cursor cube logo (2D dark variant) — inline SVG for currentColor support */
function CursorIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 466.73 532.09"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M457.43,125.94L244.42,2.96c-6.84-3.95-15.28-3.95-22.12,0L9.3,125.94c-5.75,3.32-9.3,9.46-9.3,16.11v247.99c0,6.65,3.55,12.79,9.3,16.11l213.01,122.98c6.84,3.95,15.28,3.95,22.12,0l213.01-122.98c5.75-3.32,9.3-9.46,9.3-16.11v-247.99c0-6.65-3.55-12.79-9.3-16.11h-.01ZM444.05,151.99l-205.63,356.16c-1.39,2.4-5.06,1.42-5.06-1.36v-233.21c0-4.66-2.49-8.97-6.53-11.31L24.87,145.67c-2.4-1.39-1.42-5.06,1.36-5.06h411.26c5.84,0,9.49,6.33,6.57,11.39h-.01Z" />
    </svg>
  )
}

/** VS Code logo */
function VSCodeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 100 100" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M71.56 4.35L37.2 35.08 16.86 19.82 10 22.88v54.24l6.86 3.06 20.34-15.26L71.56 95.65 90 87.42V12.58L71.56 4.35zM16.86 65.5V34.5L30.73 50 16.86 65.5zM71.56 73.24L46.5 50l25.06-23.24v46.48z" />
    </svg>
  )
}

/** Zed logo */
function ZedIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 3h20v3.6L8.4 18H22v3H2v-3.6L15.6 6H2V3z" />
    </svg>
  )
}

/** Generic editor icon (used for Sublime, WebStorm, custom) */
function GenericEditorIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

/** Pick the right icon component for the configured editor */
function EditorIcon({ editor, className }: { editor: string; className?: string }) {
  switch (editor) {
    case 'cursor': return <CursorIcon className={className} />
    case 'vscode': return <VSCodeIcon className={className} />
    case 'zed': return <ZedIcon className={className} />
    default: return <GenericEditorIcon className={className} />
  }
}

const TAB_ICONS: Record<Tab['type'], { icon: string; className: string }> = {
  terminal: { icon: '⌘', className: styles.terminal },
  file: { icon: '◇', className: styles.file },
  diff: { icon: '±', className: styles.diff },
}

function getTabTitle(tab: Tab): string {
  if (tab.type === 'terminal') return tab.title
  if (tab.type === 'diff') {
    if (tab.commitHash) return `${tab.commitHash.slice(0, 7)} ${tab.commitMessage || ''}`
    return 'Changes'
  }
  const name = tab.filePath.split('/').pop() || tab.filePath
  return name
}

const STATUS_LETTER_MAP: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
}

export function TabBar() {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const removeTab = useAppStore((s) => s.removeTab)
  const allTabs = useAppStore((s) => s.tabs)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const createTerminalForActiveWorkspace = useAppStore((s) => s.createTerminalForActiveWorkspace)
  const lastSavedTabId = useAppStore((s) => s.lastSavedTabId)
  const settings = useAppStore((s) => s.settings)
  const gitFileStatuses = useAppStore((s) => s.gitFileStatuses)
  const workspaces = useAppStore((s) => s.workspaces)
  const addToast = useAppStore((s) => s.addToast)
  const tabs = allTabs.filter((t) => t.workspaceId === activeWorkspaceId)
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)

  const getFileGitStatus = useCallback((tab: Tab): string | null => {
    if (tab.type !== 'file') return null
    if (tab.deleted) return 'D'
    const ws = workspaces.find((w) => w.id === tab.workspaceId)
    if (!ws) return null
    const statusMap = gitFileStatuses.get(ws.worktreePath)
    if (!statusMap) return null
    const relPath = tab.filePath.startsWith(ws.worktreePath)
      ? tab.filePath.slice(ws.worktreePath.length).replace(/^\//, '')
      : null
    if (!relPath) return null
    const status = statusMap.get(relPath)
    if (!status) return null
    return STATUS_LETTER_MAP[status] ?? null
  }, [workspaces, gitFileStatuses])

  const editor = useMemo(() => resolveEditor(settings), [settings])

  const handleOpenInEditor = useCallback(async () => {
    if (!workspace) return
    const result = await window.api.app.openInEditor(workspace.worktreePath, editor.cli)
    if (!result.success) {
      addToast({
        id: `editor-err-${Date.now()}`,
        message: result.error || `Failed to open ${editor.name}`,
        type: 'error',
      })
    }
  }, [workspace, addToast, editor])

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation()
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return

      if (tab.type === 'file' && tab.unsaved && settings.confirmOnClose) {
        if (!window.confirm(`"${getTabTitle(tab)}" has unsaved changes. Close anyway?`)) return
      }

      if (tab.type === 'terminal') {
        const ptyIds = new Set(tab.splitRoot ? getAllPtyIds(tab.splitRoot) : [])
        ptyIds.add(tab.ptyId)
        ptyIds.forEach((id) => window.api.pty.destroy(id))
      }
      removeTab(tabId)
    },
    [tabs, removeTab]
  )

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {tabs.map((tab) => {
          const { icon, className } = TAB_ICONS[tab.type]
          const isSaved = tab.id === lastSavedTabId
          const gitStatus = getFileGitStatus(tab)
          const isDeleted = tab.type === 'file' && tab.deleted
          return (
            <div
              key={tab.id}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ''} ${isDeleted ? styles.deleted : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className={`${styles.tabIcon} ${className}`}>{icon}</span>
              <span className={`${styles.tabTitle} ${isSaved ? styles.savedFlash : ''} ${isDeleted ? styles.deletedTitle : ''}`}>
                {getTabTitle(tab)}
              </span>
              {gitStatus && (
                <span className={`${styles.gitBadge} ${styles[`git${gitStatus}`]}`}>
                  {gitStatus}
                </span>
              )}
              {tab.type === 'file' && tab.unsaved && !isDeleted ? (
                <span className={styles.unsavedDot} />
              ) : (
                <Tooltip label="Close tab" shortcut="⌘W">
                  <button
                    className={styles.closeButton}
                    onClick={(e) => handleClose(e, tab.id)}
                  >
                    ✕
                  </button>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>

      <Tooltip label="New terminal" shortcut="⌘T">
        <button className={styles.newTabButton} onClick={createTerminalForActiveWorkspace}>
          +
        </button>
      </Tooltip>

      <div className={styles.dragSpacer} />

      {workspace && (
        <Tooltip label={`Open in ${editor.name}`} shortcut="⇧⌘O">
          <button className={styles.cursorButton} onClick={handleOpenInEditor}>
            <EditorIcon editor={settings.favoriteEditor} className={styles.cursorIcon} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
