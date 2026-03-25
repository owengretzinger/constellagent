import { create } from 'zustand'
import type {
  AppState,
  ChatSnippet,
  PersistedState,
  Project,
  StartupCommand,
  Tab,
  SplitNode,
  Workspace,
} from './types'
import { DEFAULT_SETTINGS } from './types'
import { AGENT_PLAN_DIRS_LABEL } from '../utils/agent-plan-dirs'
import { GEMINI_TAB_LABEL, isGeminiIdleOscTitle } from '../../shared/gemini-tab-title'
import {
  getAllPtyIds,
  splitLeaf,
  removeLeaf,
  findLeaf,
  findLeafByPtyId,
  firstLeaf,
  firstTerminalLeaf,
  collectLeaves,
  normalizeSplitTree,
  getFocusedPtyId,
  resolvePtyForPlanSourceFilePath,
  graftTree,
} from './split-helpers'
import { formatChatContext } from '../utils/chat-context-formatter'
import { wrapBracketedPaste } from '../utils/bracketed-paste'
import { pathsEqualOrAlias } from '../../shared/agent-plan-path'

const DEFAULT_PR_LINK_PROVIDER = 'github' as const

/** Strip unknown persisted fields (e.g. legacy waitFor / waitCondition). */
function normalizeHydratedStartupCommands(raw: Project['startupCommands']): StartupCommand[] | undefined {
  if (!raw?.length) return undefined
  const out: StartupCommand[] = []
  for (const c of raw) {
    const command = typeof c.command === 'string' ? c.command : ''
    if (!command.trim()) continue
    out.push({ name: typeof c.name === 'string' ? c.name : '', command })
  }
  return out.length > 0 ? out : undefined
}

const TAB_TITLE_LOG = '[constellagent:tab-title]'

const AGENT_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor Agent',
}

const GENERIC_AGENT_TITLES = new Set(Object.values(AGENT_NAMES))

function terminalTabHasPtyId(tab: Tab, ptyId: string): tab is Extract<Tab, { type: 'terminal' }> {
  if (tab.type !== 'terminal') return false
  if (tab.ptyId === ptyId) return true
  return tab.splitRoot ? findLeafByPtyId(tab.splitRoot, ptyId) != null : false
}

function isGenericTerminalTitle(title: string): boolean {
  if (!title.trim()) return true
  if (GENERIC_AGENT_TITLES.has(title)) return true
  return /^Terminal \d+$/.test(title)
}

function activeAgentSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const id of a) {
    if (!b.has(id)) return false
  }
  return true
}

