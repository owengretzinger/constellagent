import { useAppStore } from '../store/app-store'
import { resolveAgentPtyForContextInjection, resolvePtyForPlanSourceFilePath } from '../store/split-helpers'
import { wrapBracketedPaste } from './bracketed-paste'

/** Drag-and-drop MIME for absolute file paths from the file tree */
export const CONSTELLAGENT_PATH_MIME = 'application/x-constellagent-path'

/** Drag-and-drop MIME for terminal tab IDs (tab-to-tab merge) */
export const CONSTELLAGENT_TAB_MIME = 'application/x-constellagent-tab'

/** Drag-and-drop MIME for workspace IDs (sidebar reorder) */
export const CONSTELLAGENT_WORKSPACE_MIME = 'application/x-constellagent-workspace'

export { wrapBracketedPaste }

function formatSelectionAsContext(filePath: string, languageId: string, selection: string): string {
  const fence = languageId && languageId !== 'plaintext' ? languageId : ''
  const header = `// ${filePath}`
  if (fence) {
    return `\`\`\`${fence}\n${header}\n${selection}\n\`\`\`\n`
  }
  return `\`\`\`\n${header}\n${selection}\n\`\`\`\n`
}

export function sendAddToChatText(filePath: string, languageId: string, selection: string): boolean {
  const trimmed = selection.trim()
  if (!trimmed) return false
  const s = useAppStore.getState()
  const pty =
    resolvePtyForPlanSourceFilePath(
      filePath,
      s.planBuildTerminalByPlanPath,
      s.tabs,
      s.activeWorkspaceId,
    ) ??
    resolveAgentPtyForContextInjection({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      activeWorkspaceId: s.activeWorkspaceId,
    })
  if (!pty) {
    s.addToast({
      id: crypto.randomUUID(),
      message: 'No terminal in this workspace. Press ⌘T to open one.',
      type: 'error',
    })
    return false
  }
  const payload = formatSelectionAsContext(filePath, languageId, trimmed)
  window.api.pty.write(pty, wrapBracketedPaste(payload))
  s.addToast({ id: crypto.randomUUID(), message: 'Added selection to terminal', type: 'info' })
  return true
}

/**
 * Gather the active selection (Monaco editor or window) and send it to the agent terminal.
 * Returns true if a snippet was sent.
 */
export function sendActiveSelectionToAgent(): boolean {
  const store = useAppStore.getState()
  const ed = store.activeMonacoEditor
  if (ed) {
    const sel = ed.getSelection()
    const text = sel ? ed.getModel()?.getValueInRange(sel) : ''
    if (text) {
      const uri = ed.getModel()?.uri.path
      store.sendContextToAgent([{
        text,
        filePath: uri || undefined,
        startLine: sel!.startLineNumber,
        endLine: sel!.endLineNumber,
      }])
      return true
    }
  }

  const text = window.getSelection()?.toString()
  if (text) {
    const activeTab = store.tabs.find((t) => t.id === store.activeTabId)
    const filePath = activeTab && ('filePath' in activeTab) ? (activeTab as { filePath: string }).filePath : undefined
    store.sendContextToAgent([{ text, filePath }])
    return true
  }

  return false
}

export function sendPathToPty(ptyId: string, absolutePath: string): void {
  window.api.pty.write(ptyId, wrapBracketedPaste(absolutePath))
}

/** Whether the current selection's geometry overlaps this container (works when selection is inside shadow DOM). */
export function selectionOverlapsElement(container: HTMLElement, sel: Selection | null): boolean {
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false
  const r = sel.getRangeAt(0).getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return false
  const b = container.getBoundingClientRect()
  return r.bottom >= b.top && r.top <= b.bottom && r.right >= b.left && r.left <= b.right
}

/**
 * After selecting in markdown preview, focus often stays on `body`, so keydown `target` is not inside
 * `[data-constellagent-md-preview]`. Resolve the preview root from selection geometry instead.
 */
export function findMarkdownPreviewRootForCurrentSelection(): HTMLElement | null {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  if (!sel.toString().trim()) return null

  const roots = document.querySelectorAll<HTMLElement>('[data-constellagent-md-preview]')
  for (const root of roots) {
    if (selectionOverlapsElement(root, sel)) {
      return root
    }
  }
  return null
}
