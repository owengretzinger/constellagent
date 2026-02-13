import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'
import { getFocusedPtyId, isFocusedPaneTerminal } from '../store/split-helpers'

export function useShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Tab handling when terminal is focused
      if (e.key === 'Tab' && (e.target as HTMLElement)?.closest?.('[class*="terminalInner"]')) {
        if (e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
          // Shift+Tab: ghostty-web sends \t for both Tab and Shift+Tab
          e.preventDefault()
          e.stopPropagation()
          const s = useAppStore.getState()
          const tab = s.tabs.find((t) => t.id === s.activeTabId)
          if (tab?.type === 'terminal' && isFocusedPaneTerminal(tab.splitRoot, tab.focusedPaneId)) {
            const pty = getFocusedPtyId(tab.splitRoot, tab.focusedPaneId, tab.ptyId)
            if (pty) window.api.pty.write(pty, '\x1b[Z')
          }
        } else {
          // Regular Tab: prevent browser focus navigation, let ghostty-web handle it
          e.preventDefault()
        }
        return
      }

      // Shift+Enter handling when terminal is focused
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
        && (e.target as HTMLElement)?.closest?.('[class*="terminalInner"]')) {
        const s = useAppStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        // Skip when focused pane is a file editor — let Monaco handle Shift+Enter natively
        if (tab?.type === 'terminal' && isFocusedPaneTerminal(tab.splitRoot, tab.focusedPaneId)) {
          // Write kitty keyboard protocol so CLIs (e.g. Claude Code) can distinguish
          // Shift+Enter (new line) from Enter (submit).
          e.preventDefault()
          e.stopPropagation()
          const pty = getFocusedPtyId(tab.splitRoot, tab.focusedPaneId, tab.ptyId)
          if (pty) window.api.pty.write(pty, '\x1b[13;2u')
        }
        return
      }

      // Cmd+Left/Right/Backspace: macOS line-editing conventions.
      // Only Cmd (not Ctrl) — Ctrl+arrow is word movement handled by ghostty.
      // Skip when focused pane is a file editor — let Monaco handle these natively.
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
        && (e.target as HTMLElement)?.closest?.('[class*="terminalInner"]')) {
        const s = useAppStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (tab?.type === 'terminal' && isFocusedPaneTerminal(tab.splitRoot, tab.focusedPaneId)) {
          const pty = getFocusedPtyId(tab.splitRoot, tab.focusedPaneId, tab.ptyId)
          if (pty && e.key === 'ArrowLeft') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(pty, '\x01') // Ctrl+A — beginning of line
            return
          }
          if (pty && e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(pty, '\x05') // Ctrl+E — end of line
            return
          }
          if (pty && e.key === 'Backspace') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(pty, '\x15') // Ctrl+U — kill to beginning of line
            return
          }
        }
      }

      const meta = e.metaKey || e.ctrlKey
      const shift = e.shiftKey
      const alt = e.altKey
      if (!meta) return

      const store = useAppStore.getState()

      // Stop event from reaching terminal (capture phase — must stopPropagation)
      function consume() {
        e.preventDefault()
        e.stopPropagation()
      }

      // ── Quick open: Cmd+P ──
      if (!shift && !alt && e.key === 'p') {
        consume()
        store.toggleQuickOpen()
        return
      }

      // ── Tab switching: Cmd+1-9 ──
      if (!shift && !alt && e.key >= '1' && e.key <= '9') {
        consume()
        store.switchToTabByIndex(parseInt(e.key) - 1)
        return
      }

      // ── Workspace switching: Cmd+Shift+Up / Cmd+Shift+Down ──
      if (shift && !alt && e.key === 'ArrowUp') {
        consume()
        store.prevWorkspace()
        return
      }
      if (shift && !alt && e.key === 'ArrowDown') {
        consume()
        store.nextWorkspace()
        return
      }

      // ── Tab management ──
      if (!shift && !alt && e.key === 't') {
        consume()
        store.createTerminalForActiveWorkspace()
        return
      }
      if (shift && !alt && e.code === 'KeyN') {
        consume()
        store.createTerminalForActiveWorkspace()
        return
      }
      // Cmd+D — split terminal pane right
      if (!shift && !alt && e.code === 'KeyD') {
        consume()
        store.splitTerminalPane('horizontal')
        return
      }
      // Cmd+Shift+D — split terminal pane down
      if (shift && !alt && e.code === 'KeyD') {
        consume()
        store.splitTerminalPane('vertical')
        return
      }
      // Cmd+\ — open current file in split pane alongside terminal
      if (!shift && !alt && e.key === '\\') {
        consume()
        const activeTab = store.tabs.find((t) => t.id === store.activeTabId)
        if (activeTab?.type === 'file') {
          store.openFileInSplit(activeTab.filePath)
        }
        return
      }
      if (!shift && !alt && e.key === 'w') {
        consume()
        // If the active terminal tab has splits, close just the focused pane
        const wTab = store.tabs.find((t) => t.id === store.activeTabId)
        if (wTab?.type === 'terminal' && wTab.splitRoot && wTab.focusedPaneId) {
          store.closeSplitPane(wTab.focusedPaneId)
        } else {
          store.closeActiveTab()
        }
        return
      }
      if (shift && !alt && e.code === 'KeyW') {
        consume()
        store.closeAllWorkspaceTabs()
        return
      }
      if (shift && !alt && e.key === ']') {
        consume()
        store.nextTab()
        return
      }
      if (shift && !alt && e.key === '[') {
        consume()
        store.prevTab()
        return
      }

      // ── Panels ──
      // Cmd+B — toggle sidebar (left)
      if (!shift && !alt && e.key === 'b') {
        consume()
        store.toggleSidebar()
        return
      }
      // Cmd+Option+B — toggle right panel (use e.code since Option changes e.key on macOS)
      if (!shift && alt && e.code === 'KeyB') {
        consume()
        store.toggleRightPanel()
        return
      }
      // Cmd+Shift+E — files panel (open if closed)
      if (shift && !alt && e.code === 'KeyE') {
        consume()
        store.setRightPanelMode('files')
        if (!store.rightPanelOpen) store.toggleRightPanel()
        return
      }
      // Cmd+Shift+G — changes panel (open if closed)
      if (shift && !alt && e.code === 'KeyG') {
        consume()
        store.setRightPanelMode('changes')
        if (!store.rightPanelOpen) store.toggleRightPanel()
        return
      }

      // ── Focus ──
      // Cmd+J — focus terminal (or create one)
      if (!shift && !alt && e.key === 'j') {
        consume()
        store.focusOrCreateTerminal()
        return
      }

      // ── Font size: Cmd+= / Cmd+- / Cmd+0 ──
      if (!shift && !alt && (e.key === '=' || e.key === '-' || e.key === '0')) {
        consume()
        const tab = store.tabs.find((t) => t.id === store.activeTabId)
        const isTerminal = tab?.type === 'terminal'
        const key = isTerminal ? 'terminalFontSize' : 'editorFontSize'
        if (e.key === '0') {
          store.updateSettings({ terminalFontSize: 14, editorFontSize: 13 })
        } else {
          const current = store.settings[key]
          const next = Math.max(8, Math.min(32, current + (e.key === '=' ? 1 : -1)))
          store.updateSettings({ [key]: next })
        }
        return
      }

      // ── Settings ──
      // Cmd+, — toggle settings
      if (!shift && !alt && e.key === ',') {
        consume()
        store.toggleSettings()
        return
      }

      // ── Delete file: Cmd+Backspace ──
      // Only when a file tab is active (not terminal/diff) and target is not a text input
      if (!shift && !alt && e.key === 'Backspace') {
        const target = e.target as HTMLElement
        // Don't intercept when focused inside Monaco editor or terminal
        if (target?.closest?.('[class*="monaco-editor"]') || target?.closest?.('[class*="terminalInner"]')) {
          return
        }
        const tab = store.tabs.find((t) => t.id === store.activeTabId)
        if (tab?.type === 'file') {
          consume()
          const fileName = tab.filePath.split('/').pop() || tab.filePath
          store.showConfirmDialog({
            title: 'Delete File',
            message: `Permanently delete "${fileName}"? This cannot be undone.`,
            confirmLabel: 'Delete',
            destructive: true,
            onConfirm: () => {
              store.dismissConfirmDialog()
              window.api.fs.deleteFile(tab.filePath).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : 'Failed to delete'
                store.addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
              })
            },
          })
        }
        return
      }

      // ── Workspace creation ──
      // Cmd+N — new workspace dialog
      if (!shift && !alt && e.key === 'n') {
        consume()
        const project = store.activeProject()
        if (project) {
          store.openWorkspaceDialog(project.id)
        } else if (store.projects.length === 1) {
          store.openWorkspaceDialog(store.projects[0].id)
        }
        return
      }
    }

    // Capture phase: runs before ghostty-web's stopPropagation() on the terminal element
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // Image paste: ghostty-web ignores clipboard images, so intercept and save to temp file
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      const target = e.target as HTMLElement
      if (!target?.closest?.('[class*="terminalInner"]')) return
      if (!e.clipboardData) return

      const hasImage = Array.from(e.clipboardData.items).some(
        (item) => item.type.startsWith('image/')
      )
      if (!hasImage) return

      e.preventDefault()
      e.stopPropagation()

      const filePath = await window.api.clipboard.saveImage()
      if (!filePath) return

      const s = useAppStore.getState()
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (tab?.type === 'terminal' && isFocusedPaneTerminal(tab.splitRoot, tab.focusedPaneId)) {
        const pty = getFocusedPtyId(tab.splitRoot, tab.focusedPaneId, tab.ptyId)
        if (pty) window.api.pty.write(pty, `\x1b[200~${filePath}\x1b[201~`)
      }
    }

    document.addEventListener('paste', handlePaste, true)
    return () => document.removeEventListener('paste', handlePaste, true)
  }, [])
}