/** Drop plan→terminal entries when the terminal tab no longer exists (e.g. bulk tab removal). */
function planBuildMapForTabs(map: Record<string, string>, tabs: Tab[]): Record<string, string> {
  const terminalIds = new Set(
    tabs.filter((t): t is Extract<Tab, { type: 'terminal' }> => t.type === 'terminal').map((t) => t.id),
  )
  const next: Record<string, string> = {}
  for (const [path, tabId] of Object.entries(map)) {
    if (terminalIds.has(tabId)) next[path] = tabId
  }
  return next
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
  contextHistoryOpen: false,
  confirmDialog: null,
  toasts: [],
  quickOpenVisible: false,
  planPaletteVisible: false,
  unreadWorkspaceIds: new Set<string>(),
  activeClaudeWorkspaceIds: new Set<string>(),
  prStatusMap: new Map(),
  ghAvailability: new Map(),
  gitFileStatuses: new Map(),
  worktreeSyncStatus: new Map(),
  lastKnownRemoteHead: {},
  activeMonacoEditor: null,
  planBuildTerminalByPlanPath: {},

  addProject: (project) => {
    set((s) => ({
      projects: [
        ...s.projects,
        {
          ...project,
          prLinkProvider: project.prLinkProvider ?? DEFAULT_PR_LINK_PROVIDER,
        },
      ],
    }))
    void window.api.git.startSyncPolling(project.id, project.repoPath)
    void reconcileGitWorktreesForStore(project.id)
  },

  removeProject: (id) => {
    void window.api.git.stopSyncPolling(id)
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
      const planBuildTerminalByPlanPath = planBuildMapForTabs(s.planBuildTerminalByPlanPath, newTabs)
      const newAutomations = s.automations.filter((a) => a.projectId !== id)
      const newUnread = new Set(Array.from(s.unreadWorkspaceIds).filter((wsId) => !removedWsIds.has(wsId)))
      const newActiveClaude = new Set(Array.from(s.activeClaudeWorkspaceIds).filter((wsId) => !removedWsIds.has(wsId)))
      const newPrStatusMap = new Map(
        Array.from(s.prStatusMap.entries()).filter(([key]) => !key.startsWith(`${id}:`))
      )
      const newGhAvailability = new Map(s.ghAvailability)
      newGhAvailability.delete(id)

      const newWorktreeSyncStatus = new Map(s.worktreeSyncStatus)
      for (const ws of s.workspaces.filter((w) => w.projectId === id)) {
        newWorktreeSyncStatus.delete(ws.id)
      }

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
        worktreeSyncStatus: newWorktreeSyncStatus,
        activeWorkspaceId,
        activeTabId,
        lastActiveTabByWorkspace: tabMap,
        planBuildTerminalByPlanPath,
      }
    })
  },

  addWorkspace: (workspace) =>
    set((s) => ({
      workspaces: [...s.workspaces, workspace],
      activeWorkspaceId: workspace.id,
    })),

  removeWorkspace: (id) =>
    set((s) => {
      const newWorkspaces = s.workspaces.filter((w) => w.id !== id)
      const newTabs = s.tabs.filter((t) => t.workspaceId !== id)
      const planBuildTerminalByPlanPath = planBuildMapForTabs(s.planBuildTerminalByPlanPath, newTabs)
      const newUnread = new Set(s.unreadWorkspaceIds)
      newUnread.delete(id)
      const newActiveClaude = new Set(s.activeClaudeWorkspaceIds)
      newActiveClaude.delete(id)
      const tabMap = { ...s.lastActiveTabByWorkspace }
      delete tabMap[id]
      const newWorktreeSyncStatus = new Map(s.worktreeSyncStatus)
      newWorktreeSyncStatus.delete(id)
      return {
        workspaces: newWorkspaces,
        tabs: newTabs,
        unreadWorkspaceIds: newUnread,
        activeClaudeWorkspaceIds: newActiveClaude,
        worktreeSyncStatus: newWorktreeSyncStatus,
        lastActiveTabByWorkspace: tabMap,
        planBuildTerminalByPlanPath,
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
      const removed = s.tabs.find((t) => t.id === id)
      let planBuildTerminalByPlanPath = s.planBuildTerminalByPlanPath
      if (removed?.type === 'terminal') {
        const next = { ...planBuildTerminalByPlanPath }
        for (const k of Object.keys(next)) {
          if (next[k] === id) delete next[k]
        }
        planBuildTerminalByPlanPath = next
      }
      const newTabs = s.tabs.filter((t) => t.id !== id)
      const wasActive = s.activeTabId === id
      const wsTabs = newTabs.filter((t) => t.workspaceId === s.activeWorkspaceId)
      return {
        tabs: newTabs,
        activeTabId: wasActive ? (wsTabs[wsTabs.length - 1]?.id ?? null) : s.activeTabId,
        planBuildTerminalByPlanPath,
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

  launchAgentTerminalWithCommand: async (opts) => {
    const { workspaceId, worktreePath, title, command, agentType } = opts

    if (agentType === 'claude-code') {
      await window.api.claude.trustPath(worktreePath).catch(() => {})
    }

    const shell = get().settings.defaultShell || undefined
    const ptyId = await window.api.pty.create(worktreePath, shell, {
      AGENT_ORCH_WS_ID: workspaceId,
      AGENT_ORCH_AGENT_TYPE: agentType,
    })

    const tabId = crypto.randomUUID()
    get().addTab({
      id: tabId,
      workspaceId,
      type: 'terminal',
      title,
      ptyId,
      agentType,
    })

    setTimeout(() => {
      window.api.pty.write(ptyId, command + '\n')
    }, 500)

    return tabId
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

  openMarkdownPreview: (filePath) => {
    const s = get()
    if (!s.activeWorkspaceId) return
    const existing = s.tabs.find(
      (t) => t.workspaceId === s.activeWorkspaceId && t.type === 'markdownPreview' && t.filePath === filePath
    )
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }
    const title = filePath.split('/').pop() || 'Preview'
    get().addTab({
      id: crypto.randomUUID(),
      workspaceId: s.activeWorkspaceId,
      type: 'markdownPreview',
      filePath,
      title,
    })
  },

  retargetMarkdownPreviewTab: (tabId, newFilePath) => {
    const title = newFilePath.split('/').pop() || 'Preview'
    set((s) => {
      const old = s.tabs.find((t) => t.id === tabId && t.type === 'markdownPreview')
      let planBuildTerminalByPlanPath = s.planBuildTerminalByPlanPath
      if (old && old.type === 'markdownPreview' && old.filePath !== newFilePath) {
        const terminalTabId = planBuildTerminalByPlanPath[old.filePath]
        if (terminalTabId !== undefined) {
          planBuildTerminalByPlanPath = { ...planBuildTerminalByPlanPath }
          delete planBuildTerminalByPlanPath[old.filePath]
          planBuildTerminalByPlanPath[newFilePath] = terminalTabId
        }
      }
      return {
        planBuildTerminalByPlanPath,
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.type === 'markdownPreview'
            ? { ...t, filePath: newFilePath, title }
            : t
        ),
      }
    })
  },

  setPlanBuildTerminalForPlan: (planPath, terminalTabId) =>
    set((s) => ({
      planBuildTerminalByPlanPath: { ...s.planBuildTerminalByPlanPath, [planPath]: terminalTabId },
    })),

  openLatestAgentPlan: async () => {
    const s = get()
    const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId)
    if (!ws) {
      s.addToast({
        id: crypto.randomUUID(),
        message: 'Select a workspace first',
        type: 'info',
      })
      return
    }
    try {
      const path = await window.api.fs.findNewestPlanMarkdown(ws.worktreePath)
      if (!path) {
        s.addToast({
          id: crypto.randomUUID(),
          message: `No plan files found. Expected .md/.mdx under ${AGENT_PLAN_DIRS_LABEL} in the workspace, or the same folders under your home directory (e.g. ~/.claude/plans).`,
          type: 'info',
        })
        return
      }
      get().openMarkdownPreview(path)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('No handler registered')) {
        s.addToast({
          id: crypto.randomUUID(),
          message:
            'Main process is out of date. Quit Constellagent (⌘Q) and run `bun run dev` again — Reload (⌘R) only updates the UI, not IPC handlers.',
          type: 'error',
        })
        return
      }
      s.addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
    }
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
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.workspaceId !== wsId)
      return {
        tabs: newTabs,
        activeTabId: null,
        planBuildTerminalByPlanPath: planBuildMapForTabs(state.planBuildTerminalByPlanPath, newTabs),
      }
    })
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

  cycleFocusedPane: () => {
    const s = get()
    if (!s.activeTabId) return
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    if (!tab || tab.type !== 'terminal' || !tab.splitRoot) return
    const leaves = collectLeaves(tab.splitRoot)
    if (leaves.length <= 1) return
    const idx = leaves.findIndex((l) => l.id === tab.focusedPaneId)
    const next = leaves[(idx + 1) % leaves.length]
    get().setFocusedPane(tab.id, next.id)
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

  mergeTabIntoSplit: (sourceTabId, targetTabId, direction = 'horizontal') => {
    const s = get()
    if (sourceTabId === targetTabId) return

    const sourceTab = s.tabs.find((t) => t.id === sourceTabId)
    const targetTab = s.tabs.find((t) => t.id === targetTabId)
    if (!sourceTab || !targetTab) return
    if (sourceTab.type !== 'terminal' || targetTab.type !== 'terminal') return
    if (sourceTab.workspaceId !== targetTab.workspaceId) return

    // Build source subtree: use existing splitRoot or synthesize a single leaf
    const sourceTree: SplitNode = sourceTab.splitRoot ?? {
      type: 'leaf' as const,
      id: crypto.randomUUID(),
      contentType: 'terminal' as const,
      ptyId: sourceTab.ptyId,
    }

    // Build target tree: use existing splitRoot or synthesize a single leaf
    const targetTree: SplitNode = targetTab.splitRoot ?? {
      type: 'leaf' as const,
      id: crypto.randomUUID(),
      contentType: 'terminal' as const,
      ptyId: targetTab.ptyId,
    }

    // Graft source into target
    const newRoot = graftTree(targetTree, sourceTree, direction)

    // Find first leaf of source tree for focus
    const focusedPaneId = firstLeaf(sourceTree).id

    // Remap planBuildTerminalByPlanPath entries pointing to source → target
    const newPlanMap = { ...s.planBuildTerminalByPlanPath }
    for (const [path, tabId] of Object.entries(newPlanMap)) {
      if (tabId === sourceTabId) newPlanMap[path] = targetTabId
    }

    set((state) => ({
      tabs: state.tabs
        .filter((t) => t.id !== sourceTabId) // remove source tab (no PTY destruction)
        .map((t) =>
          t.id === targetTabId && t.type === 'terminal'
            ? { ...t, splitRoot: newRoot, focusedPaneId }
            : t
        ),
      activeTabId: state.activeTabId === sourceTabId ? targetTabId : state.activeTabId,
      planBuildTerminalByPlanPath: newPlanMap,
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

  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, automationsOpen: false, contextHistoryOpen: false })),
  toggleAutomations: () => set((s) => ({ automationsOpen: !s.automationsOpen, settingsOpen: false, contextHistoryOpen: false })),
  toggleContextHistory: () => set((s) => ({ contextHistoryOpen: !s.contextHistoryOpen, settingsOpen: false, automationsOpen: false })),
  closeContextHistory: () => set({ contextHistoryOpen: false }),

  showConfirmDialog: (dialog) => set({ confirmDialog: dialog }),

  updateConfirmDialog: (partial) => set((s) => ({
    confirmDialog: s.confirmDialog ? { ...s.confirmDialog, ...partial } : null,
  })),

  dismissConfirmDialog: () => set({ confirmDialog: null }),

  addToast: (toast) =>
    set((s) => ({ toasts: [...s.toasts, toast] })),

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  toggleQuickOpen: () => set((s) => ({ quickOpenVisible: !s.quickOpenVisible, planPaletteVisible: false })),
  closeQuickOpen: () => set({ quickOpenVisible: false }),
  togglePlanPalette: () => set((s) => ({ planPaletteVisible: !s.planPaletteVisible, quickOpenVisible: false })),
  closePlanPalette: () => set({ planPaletteVisible: false }),

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

  setActiveAgentWorkspaces: (entries) =>
    set((s) => {
      // Only drive sidebar "active" dots — never infer per-tab agent type from workspace-level
      // markers (same workspace can run Claude + Codex + others; that mis-titled the wrong tab).
      const newIds = new Set(entries.map((e) => e.wsId))
      const existing = s.activeClaudeWorkspaceIds
      if (newIds.size === existing.size) {
        let same = true
        for (const id of newIds) {
          if (!existing.has(id)) { same = false; break }
        }
        if (same) return {}
      }
      return { activeClaudeWorkspaceIds: newIds }
    }),

  setTerminalAgentType: (ptyId, agentType) =>
    set((s) => {
      let changed = false
      const tabs = s.tabs.map((tab) => {
        if (!terminalTabHasPtyId(tab, ptyId)) return tab
        if (tab.agentType === agentType) return tab
        changed = true
        const useAgentLabel =
          isGenericTerminalTitle(tab.title)
          || (agentType === 'gemini' && isGeminiIdleOscTitle(tab.title))
        const nextTitle = useAgentLabel ? (AGENT_NAMES[agentType] ?? tab.title) : tab.title
        return { ...tab, agentType, title: nextTitle }
      })
      if (changed) {
        console.log(TAB_TITLE_LOG, 'renderer setTerminalAgentType', { ptyId, agentType })
      }
      return changed ? { tabs } : {}
    }),

  updateTerminalTitle: (ptyId, title) =>
    set((s) => {
      let changed = false
      const tabs = s.tabs.map((tab) => {
        if (!terminalTabHasPtyId(tab, ptyId)) return tab
        const nextTitle =
          tab.agentType === 'gemini' && isGeminiIdleOscTitle(title)
            ? GEMINI_TAB_LABEL
            : title
        if (tab.title === nextTitle) return tab
        changed = true
        return { ...tab, title: nextTitle }
      })
      if (!changed) return {}
      console.log(TAB_TITLE_LOG, 'renderer updateTerminalTitle', { ptyId, title: title.slice(0, 80) })
      return { tabs }
    }),

  applyCodexContextTitleHint: (workspaceId, title) =>
    set((s) => {
      let updated = 0
      let skippedNonGeneric = 0
      const tabs = s.tabs.map((tab) => {
        if (tab.type !== 'terminal' || tab.workspaceId !== workspaceId || tab.agentType !== 'codex') return tab
        if (!isGenericTerminalTitle(tab.title)) {
          skippedNonGeneric++
          return tab
        }
        if (tab.title === title) return tab
        updated++
        return { ...tab, title }
      })
      if (updated === 0) return {}
      console.log(TAB_TITLE_LOG, 'renderer applyCodexContextTitleHint', {
        workspaceId,
        title: title.slice(0, 80),
        tabsUpdated: updated,
        skippedNonGeneric,
      })
      return { tabs }
    }),

  setActiveMonacoEditor: (editor) => set({ activeMonacoEditor: editor }),

  getFirstAgentTerminalPtyId: () => {
    const s = get()
    const wsTabs = s.tabs.filter((t) => t.workspaceId === s.activeWorkspaceId)

    // Prefer the active tab if it's an agent terminal
    const activeTab = wsTabs.find((t) => t.id === s.activeTabId)
    if (activeTab?.type === 'terminal' && activeTab.agentType) {
      const ptyId = activeTab.focusedPaneId && activeTab.splitRoot
        ? getFocusedPtyId(activeTab.splitRoot, activeTab.focusedPaneId, activeTab.ptyId)
        : activeTab.ptyId
      return ptyId
    }

    // Fall back to first agent terminal tab
    const agentTab = wsTabs.find((t): t is Extract<Tab, { type: 'terminal' }> =>
      t.type === 'terminal' && !!t.agentType
    )
    if (agentTab) {
      return agentTab.ptyId
    }

    return undefined
  },

  sendContextToAgent: (snippets: ChatSnippet[]) => {
    const s = get()
    const sourcePath = snippets.find((x) => x.filePath)?.filePath
    const ptyId =
      resolvePtyForPlanSourceFilePath(
        sourcePath,
        s.planBuildTerminalByPlanPath,
        s.tabs,
        s.activeWorkspaceId,
      ) ?? s.getFirstAgentTerminalPtyId()
    if (!ptyId) {
      s.addToast({
        id: `no-agent-${Date.now()}`,
        message: 'No agent terminal found in this workspace',
        type: 'error',
      })
      return
    }

    // Format and send via bracketed paste
    const text = formatChatContext(snippets)
    window.api.pty.write(ptyId, wrapBracketedPaste(text))

    // Switch to the agent terminal tab
    const tab = s.tabs.find((t) =>
      t.type === 'terminal' && (t.ptyId === ptyId || (t.splitRoot && findLeafByPtyId(t.splitRoot, ptyId) != null))
    )
    if (tab) set({ activeTabId: tab.id })
  },

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

  setLastKnownRemoteHead: (projectId, hash) =>
    set((s) => ({
      lastKnownRemoteHead: { ...s.lastKnownRemoteHead, [projectId]: hash },
    })),

  setPrStatuses: (projectId, statuses) =>
    set((s) => {
      let changed = false
      const newMap = new Map(s.prStatusMap)
      for (const [branch, info] of Object.entries(statuses)) {
        const key = `${projectId}:${branch}`
        const prev = newMap.get(key)
        if (!prev || !info || prev.number !== info.number || prev.state !== info.state
          || prev.title !== info.title || prev.url !== info.url
          || prev.checkStatus !== info.checkStatus
          || prev.hasPendingComments !== info.hasPendingComments
          || prev.pendingCommentCount !== info.pendingCommentCount
          || prev.isBlockedByCi !== info.isBlockedByCi
          || prev.isApproved !== info.isApproved
          || prev.isChangesRequested !== info.isChangesRequested
          || prev.updatedAt !== info.updatedAt) {
          newMap.set(key, info)
          changed = true
        }
      }
      return changed ? { prStatusMap: newMap } : {}
    }),

  setGhAvailability: (projectId, available) =>
    set((s) => {
      if (s.ghAvailability.get(projectId) === available) return {}
      const newMap = new Map(s.ghAvailability)
      newMap.set(projectId, available)
      return { ghAvailability: newMap }
    }),

  setWorktreeSyncStatus: (projectId, workspaces) =>
    set((s) => {
      const next = new Map(s.worktreeSyncStatus)
      for (const [pathKey, info] of Object.entries(workspaces)) {
        const ws = s.workspaces.find(
          (w) =>
            w.projectId === projectId &&
            (pathsEqualOrAlias(w.worktreePath, info.workspacePath) ||
              pathsEqualOrAlias(w.worktreePath, pathKey)),
        )
        if (ws) next.set(ws.id, info)
      }
      return { worktreeSyncStatus: next }
    }),

  addAutomation: (automation) =>
    set((s) => ({ automations: [...s.automations, automation] })),

  updateAutomation: (id, partial) =>
    set((s) => ({
      automations: s.automations.map((a) => (a.id === id ? { ...a, ...partial } : a)),
    })),

  removeAutomation: (id) =>
    set((s) => ({ automations: s.automations.filter((a) => a.id !== id) })),

  addSkill: (skill) =>
    set((s) => ({ settings: { ...s.settings, skills: [...s.settings.skills, skill] } })),
  removeSkill: (id) =>
    set((s) => ({ settings: { ...s.settings, skills: s.settings.skills.filter((sk) => sk.id !== id) } })),
  updateSkill: (id, partial) =>
    set((s) => ({ settings: { ...s.settings, skills: s.settings.skills.map((sk) => sk.id === id ? { ...sk, ...partial } : sk) } })),
  addSubagent: (subagent) =>
    set((s) => ({ settings: { ...s.settings, subagents: [...s.settings.subagents, subagent] } })),
  removeSubagent: (id) =>
    set((s) => ({ settings: { ...s.settings, subagents: s.settings.subagents.filter((sa) => sa.id !== id) } })),
  updateSubagent: (id, partial) =>
    set((s) => ({ settings: { ...s.settings, subagents: s.settings.subagents.map((sa) => sa.id === id ? { ...sa, ...partial } : sa) } })),

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

  openCommitDiffTab: (workspaceId, hash, message) => {
    const s = get()
    // Reuse existing commit-diff tab for this workspace (one with commitHash set)
    const existing = s.tabs.find(
      (t) => t.workspaceId === workspaceId && t.type === 'diff' && t.commitHash
    )
    if (existing) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === existing.id && t.type === 'diff'
            ? { ...t, commitHash: hash, commitMessage: message }
            : t
        ),
        activeTabId: existing.id,
      }))
      return
    }
    get().addTab({
      id: crypto.randomUUID(),
      workspaceId,
      type: 'diff',
      commitHash: hash,
      commitMessage: message,
    })
  },

  hydrateState: (data) => {
    const projects = (data.projects ?? []).map((project) => ({
      ...project,
      prLinkProvider: project.prLinkProvider ?? DEFAULT_PR_LINK_PROVIDER,
      startupCommands: normalizeHydratedStartupCommands(project.startupCommands),
    }))
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
      projects,
      workspaces,
      tabs,
      automations: data.automations ?? [],
      activeWorkspaceId,
      activeTabId,
      lastActiveTabByWorkspace: data.lastActiveTabByWorkspace ?? {},
      settings,
      worktreeSyncStatus: new Map(),
      lastKnownRemoteHead: {},
      activeMonacoEditor: null,
      planBuildTerminalByPlanPath: {},
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

/** Detached git checkouts report as branch `HEAD`; they are not useful sidebar rows. */
function isDetachedHeadBranchLabel(branch: string): boolean {
  return branch.trim().toUpperCase() === 'HEAD'
}

/** Drop workspaces that only represent detached HEAD (from older reconcile / git state). */
function pruneDetachedHeadWorkspaces(): void {
  useAppStore.setState((s) => {
    const removeIds = new Set(
      s.workspaces.filter((w) => isDetachedHeadBranchLabel(w.branch)).map((w) => w.id),
    )
    if (removeIds.size === 0) return s

    const newWorkspaces = s.workspaces.filter((w) => !removeIds.has(w.id))
    const newTabs = s.tabs.filter((t) => !removeIds.has(t.workspaceId))
    const tabMap = { ...s.lastActiveTabByWorkspace }
    for (const id of removeIds) delete tabMap[id]

    let activeWorkspaceId = s.activeWorkspaceId
    if (activeWorkspaceId && removeIds.has(activeWorkspaceId)) {
      activeWorkspaceId = newWorkspaces[0]?.id ?? null
    }
    const activeTabId = newTabs.some((t) => t.id === s.activeTabId)
      ? s.activeTabId
      : (newTabs.find((t) => t.workspaceId === activeWorkspaceId)?.id ?? newTabs[0]?.id ?? null)

    return {
      workspaces: newWorkspaces,
      tabs: newTabs,
      activeWorkspaceId,
      activeTabId,
      lastActiveTabByWorkspace: tabMap,
      planBuildTerminalByPlanPath: planBuildMapForTabs(s.planBuildTerminalByPlanPath, newTabs),
    }
  })
}

/**
 * Merge git worktrees from `git worktree list` into the store when they are missing from persisted state.
 * The sidebar only renders app workspaces — it does not scan git by itself.
 */
async function reconcileGitWorktreesForStore(projectIdFilter: string | null): Promise<void> {
  pruneDetachedHeadWorkspaces()

  const projects =
    projectIdFilter === null
      ? useAppStore.getState().projects
      : useAppStore.getState().projects.filter((p) => p.id === projectIdFilter)
  if (projects.length === 0) return

  const additions: Workspace[] = []

  for (const project of projects) {
    let listed: { path: string; branch: string; head: string; isBare: boolean; isDetached?: boolean }[]
    try {
      listed = await window.api.git.listWorktrees(project.repoPath)
    } catch {
      continue
    }

    const workspacesSnap = useAppStore.getState().workspaces
    const currentForProject = workspacesSnap.filter((w) => w.projectId === project.id)

    for (const wt of listed) {
      if (wt.isBare) continue
      if (wt.isDetached) continue
      const path = wt.path?.trim()
      if (!path) continue
      if (currentForProject.some((w) => pathsEqualOrAlias(w.worktreePath, path))) continue
      if (additions.some((w) => w.projectId === project.id && pathsEqualOrAlias(w.worktreePath, path))) continue

      let branch = (wt.branch || '').trim()
      if (!branch) {
        try {
          branch = (await window.api.git.getCurrentBranch(path)).trim()
        } catch {
          branch = ''
        }
      }
      if (isDetachedHeadBranchLabel(branch)) continue

      const fallbackName = path.split(/[/\\]/).filter(Boolean).pop() || 'workspace'
      const name = branch || fallbackName
      additions.push({
        id: crypto.randomUUID(),
        name,
        branch,
        worktreePath: path,
        projectId: project.id,
      })
    }
  }

  if (additions.length === 0) return

  console.info(`[constellagent] merged ${additions.length} git worktree(s) into sidebar state`)

  useAppStore.setState((s) => {
    const nextWorkspaces = [...s.workspaces, ...additions]
    let activeWorkspaceId = s.activeWorkspaceId
    if (activeWorkspaceId === null && additions.length > 0) {
      activeWorkspaceId = additions[0].id
    }
    return { workspaces: nextWorkspaces, activeWorkspaceId }
  })
}

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

useAppStore.subscribe((state, prevState) => {
  if (activeAgentSetsEqual(state.activeClaudeWorkspaceIds, prevState.activeClaudeWorkspaceIds)) return
  const paths = [...state.activeClaudeWorkspaceIds]
    .map((wsId) => state.workspaces.find((w) => w.id === wsId)?.worktreePath)
    .filter((p): p is string => Boolean(p))
  window.api.git.setSyncBusy(paths)
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

  await reconcileGitWorktreesForStore(null)

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

  const state = useAppStore.getState()
  for (const project of state.projects) {
    void window.api.git.startSyncPolling(project.id, project.repoPath)
  }
  {
    const paths = [...state.activeClaudeWorkspaceIds]
      .map((wsId) => state.workspaces.find((w) => w.id === wsId)?.worktreePath)
      .filter((p): p is string => Boolean(p))
    window.api.git.setSyncBusy(paths)
  }

  // Schedule all enabled automations on startup
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
