import { create } from 'zustand'
import type { AppState, PersistedState, Tab } from './types'
import { DEFAULT_SETTINGS } from './types'

const DEFAULT_PR_LINK_PROVIDER = 'github' as const

function getOrderedWorkspaces(state: Pick<AppState, 'projects' | 'workspaces'>) {
  return state.projects.flatMap((project) =>
    state.workspaces.filter((workspace) => workspace.projectId === project.id),
  )
}

function getVisibleOrderedWorkspaces(state: Pick<AppState, 'projects' | 'workspaces' | 'collapsedProjectIds'>) {
  return state.projects.flatMap((project) => {
    if (state.collapsedProjectIds.has(project.id)) return []
    return state.workspaces.filter((workspace) => workspace.projectId === project.id)
  })
}

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
  collapsedProjectIds: new Set(),

  addProject: (project) =>
    set((s) => ({
      projects: [
        ...s.projects,
        {
          ...project,
          prLinkProvider: project.prLinkProvider ?? DEFAULT_PR_LINK_PROVIDER,
        },
      ],
    })),

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
      const newCollapsedProjects = new Set(s.collapsedProjectIds)
      newCollapsedProjects.delete(id)

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
        collapsedProjectIds: newCollapsedProjects,
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
    const ptyId = await window.api.pty.create(
      ws.worktreePath,
      shell,
      { AGENT_ORCH_WS_ID: ws.id },
      s.settings.useLoginShell,
    )
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
      window.api.pty.destroy(tab.ptyId)
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
    const ordered = getOrderedWorkspaces(s)
    if (ordered.length <= 1) return
    const idx = ordered.findIndex((w) => w.id === s.activeWorkspaceId)
    const next = ordered[(idx + 1) % ordered.length]
    get().setActiveWorkspace(next.id)
  },

  prevWorkspace: () => {
    const s = get()
    if (s.workspaces.length <= 1) return
    const ordered = getOrderedWorkspaces(s)
    if (ordered.length <= 1) return
    const idx = ordered.findIndex((w) => w.id === s.activeWorkspaceId)
    const prev = ordered[(idx - 1 + ordered.length) % ordered.length]
    get().setActiveWorkspace(prev.id)
  },

  switchToWorkspaceByIndex: (index) => {
    const s = get()
    const ordered = getVisibleOrderedWorkspaces(s)
    if (index < 0 || index >= ordered.length) return
    get().setActiveWorkspace(ordered[index].id)
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
      if (t.type === 'terminal') window.api.pty.destroy(t.ptyId)
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

  openWorkspaceDialog: (projectId) => set({ workspaceDialogProjectId: projectId }),

  deleteWorkspace: async (workspaceId) => {
    const s = get()
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return
    const project = s.projects.find((p) => p.id === ws.projectId)

    // Destroy PTYs for this workspace
    s.tabs.filter((t) => t.workspaceId === workspaceId && t.type === 'terminal').forEach((t) => {
      if (t.type === 'terminal') window.api.pty.destroy(t.ptyId)
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
        if (t.type === 'terminal') window.api.pty.destroy(t.ptyId)
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

  toggleProjectCollapsed: (projectId) =>
    set((s) => {
      const next = new Set(s.collapsedProjectIds)
      if (next.has(projectId)) next.delete(projectId)
      else next.add(projectId)
      return { collapsedProjectIds: next }
    }),

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
    const projects = (data.projects ?? []).map((project) => ({
      ...project,
      prLinkProvider: project.prLinkProvider ?? DEFAULT_PR_LINK_PROVIDER,
    }))
    const workspaces = data.workspaces ?? []
    const saved = data.activeWorkspaceId
    const settings = data.settings ? { ...DEFAULT_SETTINGS, ...data.settings } : { ...DEFAULT_SETTINGS }
    const activeWorkspaceId = settings.restoreWorkspace
      ? ((saved && workspaces.some((w) => w.id === saved) ? saved : workspaces[0]?.id) ?? null)
      : null
    // Tabs will be reconciled with live PTYs asynchronously after set
    const tabs = data.tabs ?? []
    const activeTabId = data.activeTabId ?? null
    set({
      projects,
      workspaces,
      tabs,
      automations: data.automations ?? [],
      activeWorkspaceId,
      activeTabId,
      lastActiveTabByWorkspace: data.lastActiveTabByWorkspace ?? {},
      settings,
      collapsedProjectIds: new Set(),
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

  try {
    await window.api.app.setZoomFactor(useAppStore.getState().settings.uiZoomFactor)
  } catch (err) {
    console.error('Failed to apply persisted UI zoom factor:', err)
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
        if (tab.type === 'terminal' && livePtyIds.has(tab.ptyId)) {
          reattachPromises.push(window.api.pty.reattach(tab.ptyId))
        }
      }
      await Promise.all(reattachPromises)
    }

    // Respawn PTYs for terminal tabs whose process is no longer alive
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
          const newPtyId = await window.api.pty.create(
            ws.worktreePath,
            shell,
            { AGENT_ORCH_WS_ID: ws.id },
            store.settings.useLoginShell,
          )
          const idx = updatedTabs.findIndex((t) => t.id === dead.id)
          if (idx !== -1) updatedTabs[idx] = { ...dead, ptyId: newPtyId }
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
