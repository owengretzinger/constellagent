import type { SplitNode, SplitLeaf, Tab } from './types'

function isTerminalTab(tab: Tab): tab is Extract<Tab, { type: 'terminal' }> {
  return tab.type === 'terminal'
}

/**
 * PTY to receive agent input for a terminal tab, even when the focused split pane is a file editor.
 */
export function resolvePtyForTerminalTab(tab: Extract<Tab, { type: 'terminal' }>): string {
  const pty = getFocusedPtyId(tab.splitRoot, tab.focusedPaneId, tab.ptyId)
  if (pty) return pty
  if (tab.splitRoot) {
    const leaf = firstTerminalLeaf(tab.splitRoot)
    if (leaf) return leaf.ptyId
  }
  return tab.ptyId
}

/**
 * PTY for "Add to chat" / context injection: active terminal tab if any, else first terminal in workspace.
 */
export function resolveAgentPtyForContextInjection(params: {
  tabs: Tab[]
  activeTabId: string | null
  activeWorkspaceId: string | null
}): string | undefined {
  const { tabs, activeTabId, activeWorkspaceId } = params
  if (!activeWorkspaceId) return undefined

  const activeTab = activeTabId ? tabs.find((t) => t.id === activeTabId) : undefined
  if (activeTab && isTerminalTab(activeTab)) {
    return resolvePtyForTerminalTab(activeTab)
  }

  const termTab = tabs.find((t) => t.workspaceId === activeWorkspaceId && t.type === 'terminal')
  if (!termTab || termTab.type !== 'terminal') return undefined
  return resolvePtyForTerminalTab(termTab)
}

/**
 * PTY for the terminal tab last spawned by plan Build for this source file, if still open in the workspace.
 */
export function resolvePtyForPlanSourceFilePath(
  sourceFilePath: string | undefined,
  planBuildTerminalByPlanPath: Record<string, string>,
  tabs: Tab[],
  activeWorkspaceId: string | null,
): string | undefined {
  if (!sourceFilePath || !activeWorkspaceId) return undefined
  const terminalTabId = planBuildTerminalByPlanPath[sourceFilePath]
  if (!terminalTabId) return undefined
  const tab = tabs.find((t) => t.id === terminalTabId)
  if (!tab || tab.type !== 'terminal' || tab.workspaceId !== activeWorkspaceId) return undefined
  return resolvePtyForTerminalTab(tab)
}

/** Recursively collect all PTY IDs from a split tree (terminal leaves only). */
export function getAllPtyIds(node: SplitNode): string[] {
  if (node.type === 'leaf') {
    return node.contentType === 'terminal' ? [node.ptyId] : []
  }
  return node.children.flatMap(getAllPtyIds)
}

/** Find a leaf node by its pane ID. */
export function findLeaf(root: SplitNode, paneId: string): SplitLeaf | null {
  if (root.type === 'leaf') return root.id === paneId ? root : null
  for (const child of root.children) {
    const found = findLeaf(child, paneId)
    if (found) return found
  }
  return null
}

/** Find a leaf node by its PTY ID (terminal leaves only). */
export function findLeafByPtyId(root: SplitNode, ptyId: string): (SplitLeaf & { contentType: 'terminal' }) | null {
  if (root.type === 'leaf') {
    return root.contentType === 'terminal' && root.ptyId === ptyId ? root : null
  }
  for (const child of root.children) {
    const found = findLeafByPtyId(child, ptyId)
    if (found) return found
  }
  return null
}

/**
 * Graft two split trees into a new split node at the root level.
 * Used when merging one terminal tab's tree into another.
 */
export function graftTree(
  existing: SplitNode,
  graft: SplitNode,
  direction: 'horizontal' | 'vertical',
): SplitNode {
  return {
    type: 'split',
    id: crypto.randomUUID(),
    direction,
    children: [existing, graft],
  }
}

/**
 * Replace a leaf with a split node containing the original leaf and a new leaf.
 * Returns a new tree (immutable).
 */
