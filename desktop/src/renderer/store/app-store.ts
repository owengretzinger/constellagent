import { create } from 'zustand'
import type { AppState, PersistedState, Tab, SplitNode } from './types'
import { DEFAULT_SETTINGS } from './types'
import { getAllPtyIds, splitLeaf, removeLeaf, findLeaf, firstLeaf, firstTerminalLeaf, normalizeSplitTree } from './split-helpers'

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  workspaces: [],
  tabs: [],
  automations: [],
  activeWorkspaceId: null,
  activeTabId: null,
  lastActiveTabByWorkspace: {},
  rightPanelMode: 'files',
  rightPanelOpen: true,
  sidebarCollapsed: false,
  lastSavedTabId: null,
  workspaceDialogProjectId: null,
  settings: { ...DEFAULT_SETTINGS },
  settingsOpen: false,
  automationsOpen: false,
  confirmDialog: null,
  toasts: [],
  quickOpenVisible: false,
  unreadWorkspaceIds: new Set<string>(),
  activeClaudeWorkspaceIds: new Set<string>(),
  prStatusMap: new Map(),
  ghAvailability: new Map(),
  gitFileStatuses: new Map(),

  addProject: (project) =>
    set((s) => ({ projects: [...s.projects, project] })),

  removeProject: (id) =>
    set((s) => {
      // Clean up automations for this project in main process
      const projectAutomations = s.automations.filter((a) => a.projectId === id)
      for (const a of projectAutomations) {
        window.api.automations.delete(a.id)
      }
      const removedWsIds = new Set(s.workspaces.filter((w) => w.projectId === id).map((w) => w.id))
      const newProjects = s.projects.filter((p) => p.id !== id)
      const newWorkspaces = s.workspaces.filter((w) => w.projectId !== id)
      const newTabs = s.tabs.filter((t) => !removedWsIds.has(t.workspaceId))
      const newAutomations = s.automations.filter((a) => a.projectId !== id)
      const newUnread = new Set(Array.from(s.unreadWorkspaceIds).filter((wsId) => !removedWsIds.has(wsId)))
      const newActiveClaude = new Set(Array.from(s.activeClaudeWorkspaceIds).filter((wsId) => !removedWsIds.has(wsId)))
      const newPrStatusMap = new Map(
        Array.from(s.prStatusMap.entries()).filter(([key]) => !key.startsWith(`${id}:`))
      )
      const newGhAvailability = new Map(s.ghAvailability)
      newGhAvailability.delete(id)

      const tabMap = { ...s.lastActiveTabByWorkspace }
      for (const wsId of removedWsIds) delete tabMap[wsId]

      const activeWorkspaceId =
        s.activeWorkspaceId && removedWsIds.has(s.activeWorkspaceId)
          ? (newWorkspaces[0]?.id ?? null)
          : s.activeWorkspaceId
      const activeTabId = newTabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (newTabs.find((t) => t.workspaceId === activeWorkspaceId)?.id ?? newTabs[0]?.id ?? null)

      return {
        projects: newProjects,
        workspaces: newWorkspaces,
        tabs: newTabs,
        automations: newAutomations,
        unreadWorkspaceIds: newUnread,
        activeClaudeWorkspaceIds: newActiveClaude,
        prStatusMap: newPrStatusMap,
        ghAvailability: newGhAvailability,
        activeWorkspaceId,
        activeTabId,
        lastActiveTabByWorkspace: tabMap,
      }
    }),

  addWorkspace: (workspace) =>
    set((s) => ({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
    })),

  removeWorkspace: (id) =>
    set((s) => {
      const newWorkspaces = s.workspaces.filter((w) => w.id !== id)
      const newTabs = s.tabs.filter((t) => t.workspaceId !== id)
      const newUnread = new Set(s.unreadWorkspaceIds)
      newUnread.delete(id)
      const newActiveClaude = new Set(s.activeClaudeWorkspaceIds)
      newActiveClaude.delete(id)
      const tabMap = { ...s.lastActiveTabByWorkspace }
      delete tabMap[id]
      return {
        workspaces: newWorkspaces,
        tabs: newTabs,
        unreadWorkspaceIds: newUnread,
        activeClaudeWorkspaceIds: newActiveClaude,
        lastActiveTabByWorkspace: tabMap,
        activeWorkspaceId:
          s.activeWorkspaceId === id
            ? newWorkspaces[0]?.id ?? null
            : s.activeWorkspaceId,
        activeTabId:
          newTabs.find((t) => t.id === s.activeTabId)
            ? s.activeTabId
            : newTabs[0]?.id ?? null,
      }
    }),

  renameWorkspace: (id, name) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => w.id === id ? { ...w, name } : w),
    })),

  updateWorkspaceBranch: (id, branch) =>
    set((s) => ({
      workspaces: s.workspaces.map((w) => w.id === id ? { ...w, branch } : w),
    })),

  setActiveWorkspace: (id) =>
    set((s) => {
      // Remember which tab was active in the workspace we're leaving
      const tabMap = { ...s.lastActiveTabByWorkspace }
      if (s.activeWorkspaceId && s.activeTabId) {
        tabMap[s.activeWorkspaceId] = s.activeTabId
      }

      const wsTabs = s.tabs.filter((t) => t.workspaceId === id)
      const newUnread = new Set(s.unreadWorkspaceIds)
      if (id) newUnread.delete(id)

      // Restore remembered tab, falling back to first tab
      const remembered = id ? tabMap[id] : null
      const activeTabId = remembered && wsTabs.some((t) => t.id === remembered)
        ? remembered
        : wsTabs[0]?.id ?? null

      return {
        activeWorkspaceId: id,
        activeTabId,
        lastActiveTabByWorkspace: tabMap,
        unreadWorkspaceIds: newUnread,
      }
    }),

  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
    })),

  removeTab: (id) =>
    set((s) => {
      const newTabs = s.tabs.filter((t) => t.id !== id)
      const wasActive = s.activeTabId === id
      const wsTabs = newTabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
      return {
        tabs: newTabs,
        activeTabId: wasActive ? (wsTabs[wsTabs.length - 1]?.id ?? null) : s.activeTabId,
      }
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  setRightPanelMode: (mode) => set({ rightPanelMode: mode }),

  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),

  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  nextTab: () => {
    const s = get()
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    if (wsTabs.length <= 1) return
    const idx = wsTabs.findIndex((t) => t.id === s.activeTabId)
    const next = wsTabs[(idx + 1) % wsTabs.length]
    set({ activeTabId: next.id })
  },

  prevTab: () => {
    const s = get()
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    if (wsTabs.length <= 1) return
    const idx = wsTabs.findIndex((t) => t.id === s.activeTabId)
    const prev = wsTabs[(idx - 1 + wsTabs.length) % wsTabs.length]
    set({ activeTabId: prev.id })
  },

  createTerminalForActiveWorkspace: async () => {
    const s = get()
    if (!s.activeWorkspaceId) return
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!ws) return

    const shell = s.settings.defaultShell || undefined
    const ptyId = await window.api.pty.create(ws.worktreePath, shell, { AGENT_ORCH_WS_ID: ws.id })
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    const termCount = wsTabs.filter((t) => t.type === 'terminal').length

    get().addTab({
      id: crypto.randomUUID(),
      workspaceId: s.activeWorkspaceId,
      type: 'terminal',
      title: `Terminal ${termCount + 1}`,
      ptyId,
    })
  },

  closeActiveTab: () => {
    const s = get()
    if (!s.activeTabId) return
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return
    if (tab.type === 'file' && tab.unsaved && s.settings.confirmOnClose) {
      if (!window.confirm('This file has unsaved changes. Close anyway?')) return
    }
    if (tab.type === 'terminal') {
      // Destroy all PTYs: backing PTY + any in the split tree
      const ptyIds = new Set(tab.splitRoot ? getAllPtyIds(tab.splitRoot) : [])
      ptyIds.add(tab.ptyId)
      ptyIds.forEach((id) => window.api.pty.destroy(id))
    }
    get().removeTab(tab.id)
  },

  setTabUnsaved: (tabId, unsaved) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.type === 'file' ? { ...t, unsaved } : t
      ),
    })),

  notifyTabSaved: (tabId) => {
    set({ lastSavedTabId: tabId })
    setTimeout(() => {
      if (get().lastSavedTabId === tabId) set({ lastSavedTabId: null })
    }, 1200)
  },

  openFileTab: (filePath) => {
    const s = get()
    if (!s.activeWorkspaceId) return
    const existing = s.tabs.find(
      (t) => t.workspaceId === s.activeWorkspaceId && t.type === 'file' && t.filePath === filePath
    )
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    get().addTab({
      id: crypto.randomUUID(),
      workspaceId: s.activeWorkspaceId,
      type: 'file',
      filePath,
    })
  },

  nextWorkspace: () => {
    const s = get()
    if (s.workspaces.length <= 1) return
    // Build visual order: workspaces grouped by project, matching sidebar display
    const ordered = s.projects.flatMap((p) =>
      s.workspaces.filter((w) => w.projectId === p.id),
    )
    if (ordered.length <= 1) return
    const idx = ordered.findIndex((w) => w.id === s.activeWorkspaceId)
    const next = ordered[(idx + 1) % ordered.length]
    get().setActiveWorkspace(next.id)
  },

  prevWorkspace: () => {
    const s = get()
    if (s.workspaces.length <= 1) return
    const ordered = s.projects.flatMap((p) =>
      s.workspaces.filter((w) => w.projectId === p.id),
    )
    if (ordered.length <= 1) return
    const idx = ordered.findIndex((w) => w.id === s.activeWorkspaceId)
    const prev = ordered[(idx - 1 + ordered.length) % ordered.length]
    get().setActiveWorkspace(prev.id)
  },

  switchToTabByIndex: (index) => {
    const s = get()
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    if (index >= 0 && index < wsTabs.length) {
      set({ activeTabId: wsTabs[index].id })
    }
  },

  closeAllWorkspaceTabs: () => {
    const s = get()
    if (!s.activeWorkspaceId) return
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    const hasUnsaved = wsTabs.some((t) => t.type === 'file' && t.unsaved)
    if (hasUnsaved && !window.confirm('Close all tabs? Some have unsaved changes.')) return
    wsTabs.forEach((t) => {
      if (t.type === 'terminal') {
        const ptyIds = new Set(t.splitRoot ? getAllPtyIds(t.splitRoot) : [])
        ptyIds.add(t.ptyId)
        ptyIds.forEach((id) => window.api.pty.destroy(id))
      }
    })
    const wsId = s.activeWorkspaceId
    set((state) => ({
      tabs: state.tabs.filter((t) => t.workspaceId !== wsId),
      activeTabId: null,
    }))
  },

  focusOrCreateTerminal: async () => {
    const s = get()
    if (!s.activeWorkspaceId) return
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
    const termTab = wsTabs.find((t) => t.type === 'terminal')
    if (termTab) {
      set({ activeTabId: termTab.id })
    } else {
      await get().createTerminalForActiveWorkspace()
    }
  },

  splitTerminalPane: async (direction) => {
    const s = get()
    if (!s.activeTabId) return
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab) return

    const ws = s.workspaces.find((w) => w.id === tab.workspaceId)
    if (!ws) return

    const shell = s.settings.defaultShell || undefined

    // Active tab is a file tab — convert to a split container with file + terminal panes
    if (tab.type === 'file') {
      const backingPtyId = await window.api.pty.create(ws.worktreePath, shell, { AGENT_ORCH_WS_ID: ws.id })
      const newPtyId = await window.api.pty.create(ws.worktreePath, shell, { AGENT_ORCH_WS_ID: ws.id })

      const originalLeafId = crypto.randomUUID()
      const newLeafId = crypto.randomUUID()

      const splitRoot: SplitNode = {
        type: 'split' as const,
        id: crypto.randomUUID(),
        direction,
        children: [
          { type: 'leaf' as const, id: originalLeafId, contentType: 'file' as const, filePath: tab.filePath },
          { type: 'leaf' as const, id: newLeafId, contentType: 'terminal' as const, ptyId: newPtyId },
        ] as [SplitNode, SplitNode],
      }

      const fileName = tab.filePath.split('/').pop() || 'Split'
      const tabId = tab.id
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                id: tabId,
                workspaceId: t.workspaceId,
                type: 'terminal' as const,
                title: fileName,
                ptyId: backingPtyId,
                splitRoot,
                focusedPaneId: newLeafId,
              }
            : t
        ),
        activeTabId: tabId,
      }))
      return
    }

    if (tab.type !== 'terminal') return

    const newPtyId = await window.api.pty.create(ws.worktreePath, shell, { AGENT_ORCH_WS_ID: ws.id })
    const newLeafId = crypto.randomUUID()

    // Build the split tree: if no splitRoot yet, create one from the existing single pane
    const currentRoot = tab.splitRoot ?? { type: 'leaf' as const, id: tab.id, contentType: 'terminal' as const, ptyId: tab.ptyId }
    const targetPaneId = tab.focusedPaneId ?? (currentRoot.type === 'leaf' ? currentRoot.id : firstLeaf(currentRoot).id)
    const newLeaf = { type: 'leaf' as const, id: newLeafId, contentType: 'terminal' as const, ptyId: newPtyId }
    const newRoot = splitLeaf(currentRoot, targetPaneId, direction, newLeaf)

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tab.id && t.type === 'terminal'
          ? { ...t, splitRoot: newRoot, focusedPaneId: newLeafId }
          : t
      ),
    }))
  },

  openFileInSplit: async (filePath, direction = 'horizontal') => {
    const s = get()
    if (!s.activeWorkspaceId) return

    let tab = s.tabs.find((t) => t.id === s.activeTabId)

    // Active tab is a file tab — convert to a split container with two file panes
    if (tab && tab.type === 'file') {
      const ws = s.workspaces.find((w) => w.id === tab!.workspaceId)
      if (!ws) return

      // Create a backing PTY (required by the terminal tab type)
      const shell = s.settings.defaultShell || undefined
      const backingPtyId = await window.api.pty.create(ws.worktreePath, shell, { AGENT_ORCH_WS_ID: ws.id })

      const originalLeafId = crypto.randomUUID()
      const newLeafId = crypto.randomUUID()
      const originalFilePath = tab.filePath

      const splitRoot = {
        type: 'split' as const,
        id: crypto.randomUUID(),
        direction,
        children: [
          { type: 'leaf' as const, id: originalLeafId, contentType: 'file' as const, filePath: originalFilePath },
          { type: 'leaf' as const, id: newLeafId, contentType: 'file' as const, filePath },
        ] as [SplitNode, SplitNode],
      }

      const fileName = originalFilePath.split('/').pop() || 'Split'
      const tabId = tab.id
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                id: tabId,
                workspaceId: t.workspaceId,
                type: 'terminal' as const,
                title: fileName,
                ptyId: backingPtyId,
                splitRoot,
                focusedPaneId: newLeafId,
              }
            : t
        ),
        activeTabId: tabId,
      }))
      return
    }

    // Find the active terminal tab, or fall back to the first terminal tab in this workspace
    if (!tab || tab.type !== 'terminal') {
      tab = s.tabs.find((t) => t.workspaceId === s.activeWorkspaceId && t.type === 'terminal')
    }

    // No terminal tab exists — create one first so we have a pane to split with
    if (!tab || tab.type !== 'terminal') {
      await get().createTerminalForActiveWorkspace()
      const updated = get()
      tab = updated.tabs.find((t) => t.id === updated.activeTabId)
      if (!tab || tab.type !== 'terminal') return
    }

    const newLeafId = crypto.randomUUID()
    const newLeaf = { type: 'leaf' as const, id: newLeafId, contentType: 'file' as const, filePath }

    // Build the split tree: if no splitRoot yet, create one from the existing single pane
    const currentRoot = tab.splitRoot ?? { type: 'leaf' as const, id: tab.id, contentType: 'terminal' as const, ptyId: tab.ptyId }
    const targetPaneId = tab.focusedPaneId ?? (currentRoot.type === 'leaf' ? currentRoot.id : firstLeaf(currentRoot).id)
    const newRoot = splitLeaf(currentRoot, targetPaneId, direction, newLeaf)

    const tabId = tab.id
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId && t.type === 'terminal'
          ? { ...t, splitRoot: newRoot, focusedPaneId: newLeafId }
          : t
      ),
      activeTabId: tabId,
    }))
  },

  setFocusedPane: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.type === 'terminal' ? { ...t, focusedPaneId: paneId } : t
      ),
    })),

  closeSplitPane: (paneId) => {
    const s = get()
    if (!s.activeTabId) return
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab || tab.type !== 'terminal' || !tab.splitRoot) return

    // Find the pane — only destroy PTY for terminal leaves
    const leaf = findLeaf(tab.splitRoot, paneId)
    if (!leaf) return
    if (leaf.contentType === 'terminal') {
      window.api.pty.destroy(leaf.ptyId)
    }

    const newRoot = removeLeaf(tab.splitRoot, paneId)
    if (!newRoot) {
      // All panes removed — close the whole tab (destroy any remaining PTYs)
      window.api.pty.destroy(tab.ptyId)
      get().removeTab(tab.id)
      return
    }

    const isSingleLeaf = newRoot.type === 'leaf'

    // Collapsed to a single file leaf → open file as standalone tab, close terminal tab
    if (isSingleLeaf && newRoot.type === 'leaf' && newRoot.contentType === 'file') {
      const filePath = newRoot.filePath
      const workspaceId = tab.workspaceId
      // Destroy the tab's primary PTY if it's still alive (it may already be destroyed)
      // getAllPtyIds from the *original* tree minus the removed leaf gives us the surviving PTYs
      const survivingPtyIds = getAllPtyIds(newRoot)
      // Also destroy tab.ptyId if it wasn't already destroyed
      if (leaf.contentType !== 'terminal' || leaf.ptyId !== tab.ptyId) {
        // tab.ptyId is still alive — destroy it
        window.api.pty.destroy(tab.ptyId)
      }
      survivingPtyIds.forEach((id) => window.api.pty.destroy(id))

      get().removeTab(tab.id)
      // Open the file as a standalone file tab
      if (!get().tabs.some((t) => t.workspaceId === workspaceId && t.type === 'file' && t.filePath === filePath)) {
        get().addTab({
          id: crypto.randomUUID(),
          workspaceId,
          type: 'file',
          filePath,
        })
      } else {
        // File tab already open — just switch to it
        const existing = get().tabs.find(
          (t) => t.workspaceId === workspaceId && t.type === 'file' && t.filePath === filePath
        )
        if (existing) set({ activeTabId: existing.id })
      }
      return
    }

    // Collapsed to a single terminal leaf → promote as primary PTY, clear split
    if (isSingleLeaf && newRoot.type === 'leaf' && newRoot.contentType === 'terminal') {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tab.id && t.type === 'terminal'
            ? { ...t, ptyId: newRoot.ptyId, splitRoot: undefined, focusedPaneId: undefined }
            : t
        ),
      }))
      return
    }

    // Multiple panes remain — keep the split tree
    const newFocused = firstLeaf(newRoot).id

    // If the destroyed pane's PTY matched tab.ptyId, promote another terminal's PTY
    // so tab.ptyId always references a live process
    let promotedPtyId = tab.ptyId
    if (leaf.contentType === 'terminal' && leaf.ptyId === tab.ptyId) {
      const nextTerminal = firstTerminalLeaf(newRoot)
      if (nextTerminal) promotedPtyId = nextTerminal.ptyId
    }

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tab.id && t.type === 'terminal'
          ? { ...t, ptyId: promotedPtyId, splitRoot: newRoot, focusedPaneId: newFocused }
          : t
      ),
    }))
  },

  openWorkspaceDialog: (projectId) => set({ workspaceDialogProjectId: projectId }),

  deleteWorkspace: async (workspaceId) => {
    const s = get()
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const project = s.projects.find((p) => p.id === ws.projectId)

    // Destroy PTYs for this workspace (including backing PTYs and split panes)
    s.tabs.filter((t) => t.workspaceId === workspaceId && t.type === 'terminal').forEach((t) => {
      if (t.type === 'terminal') {
        const ptyIds = new Set(t.splitRoot ? getAllPtyIds(t.splitRoot) : [])
        ptyIds.add(t.ptyId)
        ptyIds.forEach((id) => window.api.pty.destroy(id))
      }
    })

    // Remove from state immediately so sidebar updates
    get().removeWorkspace(workspaceId)

    // Remove git worktree in background (skip if workspace uses the main repo directly)
    if (project && ws.worktreePath !== project.repoPath) {
      try {
        await window.api.git.removeWorktree(project.repoPath, ws.worktreePath)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to remove worktree'
        get().addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
      }
    }
  },

  updateProject: (id, partial) =>
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, ...partial } : p)),
    })),

  deleteProject: async (projectId) => {
    const s = get()
    const project = s.projects.find((p) => p.id === projectId)
    if (!project) return
    const projectWorkspaces = s.workspaces.filter((w) => w.projectId === projectId)

    // Destroy PTYs and remove worktrees for all workspaces in this project
    for (const ws of projectWorkspaces) {
      s.tabs.filter((t) => t.workspaceId === ws.id && t.type === 'terminal').forEach((t) => {
        if (t.type === 'terminal') {
          const ptyIds = new Set(t.splitRoot ? getAllPtyIds(t.splitRoot) : [])
          ptyIds.add(t.ptyId)
          ptyIds.forEach((id) => window.api.pty.destroy(id))
        }
      })
      if (ws.worktreePath !== project.repoPath) {
        try {
          await window.api.git.removeWorktree(project.repoPath, ws.worktreePath)
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Failed to remove worktree'
          get().addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
        }
      }
    }

    get().removeProject(projectId)
  },

  updateSettings: (partial) =>
    set((s) => ({ settings: { ...s.settings, ...partial } })),

  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, automationsOpen: false })),
  toggleAutomations: () => set((s) => ({ automationsOpen: !s.automationsOpen, settingsOpen: false })),

  showConfirmDialog: (dialog) => set({ confirmDialog: dialog }),

  dismissConfirmDialog: () => set({ confirmDialog: null }),

  addToast: (toast) =>
    set((s) => ({ toasts: [...s.toasts, toast] })),

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  toggleQuickOpen: () => set((s) => ({ quickOpenVisible: !s.quickOpenVisible })),
  closeQuickOpen: () => set({ quickOpenVisible: false }),

  markWorkspaceUnread: (workspaceId) =>
    set((s) => {
      if (s.unreadWorkspaceIds.has(workspaceId)) return s
      const newUnread = new Set(s.unreadWorkspaceIds)
      newUnread.add(workspaceId)
      return { unreadWorkspaceIds: newUnread }
    }),

  clearWorkspaceUnread: (workspaceId) =>
    set((s) => {
      if (!s.unreadWorkspaceIds.has(workspaceId)) return s
      const newUnread = new Set(s.unreadWorkspaceIds)
      newUnread.delete(workspaceId)
      return { unreadWorkspaceIds: newUnread }
    }),

  setActiveClaudeWorkspaces: (workspaceIds) =>
    set(() => ({ activeClaudeWorkspaceIds: new Set(workspaceIds) })),

  setGitFileStatuses: (worktreePath, statuses) =>
    set((s) => {
      const m = new Map(s.gitFileStatuses)
      m.set(worktreePath, statuses)
      return { gitFileStatuses: m }
    }),

  setTabDeleted: (tabId, deleted) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId && t.type === 'file' ? { ...t, deleted } : t
      ),
    })),

  setPrStatuses: (projectId, statuses) =>
    set((s) => {
      const newMap = new Map(s.prStatusMap)
      for (const [branch, info] of Object.entries(statuses)) {
        newMap.set(`${projectId}:${branch}`, info)
      }
      return { prStatusMap: newMap }
    }),

  setGhAvailability: (projectId, available) =>
    set((s) => {
      const newMap = new Map(s.ghAvailability)
      newMap.set(projectId, available)
      return { ghAvailability: newMap }
    }),

  addAutomation: (automation) =>
    set((s) => ({ automations: [...s.automations, automation] })),

  updateAutomation: (id, partial) =>
    set((s) => ({
      automations: s.automations.map((a) => (a.id === id ? { ...a, ...partial } : a)),
    })),

  removeAutomation: (id) =>
    set((s) => ({ automations: s.automations.filter((a) => a.id !== id) })),

  openDiffTab: (workspaceId) => {
    const s = get()
    const existing = s.tabs.find(
      (t) => t.workspaceId === workspaceId && t.type === 'diff'
    )
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    get().addTab({
      id: crypto.randomUUID(),
      workspaceId,
      type: 'diff',
    })
  },

  hydrateState: (data) => {
    const workspaces = data.workspaces ?? []
    const saved = data.activeWorkspaceId
    const settings = data.settings ? { ...DEFAULT_SETTINGS, ...data.settings } : { ...DEFAULT_SETTINGS }
    const activeWorkspaceId = settings.restoreWorkspace
      ? ((saved && workspaces.some((w) => w.id === saved) ? saved : workspaces[0]?.id) ?? null)
      : null
    // Tabs will be reconciled with live PTYs asynchronously after set.
    // Normalize split trees from old persisted state (leaves without contentType).
    const rawTabs = data.tabs ?? []
    const tabs = rawTabs.map((tab) => {
      if (tab.type === 'terminal' && tab.splitRoot) {
        return { ...tab, splitRoot: normalizeSplitTree(tab.splitRoot) }
      }
      return tab
    })
    const activeTabId = data.activeTabId ?? null
    set({
      projects: data.projects ?? [],
      workspaces,
      tabs,
      automations: data.automations ?? [],
      activeWorkspaceId,
      activeTabId,
      lastActiveTabByWorkspace: data.lastActiveTabByWorkspace ?? {},
      settings,
    })
  },

  activeWorkspaceTabs: () => {
    const s = get()
    return s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
  },

  activeProject: () => {
    const s = get()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    return ws ? s.projects.find((p) => p.id === ws.projectId) : undefined
  },
}))

