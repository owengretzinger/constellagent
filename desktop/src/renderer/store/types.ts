import type { PrInfo } from '@shared/github-types'

export interface StartupCommand {
  name: string
  command: string
}

export interface Automation {
  id: string
  name: string
  projectId: string
  prompt: string
  cronExpression: string
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastRunStatus?: 'success' | 'failed' | 'timeout'
}

export interface Project {
  id: string
  name: string
  repoPath: string
  startupCommands?: StartupCommand[]
  prLinkProvider?: PrLinkProvider
}

export interface Workspace {
  id: string
  name: string
  branch: string
  worktreePath: string
  projectId: string
  automationId?: string
  isRoot?: boolean
}

export type Tab = {
  id: string
  workspaceId: string
} & (
  | { type: 'terminal'; title: string; ptyId: string }
  | { type: 'file'; filePath: string; unsaved?: boolean }
  | { type: 'diff' }
)

export type RightPanelMode = 'files' | 'changes'

export type PrLinkProvider = 'github' | 'graphite' | 'devinreview'

export interface Settings {
  confirmOnClose: boolean
  autoSaveOnBlur: boolean
  defaultShell: string
  restoreWorkspace: boolean
  diffInline: boolean
  terminalFontSize: number
  editorFontSize: number
}

export const DEFAULT_SETTINGS: Settings = {
  confirmOnClose: true,
  autoSaveOnBlur: false,
  defaultShell: '',
  restoreWorkspace: true,
  diffInline: false,
  terminalFontSize: 14,
  editorFontSize: 13,
}

export interface Toast {
  id: string
  message: string
  type: 'error' | 'info'
}

export interface ConfirmDialogState {
  title: string
  message: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
}

export interface AppState {
  // Data
  projects: Project[]
  workspaces: Workspace[]
  tabs: Tab[]
  automations: Automation[]
  activeWorkspaceId: string | null
  activeTabId: string | null
  lastActiveTabByWorkspace: Record<string, string>
  rightPanelMode: RightPanelMode
  rightPanelOpen: boolean
  sidebarCollapsed: boolean
  lastSavedTabId: string | null
  workspaceDialogProjectId: string | null
  settings: Settings
  settingsOpen: boolean
  automationsOpen: boolean
  confirmDialog: ConfirmDialogState | null
  toasts: Toast[]
  quickOpenVisible: boolean
  unreadWorkspaceIds: Set<string>
  activeAgentWorkspaceIds: Set<string>
  prStatusMap: Map<string, PrInfo | null>
  ghAvailability: Map<string, boolean>

  // Actions
  addProject: (project: Project) => void
  addProjectWithRootWorkspace: (project: Project) => Promise<void>
  removeProject: (id: string) => void
  addWorkspace: (workspace: Workspace) => void
  removeWorkspace: (id: string) => void
  setActiveWorkspace: (id: string | null) => void
  addTab: (tab: Tab) => void
  removeTab: (id: string) => void
  setActiveTab: (id: string | null) => void
  setRightPanelMode: (mode: RightPanelMode) => void
  toggleRightPanel: () => void
  toggleSidebar: () => void
  nextTab: () => void
  prevTab: () => void
  createTerminalForActiveWorkspace: () => Promise<void>
  closeActiveTab: () => void
  setTabUnsaved: (tabId: string, unsaved: boolean) => void
  notifyTabSaved: (tabId: string) => void
  openFileTab: (filePath: string) => void
  openDiffTab: (workspaceId: string) => void
  nextWorkspace: () => void
  prevWorkspace: () => void
  switchToTabByIndex: (index: number) => void
  closeAllWorkspaceTabs: () => void
  focusOrCreateTerminal: () => Promise<void>
  openWorkspaceDialog: (projectId: string | null) => void
  renameWorkspace: (id: string, name: string) => void
  updateWorkspaceBranch: (id: string, branch: string) => void
  deleteWorkspace: (workspaceId: string) => Promise<void>
  updateProject: (id: string, partial: Partial<Omit<Project, 'id'>>) => void
  deleteProject: (projectId: string) => Promise<void>
  updateSettings: (partial: Partial<Settings>) => void
  toggleSettings: () => void
  toggleAutomations: () => void
  showConfirmDialog: (dialog: ConfirmDialogState) => void
  dismissConfirmDialog: () => void
  addToast: (toast: Toast) => void
  dismissToast: (id: string) => void
  toggleQuickOpen: () => void
  closeQuickOpen: () => void

  // Unread indicator actions
  markWorkspaceUnread: (workspaceId: string) => void
  clearWorkspaceUnread: (workspaceId: string) => void

  // Agent activity actions (all integrations)
  setActiveAgentWorkspaces: (workspaceIds: string[]) => void

  // PR status actions
  setPrStatuses: (projectId: string, statuses: Record<string, PrInfo | null>) => void
  setGhAvailability: (projectId: string, available: boolean) => void

  // Automation actions
  addAutomation: (automation: Automation) => void
  updateAutomation: (id: string, partial: Partial<Omit<Automation, 'id'>>) => void
  removeAutomation: (id: string) => void

  // Hydration
  hydrateState: (data: PersistedState) => void

  // Derived
  activeWorkspaceTabs: () => Tab[]
  activeProject: () => Project | undefined
}

export interface PersistedState {
  projects: Project[]
  workspaces: Workspace[]
  tabs?: Tab[]
  automations?: Automation[]
  activeWorkspaceId?: string | null
  activeTabId?: string | null
  lastActiveTabByWorkspace?: Record<string, string>
  settings?: Settings
}
