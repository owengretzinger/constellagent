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
  const dragStartX = useRef(0)
  const didDrag = useRef(false)
  const tabListRef = useRef<HTMLDivElement>(null)

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

  const handleMouseDown = useCallback((e: React.MouseEvent, index: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    dragStartX.current = e.clientX
    didDrag.current = false

    const container = tabListRef.current
    if (!container) return

    const tabEls = Array.from(container.children) as HTMLElement[]
    const rects = tabEls.map((el) => el.getBoundingClientRect())

    let currentFrom = index

    const onMove = (ev: MouseEvent) => {
      const dx = Math.abs(ev.clientX - dragStartX.current)
      if (dx < 5 && !didDrag.current) return
      if (!didDrag.current) {
        didDrag.current = true
        setDragIndex(currentFrom)
      }

      let toIndex = currentFrom
      for (let i = 0; i < rects.length; i++) {
        const mid = rects[i].left + rects[i].width / 2
        if (ev.clientX < mid) { toIndex = i; break }
        toIndex = i
      }

      if (toIndex !== currentFrom && activeWorkspaceId) {
        reorderTab(activeWorkspaceId, currentFrom, toIndex)
        currentFrom = toIndex
        setDragIndex(toIndex)
        requestAnimationFrame(() => {
          const newTabEls = Array.from(container.children) as HTMLElement[]
          for (let i = 0; i < newTabEls.length && i < rects.length; i++) {
            rects[i] = newTabEls[i].getBoundingClientRect()
          }
        })
      }
    }

    const onUp = () => {
      setDragIndex(null)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [activeWorkspaceId, reorderTab])

  const handleTabClick = useCallback((tabId: string) => {
    if (didDrag.current) return
    setActiveTab(tabId)
  }, [setActiveTab])

  return (
    <div className={styles.tabBar}>
      <div className={styles.tabList} ref={tabListRef}>
        {tabs.map((tab, index) => {
          const { icon, className } = TAB_ICONS[tab.type]
          const isSaved = tab.id === lastSavedTabId
          const isDragging = dragIndex === index

          return (
            <div
              key={tab.id}
              className={`${styles.tab} ${tab.id === activeTabId ? styles.active : ''} ${isDragging ? styles.dragging : ''}`}
              onClick={() => handleTabClick(tab.id)}
              onMouseDown={(e) => handleMouseDown(e, index)}
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