// ── State persistence ──

function getPersistedSlice(state: AppState): PersistedState {
  return {
    projects: state.projects,
    workspaces: state.workspaces,
    tabs: state.tabs,
    automations: state.automations,
    activeWorkspaceId: state.activeWorkspaceId,
    activeTabId: state.activeTabId,
    lastActiveTabByWorkspace: state.lastActiveTabByWorkspace,
    settings: state.settings,
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function debouncedSave(state: AppState) {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    window.api.state.save(getPersistedSlice(state))
  }, 500)
}

// Subscribe to store changes and debounce-save persisted slice
useAppStore.subscribe((state, prevState) => {
  if (
    state.projects !== prevState.projects ||
    state.workspaces !== prevState.workspaces ||
    state.tabs !== prevState.tabs ||
    state.activeTabId !== prevState.activeTabId ||
    state.automations !== prevState.automations ||
    state.activeWorkspaceId !== prevState.activeWorkspaceId ||
    state.settings !== prevState.settings
  ) {
    debouncedSave(state)
  }
})

// Flush state to disk synchronously when the window is closing.
// Uses sendSync + writeFileSync so the write completes before the renderer is destroyed.
window.addEventListener('beforeunload', () => {
  if (saveTimer) clearTimeout(saveTimer)
  window.api.state.saveSync(getPersistedSlice(useAppStore.getState()))
})

