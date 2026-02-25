import { useCallback, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Tab } from '../../store/types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './TabBar.module.css'

const TAB_ICONS: Record<Tab['type'], { icon: string; className: string }> = {
  terminal: { icon: '⌘', className: styles.terminal },
  file: { icon: '◇', className: styles.file },
  diff: { icon: '±', className: styles.diff },
}

function getTabTitle(tab: Tab): string {
  if (tab.type === 'terminal') return tab.title
  if (tab.type === 'diff') return 'Changes'
  const name = tab.filePath.split('/').pop() || tab.filePath
  return name
}

export function TabBar() {
  const activeTabId = useAppStore((s) => s.activeTabId)
  const setActiveTab = useAppStore((s) => s.setActiveTab)
  const removeTab = useAppStore((s) => s.removeTab)
  const moveTabInActiveWorkspace = useAppStore((s) => s.moveTabInActiveWorkspace)
  const allTabs = useAppStore((s) => s.tabs)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const createTerminalForActiveWorkspace = useAppStore((s) => s.createTerminalForActiveWorkspace)
  const lastSavedTabId = useAppStore((s) => s.lastSavedTabId)
  const settings = useAppStore((s) => s.settings)
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null)
  const [dragOverTabId, setDragOverTabId] = useState<string | null>(null)
  const tabs = allTabs.filter((t) => t.workspaceId === activeWorkspaceId)

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation()
      const tab = tabs.find((t) => t.id === tabId)
      if (!tab) return

      if (tab.type === 'file' && tab.unsaved && settings.confirmOnClose) {
        if (!window.confirm(`"${getTabTitle(tab)}" has unsaved changes. Close anyway?`)) return
      }

      if (tab.type === 'terminal') {
        window.api.pty.destroy(tab.ptyId)
      }
      removeTab(tabId)
    },
    [settings.confirmOnClose, tabs, removeTab]
  )

  const clearDragState = useCallback(() => {
    setDraggingTabId(null)
    setDragOverTabId(null)
  }, [])

  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>, tabId: string) => {
    setDraggingTabId(tabId)
    setDragOverTabId(null)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', tabId)
  }, [])

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLElement>, tabId?: string) => {
      if (!draggingTabId) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (!tabId || tabId === draggingTabId) {
        setDragOverTabId(null)
        return
      }
      setDragOverTabId(tabId)
    },
    [draggingTabId]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLElement>, targetTabId?: string) => {
      if (!draggingTabId) return
      e.preventDefault()
      const sourceTabId = e.dataTransfer.getData('text/plain') || draggingTabId
      if (targetTabId && sourceTabId !== targetTabId) {
        moveTabInActiveWorkspace(sourceTabId, targetTabId)
      }
      clearDragState()
    },
    [clearDragState, draggingTabId, moveTabInActiveWorkspace]
  )

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {tabs.map((tab, index) => {
          const { icon, className } = TAB_ICONS[tab.type]
          const isSaved = tab.id === lastSavedTabId
          const shortcutHint = index < 9 ? `⌘${index + 1}` : null
          return (
            <div
              key={tab.id}
              draggable
              className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ''} ${draggingTabId === tab.id ? styles.dragging : ''} ${dragOverTabId === tab.id ? styles.dragOver : ''}`}
              onClick={() => setActiveTab(tab.id)}
              onDragStart={(e) => handleDragStart(e, tab.id)}
              onDragOver={(e) => handleDragOver(e, tab.id)}
              onDrop={(e) => handleDrop(e, tab.id)}
              onDragEnd={clearDragState}
            >
              <span className={`${styles.tabIcon} ${className}`}>{icon}</span>
              <span className={`${styles.tabTitle} ${isSaved ? styles.savedFlash : ''}`}>
                {getTabTitle(tab)}
              </span>
              {shortcutHint && <span className={styles.shortcutHint}>{shortcutHint}</span>}
              {tab.type === 'file' && tab.unsaved ? (
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
    </div>
  )
}
