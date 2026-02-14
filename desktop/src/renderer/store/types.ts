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

export interface SkillEntry {
  id: string
  name: string
  description: string
  sourcePath: string
  enabled: boolean
}

export interface SubagentEntry {
  id: string
  name: string
  description: string
  sourcePath: string
  tools?: string
  enabled: boolean
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

export type SplitLeaf =
  | { type: 'leaf'; id: string; contentType: 'terminal'; ptyId: string }
  | { type: 'leaf'; id: string; contentType: 'file'; filePath: string }

export type SplitNode =
  | SplitLeaf
  | { type: 'split'; id: string; direction: 'horizontal' | 'vertical'; children: [SplitNode, SplitNode] }

export type Tab = {
  id: string
  workspaceId: string
} & (
  | { type: 'terminal'; title: string; ptyId: string; splitRoot?: SplitNode; focusedPaneId?: string }
  | { type: 'file'; filePath: string; unsaved?: boolean; deleted?: boolean }
  | { type: 'diff'; commitHash?: string; commitMessage?: string }
)

export type RightPanelMode = 'files' | 'changes' | 'graph'

export type PrLinkProvider = 'github' | 'graphite' | 'devinreview'

export type FavoriteEditor = 'cursor' | 'vscode' | 'zed' | 'sublime' | 'webstorm' | 'custom'

export const EDITOR_PRESETS: Record<Exclude<FavoriteEditor, 'custom'>, { name: string; cli: string }> = {
  cursor: { name: 'Cursor', cli: 'cursor' },
  vscode: { name: 'VS Code', cli: 'code' },
  zed: { name: 'Zed', cli: 'zed' },
  sublime: { name: 'Sublime Text', cli: 'subl' },
  webstorm: { name: 'WebStorm', cli: 'webstorm' },
} as const

/** Resolve the CLI command and display name for the current favorite editor setting */
export function resolveEditor(settings: Settings): { name: string; cli: string } {
  if (settings.favoriteEditor === 'custom') {
    const cli = settings.favoriteEditorCustom || 'code'
    return { name: cli, cli }
  }
  return EDITOR_PRESETS[settings.favoriteEditor]
}

export interface McpServer {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
}

export type AgentType = 'claude-code' | 'codex' | 'gemini' | 'cursor'

export type AgentMcpAssignments = Record<AgentType, string[]>

export interface Settings {
  confirmOnClose: boolean
  autoSaveOnBlur: boolean
  defaultShell: string
  restoreWorkspace: boolean
  diffInline: boolean
  terminalFontSize: number
  editorFontSize: number
  favoriteEditor: FavoriteEditor
  favoriteEditorCustom: string
  mcpServers: McpServer[]
  agentMcpAssignments: AgentMcpAssignments
  contextCaptureEnabled: boolean
  sessionResumeEnabled: boolean
  skills: SkillEntry[]
  subagents: SubagentEntry[]
}

export const DEFAULT_SETTINGS: Settings = {
  confirmOnClose: true,
  autoSaveOnBlur: false,
  defaultShell: '',
  restoreWorkspace: true,
  diffInline: false,
  terminalFontSize: 14,
  editorFontSize: 13,
  favoriteEditor: 'cursor',
  favoriteEditorCustom: '',
  mcpServers: [],
  agentMcpAssignments: { 'claude-code': [], 'codex': [], 'gemini': [], 'cursor': [] },
  contextCaptureEnabled: false,
  sessionResumeEnabled: true,
  skills: [],
  subagents: [],
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
  contextHistoryOpen: boolean
  confirmDialog: ConfirmDialogState | null
  toasts: Toast[]
  quickOpenVisible: boolean
  unreadWorkspaceIds: Set<string>
  activeClaudeWorkspaceIds: Set<string>
  prStatusMap: Map<string, PrInfo | null>
  ghAvailability: Map<string, boolean>
  gitFileStatuses: Map<string, Map<string, string>>

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
  openCommitDiffTab: (workspaceId: string, hash: string, message: string) => void
  nextWorkspace: () => void
  prevWorkspace: () => void
  switchToTabByIndex: (index: number) => void
  closeAllWorkspaceTabs: () => void
  focusOrCreateTerminal: () => Promise<void>
  splitTerminalPane: (direction: 'horizontal' | 'vertical') => Promise<void>
  openFileInSplit: (filePath: string, direction?: 'horizontal' | 'vertical') => Promise<void>
  cycleFocusedPane: () => void
  setFocusedPane: (tabId: string, paneId: string) => void
  closeSplitPane: (paneId: string) => void
  openWorkspaceDialog: (projectId: string | null) => void
  renameWorkspace: (id: string, name: string) => void
  updateWorkspaceBranch: (id: string, branch: string) => void
  deleteWorkspace: (workspaceId: string) => Promise<void>
  updateProject: (id: string, partial: Partial<Omit<Project, 'id'>>) => void
  deleteProject: (projectId: string) => Promise<void>
  updateSettings: (partial: Partial<Settings>) => void
  toggleSettings: () => void
  toggleAutomations: () => void
  toggleContextHistory: () => void
  showConfirmDialog: (dialog: ConfirmDialogState) => void
  dismissConfirmDialog: () => void
  addToast: (toast: Toast) => void
  dismissToast: (id: string) => void
  toggleQuickOpen: () => void
  closeQuickOpen: () => void

  // Unread indicator actions
  markWorkspaceUnread: (workspaceId: string) => void
  clearWorkspaceUnread: (workspaceId: string) => void

  // Agent activity actions (Claude + Codex)
  setActiveClaudeWorkspaces: (workspaceIds: string[]) => void

  // Git file status actions
  setGitFileStatuses: (worktreePath: string, statuses: Map<string, string>) => void
  setTabDeleted: (tabId: string, deleted: boolean) => void

  // PR status actions
  setPrStatuses: (projectId: string, statuses: Record<string, PrInfo | null>) => void
  setGhAvailability: (projectId: string, available: boolean) => void

  // Automation actions
  addAutomation: (automation: Automation) => void
  updateAutomation: (id: string, partial: Partial<Omit<Automation, 'id'>>) => void
  removeAutomation: (id: string) => void

  // Skills & Subagents actions
  addSkill: (skill: SkillEntry) => void
  removeSkill: (id: string) => void
  updateSkill: (id: string, partial: Partial<Omit<SkillEntry, 'id'>>) => void
  addSubagent: (subagent: SubagentEntry) => void
  removeSubagent: (id: string) => void
  updateSubagent: (id: string, partial: Partial<Omit<SubagentEntry, 'id'>>) => void

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
