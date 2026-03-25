import { useCallback, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Tab, AgentType } from '../../store/types'
import { resolveEditor } from '../../store/types'
import { getAllPtyIds } from '../../store/split-helpers'
import { CONSTELLAGENT_PATH_MIME, CONSTELLAGENT_TAB_MIME } from '../../utils/add-to-chat'
import { Tooltip } from '../Tooltip/Tooltip'
import { GEMINI_TAB_LABEL } from '../../../shared/gemini-tab-title'
import { GeminiIcon } from '../Icons/GeminiIcon'
import { CursorIcon } from '../Icons/CursorIcon'
import claudeIcon from '../../assets/agent-icons/claude.svg'
import openaiIcon from '../../assets/agent-icons/openai.svg'
import styles from './TabBar.module.css'

const AGENT_ICON_MAP: Record<AgentType, { src: string; alt: string } | null> = {
  'claude-code': { src: claudeIcon, alt: 'Claude' },
  codex: { src: openaiIcon, alt: 'Codex' },
  gemini: null, // reuses GeminiIcon component
  cursor: null, // reuses CursorIcon component
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
  markdownPreview: { icon: '◈', className: styles.file },
}

function getTabTitle(tab: Tab): string {
  if (tab.type === 'terminal') return tab.title
  if (tab.type === 'diff') {
    if (tab.commitHash) return `${tab.commitHash.slice(0, 7)} ${tab.commitMessage || ''}`
    return 'Changes'
  }
  if (tab.type === 'markdownPreview') return tab.title
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
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  /** Synchronous source id for drag-over/dropEffect; React state can lag the first dragover frame. */
  const draggingSourceRef = useRef<string | null>(null)
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
  const mergeTabIntoSplit = useAppStore((s) => s.mergeTabIntoSplit)
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

  const canAcceptTabMerge = useCallback((targetTab: Tab, sourceId: string | null): boolean => {
    if (!sourceId || sourceId === targetTab.id) return false
    const sourceTab = tabs.find((t) => t.id === sourceId)
    if (!sourceTab) return false
    const mergeable = (t: Tab) => t.type === 'terminal' || t.type === 'file'
    if (!mergeable(targetTab) || !mergeable(sourceTab)) return false
    // Dropping a terminal onto a file tab would embed a PTY in a tab that unmounts when inactive.
    if (sourceTab.type === 'terminal' && targetTab.type === 'file') return false
    return true
  }, [tabs])

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
      if (tab.type === 'file' && tab.splitRoot) {
        getAllPtyIds(tab.splitRoot).forEach((id) => window.api.pty.destroy(id))
      }
      removeTab(tabId)
    },
    [tabs, removeTab, settings]
  )

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {tabs.map((tab) => {
          const { icon, className } = TAB_ICONS[tab.type]
          const isSaved = tab.id === lastSavedTabId
          const gitStatus = getFileGitStatus(tab)
          const isDeleted = tab.type === 'file' && tab.deleted
          const agentType = tab.type === 'terminal' ? tab.agentType : undefined
          const agentIcon = agentType ? AGENT_ICON_MAP[agentType] : undefined
          const showGeminiIcon =
            tab.type === 'terminal'
            && (agentType === 'gemini' || tab.title === GEMINI_TAB_LABEL)
          const dragMergeTab = tab.type === 'terminal' || tab.type === 'file'
          return (
            <div
              key={tab.id}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ''} ${isDeleted ? styles.deleted : ''} ${draggingTabId === tab.id ? styles.tabDragging : ''} ${dragOverTabId === tab.id && draggingSourceRef.current !== tab.id ? styles.tabDragOver : ''}`}
              onClick={() => setActiveTab(tab.id)}
              draggable={dragMergeTab}
              onDragStart={dragMergeTab ? (e) => {
                draggingSourceRef.current = tab.id
                e.dataTransfer.setData(CONSTELLAGENT_TAB_MIME, tab.id)
                e.dataTransfer.effectAllowed = 'move'
                setDraggingTabId(tab.id)
              } : undefined}
              onDragEnd={dragMergeTab ? () => {
                draggingSourceRef.current = null
                setDraggingTabId(null)
                setDragOverTabId(null)
              } : undefined}
              onDragOver={dragMergeTab ? (e) => {
                if (draggingSourceRef.current === tab.id) return
                const sid = draggingSourceRef.current
                if (sid) {
                  if (!canAcceptTabMerge(tab, sid)) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  setDragOverTabId(tab.id)
                  return
                }
                if (
                  tab.type === 'terminal'
                  && (
                    e.dataTransfer.types.includes(CONSTELLAGENT_PATH_MIME)
                    || e.dataTransfer.types.includes('text/plain')
                  )
                ) {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'copy'
                  setDragOverTabId(tab.id)
                }
              } : undefined}
              onDragLeave={dragMergeTab ? (e) => {
                const related = e.relatedTarget as Node | null
                if (related && e.currentTarget.contains(related)) return
                setDragOverTabId(null)
              } : undefined}
              onDrop={dragMergeTab ? (e) => {
                e.preventDefault()
                setDragOverTabId(null)
                const sourceTabId =
                  e.dataTransfer.getData(CONSTELLAGENT_TAB_MIME) || draggingSourceRef.current
                if (sourceTabId) {
                  mergeTabIntoSplit(sourceTabId, tab.id)
                  return
                }
                if (tab.type === 'terminal') {
                  const filePath = e.dataTransfer.getData(CONSTELLAGENT_PATH_MIME)
                    || e.dataTransfer.getData('text/plain')
                  if (filePath) {
                    const text = `@${filePath}`
                    window.api.pty.write(tab.ptyId, `\x1b[200~${text}\x1b[201~`)
                  }
                }
              } : undefined}
            >
              {agentType === 'cursor' ? (
                <CursorIcon className={styles.agentIcon} />
              ) : showGeminiIcon ? (
                <GeminiIcon className={styles.agentIcon} />
              ) : agentIcon ? (
                <img src={agentIcon.src} alt={agentIcon.alt} className={styles.agentIcon} />
              ) : (
                <span className={`${styles.tabIcon} ${className}`}>{icon}</span>
              )}
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
