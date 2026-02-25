import { useCallback, useRef, useState } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Tab } from '../../store/types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './TabBar.module.css'

const TAB_ICONS: Record<Tab['type'], { icon: string; className: string }> = {
  terminal: { icon: '', className: styles.terminal },
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
  const allTabs = useAppStore((s) => s.tabs)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const createTerminalForActiveWorkspace = useAppStore((s) => s.createTerminalForActiveWorkspace)
  const lastSavedTabId = useAppStore((s) => s.lastSavedTabId)
  const settings = useAppStore((s) => s.settings)
  const reorderTab = useAppStore((s) => s.reorderTab)
  const tabs = allTabs.filter((t) => t.workspaceId === activeWorkspaceId)

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const dragCounterRef = useRef(0)

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
    [tabs, removeTab]
  )

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    const target = e.currentTarget as HTMLElement
    requestAnimationFrame(() => target.classList.add(styles.dragging))
  }, [])

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
    setDragOverIndex(null)
    dragCounterRef.current = 0
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    dragCounterRef.current++
    setDragOverIndex(index)
  }, [])

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      setDragOverIndex(null)
      dragCounterRef.current = 0
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault()
      const fromIndex = dragIndex
      setDragIndex(null)
      setDragOverIndex(null)
      dragCounterRef.current = 0
      if (fromIndex === null || !activeWorkspaceId) return
      reorderTab(activeWorkspaceId, fromIndex, toIndex)
    },
    [dragIndex, activeWorkspaceId, reorderTab]
  )

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {tabs.map((tab, index) => {
          const { icon, className } = TAB_ICONS[tab.type]
          const isSaved = tab.id === lastSavedTabId
          const isDragging = dragIndex === index
          const isDragOver = dragOverIndex === index && dragIndex !== index

          return (
            <div
              key={tab.id}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ''} ${isDragging ? styles.dragging : ''} ${isDragOver ? styles.dragOver : ''}`}
              onClick={() => setActiveTab(tab.id)}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnd={handleDragEnd}
              onDragEnter={(e) => handleDragEnter(e, index)}
              onDragLeave={handleDragLeave}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
            >
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
              {icon && <span className={`${styles.tabIcon} ${className}`}>{icon}</span>}
              <span className={`${styles.tabTitle} ${isSaved ? styles.savedFlash : ''}`}>
                {getTabTitle(tab)}
              </span>
              {index < 9 && (
                <span className={styles.shortcutBadge}>⌘{index + 1}</span>
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
