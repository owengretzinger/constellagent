import { useCallback } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Tab } from '../../store/types'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './TabBar.module.css'

const MOD_KEY = typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'

const TAB_ICONS: Record<Tab['type'], { icon: string; className: string }> = {
  terminal: { icon: '›', className: styles.terminal },
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
  const reorderTabs = useAppStore((s) => s.reorderTabs)
  const allTabs = useAppStore((s) => s.tabs)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const createTerminalForActiveWorkspace = useAppStore((s) => s.createTerminalForActiveWorkspace)
  const lastSavedTabId = useAppStore((s) => s.lastSavedTabId)
  const settings = useAppStore((s) => s.settings)
  const tabs = allTabs.filter((t) => t.workspaceId === activeWorkspaceId)

  const handleDragStart = useCallback(
    (e: React.DragEvent, index: number) => {
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', String(index))
      e.dataTransfer.setData('application/x-tab-index', String(index))
    },
    []
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent, toIndex: number) => {
      e.preventDefault()
      const fromIndex = parseInt(e.dataTransfer.getData('application/x-tab-index'), 10)
      if (Number.isNaN(fromIndex) || fromIndex === toIndex || !activeWorkspaceId) return
      reorderTabs(activeWorkspaceId, fromIndex, toIndex)
    },
    [activeWorkspaceId, reorderTabs]
  )

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

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList}>
        {tabs.map((tab, index) => {
          const { icon, className } = TAB_ICONS[tab.type]
          const isSaved = tab.id === lastSavedTabId
          const shortcutNum = index < 9 ? index + 1 : null
          return (
            <div
              key={tab.id}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ''}`}
              onClick={() => setActiveTab(tab.id)}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, index)}
            >
              <span className={`${styles.tabIcon} ${className}`}>{icon}</span>
              <span className={`${styles.tabTitle} ${isSaved ? styles.savedFlash : ''}`}>
                {getTabTitle(tab)}
              </span>
              {shortcutNum !== null && (
                <span className={styles.tabShortcut}>{MOD_KEY}{shortcutNum}</span>
              )}
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