export function splitLeaf(
  root: SplitNode,
  leafId: string,
  direction: 'horizontal' | 'vertical',
  newLeaf: SplitLeaf,
): SplitNode {
  if (root.type === 'leaf') {
    if (root.id === leafId) {
      return {
        type: 'split',
        id: crypto.randomUUID(),
        direction,
        children: [root, newLeaf],
      }
    }
    return root
  }

  // Recurse into children
  const newChildren = root.children.map((child) =>
    splitLeaf(child, leafId, direction, newLeaf),
  ) as [SplitNode, SplitNode]

  // Only create a new node if something changed
  if (newChildren[0] === root.children[0] && newChildren[1] === root.children[1]) {
    return root
  }
  return { ...root, children: newChildren }
}

/**
 * Remove a leaf from the tree. If removing leaves only one child in a split,
 * collapse the split to that child. Returns null if the tree becomes empty.
 */
export function removeLeaf(root: SplitNode, leafId: string): SplitNode | null {
  if (root.type === 'leaf') {
    return root.id === leafId ? null : root
  }

  const newChildren = root.children.map((child) => removeLeaf(child, leafId))

  // If one child was removed, collapse to the surviving child
  if (newChildren[0] === null) return newChildren[1]
  if (newChildren[1] === null) return newChildren[0]

  // Only create a new node if something changed
  if (newChildren[0] === root.children[0] && newChildren[1] === root.children[1]) {
    return root
  }
  return { ...root, children: newChildren as [SplitNode, SplitNode] }
}

/** Collect all leaf nodes in depth-first order. */
export function collectLeaves(node: SplitNode): SplitLeaf[] {
  if (node.type === 'leaf') return [node]
  return node.children.flatMap(collectLeaves)
}

/** Get the first leaf in the tree (depth-first, left-to-right). */
export function firstLeaf(root: SplitNode): SplitLeaf {
  if (root.type === 'leaf') return root
  return firstLeaf(root.children[0])
}

/** Get the first terminal leaf in the tree, or null if none exist. */
export function firstTerminalLeaf(root: SplitNode): (SplitLeaf & { contentType: 'terminal' }) | null {
  if (root.type === 'leaf') {
    return root.contentType === 'terminal' ? root : null
  }
  return firstTerminalLeaf(root.children[0]) ?? firstTerminalLeaf(root.children[1])
}

/** Get the focused leaf node, or null if not found. */
export function getFocusedLeaf(
  splitRoot: SplitNode | undefined,
  focusedPaneId: string | undefined,
): SplitLeaf | null {
  if (!splitRoot || !focusedPaneId) return null
  return findLeaf(splitRoot, focusedPaneId)
}

/**
 * Get the focused pane's PTY ID, falling back to the tab's primary ptyId.
 * Returns undefined if the focused leaf is a file pane.
 */
export function getFocusedPtyId(
  splitRoot: SplitNode | undefined,
  focusedPaneId: string | undefined,
  fallbackPtyId: string,
): string | undefined {
  if (!splitRoot || !focusedPaneId) return fallbackPtyId
  const leaf = findLeaf(splitRoot, focusedPaneId)
  if (!leaf) return fallbackPtyId
  return leaf.contentType === 'terminal' ? leaf.ptyId : undefined
}

/**
 * Check whether the focused pane in the active tab is a terminal.
 * Returns true for non-split terminals and terminal leaves in splits.
 * Returns false when the focused pane is a file editor.
 */
export function isFocusedPaneTerminal(
  splitRoot: SplitNode | undefined,
  focusedPaneId: string | undefined,
): boolean {
  if (!splitRoot || !focusedPaneId) return true // no split = single terminal
  const leaf = findLeaf(splitRoot, focusedPaneId)
  if (!leaf) return true // fallback
  return leaf.contentType === 'terminal'
}

/**
 * Normalize a split tree from persisted state.
 * Old format leaves have `ptyId` but no `contentType` — add `contentType: 'terminal'`.
 */
export function normalizeSplitTree(node: SplitNode): SplitNode {
  if (node.type === 'leaf') {
    // Widen to a generic record so the `in` check doesn't narrow to `never`
    // (all current SplitLeaf variants declare `contentType`, but legacy persisted data may lack it)
    const raw = node as Record<string, unknown>
    if (!raw.contentType) {
      return { type: 'leaf', id: raw.id as string, contentType: 'terminal', ptyId: raw.ptyId as string }
    }
    return node
  }
  const newChildren = node.children.map(normalizeSplitTree) as [SplitNode, SplitNode]
  if (newChildren[0] === node.children[0] && newChildren[1] === node.children[1]) {
    return node
  }
  return { ...node, children: newChildren }
}
