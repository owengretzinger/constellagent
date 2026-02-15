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
export type WorkspaceCreationMode = 'worktree' | 'clone'

export interface ShortcutBinding {
  code: string
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export interface ShortcutSettings {
  tabByIndex: Array<ShortcutBinding | null>
  workspaceByIndex: Array<ShortcutBinding | null>
}

function createDefaultTabShortcuts(): Array<ShortcutBinding | null> {
  return Array.from({ length: 9 }, (_v, index) => ({
    code: `Digit${index + 1}`,
    meta: true,
    ctrl: false,
    shift: false,
    alt: false,
  }))
}

function createDefaultWorkspaceShortcuts(): Array<ShortcutBinding | null> {
  return Array.from({ length: 9 }, (_v, index) => ({
    code: `Digit${index + 1}`,
    meta: false,
    ctrl: true,
    shift: false,
    alt: false,
  }))
}

export function createDefaultShortcutSettings(): ShortcutSettings {
  return {
    tabByIndex: createDefaultTabShortcuts(),
    workspaceByIndex: createDefaultWorkspaceShortcuts(),
  }
}

export interface Settings {
  confirmOnClose: boolean
  autoSaveOnBlur: boolean
  defaultShell: string
  useLoginShell: boolean
  restoreWorkspace: boolean
  workspaceCreationMode: WorkspaceCreationMode
  diffInline: boolean
  uiZoomFactor: number
  terminalFontSize: number
  terminalFontFamily: string
  editorFontSize: number
  shortcuts: ShortcutSettings
}

export const DEFAULT_TERMINAL_FONT_FAMILY = "'SF Mono', Menlo, 'Cascadia Code', monospace"

export const DEFAULT_SETTINGS: Settings = {
  confirmOnClose: true,
  autoSaveOnBlur: false,
  defaultShell: '',
  useLoginShell: true,
  restoreWorkspace: true,
  workspaceCreationMode: 'worktree',
  diffInline: false,
  uiZoomFactor: 1,
  terminalFontSize: 14,
  terminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  editorFontSize: 13,
  shortcuts: createDefaultShortcutSettings(),
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
  activeClaudeWorkspaceIds: Set<string>
  prStatusMap: Map<string, PrInfo | null>
  ghAvailability: Map<string, boolean>
  collapsedProjectIds: Set<string>

  // Actions
  addProject: (project: Project) => void
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
  switchToWorkspaceByIndex: (index: number) => void
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
  toggleProjectCollapsed: (projectId: string) => void

  // Unread indicator actions
  markWorkspaceUnread: (workspaceId: string) => void
  clearWorkspaceUnread: (workspaceId: string) => void

  // Agent activity actions (Claude + Codex)
  setActiveClaudeWorkspaces: (workspaceIds: string[]) => void

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