// Load persisted state on startup
export async function hydrateFromDisk(): Promise<void> {
  try {
    const data = await window.api.state.load()
    if (data) {
      useAppStore.getState().hydrateState(data)
    }
  } catch (err) {
    console.error('Failed to load persisted state:', err)
  }

  // Reconcile persisted terminal tabs against live PTY processes
  try {
    const livePtyIds = new Set(await window.api.pty.list())
    const store = useAppStore.getState()
    const tabs = store.tabs

    if (tabs.length > 0 && livePtyIds.size > 0) {
      // Reattach surviving terminal tabs to the new webContents
      const reattachPromises: Promise<boolean>[] = []
      for (const tab of tabs) {
        if (tab.type === 'terminal') {
          // Reattach primary PTY
          if (livePtyIds.has(tab.ptyId)) {
            reattachPromises.push(window.api.pty.reattach(tab.ptyId))
          }
          // Reattach split pane PTYs
          if (tab.splitRoot) {
            for (const splitPtyId of getAllPtyIds(tab.splitRoot)) {
              if (splitPtyId !== tab.ptyId && livePtyIds.has(splitPtyId)) {
                reattachPromises.push(window.api.pty.reattach(splitPtyId))
              }
            }
          }
        }
      }
      await Promise.all(reattachPromises)
    }

    // Respawn PTYs for terminal tabs whose primary process is no longer alive.
    // For simplicity, split panes are collapsed on restart — only the primary PTY is respawned.
    const deadTabs = tabs.filter(
      (t): t is Extract<Tab, { type: 'terminal' }> =>
        t.type === 'terminal' && !livePtyIds.has(t.ptyId)
    )
    if (deadTabs.length > 0) {
      const shell = store.settings.defaultShell || undefined
      const updatedTabs = [...tabs]
      for (const dead of deadTabs) {
        const ws = store.workspaces.find((w) => w.id === dead.workspaceId)
        if (!ws) continue
        try {
          const newPtyId = await window.api.pty.create(ws.worktreePath, shell, { AGENT_ORCH_WS_ID: ws.id })
          const idx = updatedTabs.findIndex((t) => t.id === dead.id)
          // Collapse splits on respawn — start fresh with a single terminal
          if (idx !== -1) updatedTabs[idx] = { ...dead, ptyId: newPtyId, splitRoot: undefined, focusedPaneId: undefined }
        } catch {
          // If respawn fails, drop the tab
          const idx = updatedTabs.findIndex((t) => t.id === dead.id)
          if (idx !== -1) updatedTabs.splice(idx, 1)
        }
      }
      // Drop any terminal tabs whose workspace no longer exists
      const finalTabs = updatedTabs.filter(
        (t) => t.type !== 'terminal' || store.workspaces.some((w) => w.id === t.workspaceId)
      )
      const activeTabId = finalTabs.find((t) => t.id === store.activeTabId)
        ? store.activeTabId
        : (finalTabs.find((t) => t.workspaceId === store.activeWorkspaceId)?.id ?? null)
      useAppStore.setState({ tabs: finalTabs, activeTabId })
    }
  } catch (err) {
    console.error('Failed to reconcile PTY tabs:', err)
  }

  // Schedule all enabled automations on startup
  const state = useAppStore.getState()
  for (const automation of state.automations) {
    if (!automation.enabled) continue
    const project = state.projects.find((p) => p.id === automation.projectId)
    if (!project) continue
    window.api.automations.create({
      ...automation,
      repoPath: project.repoPath,
    })
  }

  // Listen for automation run-started events from main process
  window.api.automations.onRunStarted((data) => {
    const store = useAppStore.getState()
    const { automationId, automationName, projectId, ptyId, worktreePath, branch } = data
    const project = store.projects.find((p) => p.id === projectId)
    if (!project) return

    // Create workspace for the run
    const now = new Date()
    const timestamp = now.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric',
    }) + ' ' + now.toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit',
    })
    const wsId = crypto.randomUUID()
    store.addWorkspace({
      id: wsId,
      name: `${automationName} · ${timestamp}`,
      branch: branch || '',
      worktreePath: worktreePath || project.repoPath,
      projectId,
      automationId,
    })

    // Create terminal tab for the run
    store.addTab({
      id: crypto.randomUUID(),
      workspaceId: wsId,
      type: 'terminal',
      title: automationName,
      ptyId,
    })

    // Update automation lastRunAt
    store.updateAutomation(automationId, { lastRunAt: Date.now() })
  })
}
