import { useEffect } from 'react'
import { useAppStore } from '../store/app-store'

export function useShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Shift+Enter handling when terminal is focused
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
        && (e.target as HTMLElement)?.closest?.('[class*="terminalInner"]')) {
        // Write kitty keyboard protocol so CLIs (e.g. Claude Code) can distinguish
        // Shift+Enter (new line) from Enter (submit).
        e.preventDefault()
        e.stopPropagation()
        const s = useAppStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (tab?.type === 'terminal') {
          window.api.pty.write(tab.ptyId, '\x1b[13;2u')
        }
        return
      }

      // Cmd+Left/Right/Backspace: macOS line-editing conventions.
      // Only Cmd (not Ctrl) — Ctrl+arrow is word movement handled by shells/TUIs.
      if (e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
        && (e.target as HTMLElement)?.closest?.('[class*="terminalInner"]')) {
        const s = useAppStore.getState()
        const tab = s.tabs.find((t) => t.id === s.activeTabId)
        if (tab?.type === 'terminal') {
          if (e.key === 'ArrowLeft') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(tab.ptyId, '\x01') // Ctrl+A — beginning of line
            return
          }
          if (e.key === 'ArrowRight') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(tab.ptyId, '\x05') // Ctrl+E — end of line
            return
          }
          if (e.key === 'Backspace') {
            e.preventDefault()
            e.stopPropagation()
            window.api.pty.write(tab.ptyId, '\x15') // Ctrl+U — kill to beginning of line
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
      if (!shift && !alt && e.key === 'w') {
        consume()
        store.closeActiveTab()
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

    // Capture phase: runs before terminal handlers on the focused textarea.
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // Image paste: terminal textareas ignore clipboard images, so intercept and save to temp file.
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
      if (tab?.type === 'terminal') {
        window.api.pty.write(tab.ptyId, `\x1b[200~${filePath}\x1b[201~`)
      }
    }

    document.addEventListener('paste', handlePaste, true)
    return () => document.removeEventListener('paste', handlePaste, true)
  }, [])
}
