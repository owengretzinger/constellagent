import { useAppStore } from '../store/app-store'
import { resolveAgentPtyForContextInjection } from '../store/split-helpers'

/** Drag-and-drop MIME for absolute file paths from the file tree */
export const CONSTELLAGENT_PATH_MIME = 'application/x-constellagent-path'

export function wrapBracketedPaste(body: string): string {
  return `\x1b[200~${body}\x1b[201~`
}

export function formatSelectionAsContext(filePath: string, languageId: string, selection: string): string {
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
  const pty = resolveAgentPtyForContextInjection({
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
