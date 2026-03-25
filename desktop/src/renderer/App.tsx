import { useEffect, useMemo } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { useAppStore } from './store/app-store'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TabBar } from './components/TabBar/TabBar'
import { TerminalSplitContainer } from './components/Terminal/TerminalSplitContainer'
import { FileEditor } from './components/Editor/FileEditor'
import { DiffViewer } from './components/Editor/DiffEditor'
import { MarkdownPreview } from './components/MarkdownPreview/MarkdownPreview'
import { RightPanel } from './components/RightPanel/RightPanel'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { AutomationsPanel } from './components/Automations/AutomationsPanel'
import { ContextHistoryPanel } from './components/ContextHistory/ContextHistoryPanel'
import { QuickOpen } from './components/QuickOpen/QuickOpen'
import { PlanPalette } from './components/PlanPalette/PlanPalette'
import { ConfirmDialog } from './components/Sidebar/ConfirmDialog'
import { ToastContainer } from './components/Toast/Toast'
import { useShortcuts } from './hooks/useShortcuts'
import { usePrStatusPoller } from './hooks/usePrStatusPoller'
import { ErrorBoundary } from './components/ErrorBoundary/ErrorBoundary'
import styles from './App.module.css'

export function App() {
  useShortcuts()
  usePrStatusPoller()

  // Listen for workspace notification signals from Claude Code hooks
  useEffect(() => {
    const unsub = window.api.claude.onNotifyWorkspace((workspaceId: string) => {
      const state = useAppStore.getState()
      if (workspaceId !== state.activeWorkspaceId) {
        state.markWorkspaceUnread(workspaceId)
      }
    })
    return unsub
  }, [])

  // Listen for agent activity updates (Claude hooks + Codex submit/notify markers)
  useEffect(() => {
    let prevActive = new Set<string>()
    const unsub = window.api.claude.onActivityUpdate((entries) => {
      const nextActive = new Set(entries.map((e) => e.wsId))
      const state = useAppStore.getState()

      for (const wsId of prevActive) {
        if (!nextActive.has(wsId) && wsId !== state.activeWorkspaceId && state.workspaces.some((w) => w.id === wsId)) {
          state.markWorkspaceUnread(wsId)
        }
      }

      state.setActiveAgentWorkspaces(entries)
      prevActive = nextActive
    })
    return unsub
  }, [])

  // Listen for agent type detection from PTY (claude, codex, gemini, cursor)
  useEffect(() => {
    return window.api.pty.onAgentDetected(({ ptyId, agentType }) => {
      useAppStore.getState().setTerminalAgentType(ptyId, agentType as import('./store/types').AgentType)
    })
  }, [])

  // Listen for OSC title changes from PTY (agent session topics)
  useEffect(() => {
    return window.api.pty.onTitleChanged(({ ptyId, title }) => {
      console.log('[constellagent:tab-title] renderer IPC PTY_TITLE_CHANGED', { ptyId, title: title.slice(0, 80) })
      useAppStore.getState().updateTerminalTitle(ptyId, title)
    })
  }, [])

  // Codex: tab title from context DB (first UserPrompt in session) when OSC/user-write did not set one
  useEffect(() => {
    return window.api.context.onCodexTabTitleHint(({ workspaceId, title }) => {
      console.log('[constellagent:tab-title] renderer IPC CONTEXT_CODEX_TAB_TITLE_HINT', {
        workspaceId,
        title: title.slice(0, 80),
      })
      useAppStore.getState().applyCodexContextTitleHint(workspaceId, title)
    })
  }, [])

  useEffect(() => {
    return window.api.git.onWorktreeSyncStatus((event) => {
      useAppStore.getState().setWorktreeSyncStatus(event.projectId, event.workspaces)
    })
  }, [])

  const allTabs = useAppStore((s) => s.tabs)
  const activeTabId = useAppStore((s) => s.activeTabId)
  const rightPanelOpen = useAppStore((s) => s.rightPanelOpen)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const activeWorkspaceTabs = useAppStore((s) => s.activeWorkspaceTabs)
  const workspaces = useAppStore((s) => s.workspaces)
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId)
  const settingsOpen = useAppStore((s) => s.settingsOpen)
  const automationsOpen = useAppStore((s) => s.automationsOpen)
  const contextHistoryOpen = useAppStore((s) => s.contextHistoryOpen)
  const quickOpenVisible = useAppStore((s) => s.quickOpenVisible)
  const planPaletteVisible = useAppStore((s) => s.planPaletteVisible)
  const confirmDialog = useAppStore((s) => s.confirmDialog)
  const dismissConfirmDialog = useAppStore((s) => s.dismissConfirmDialog)

  const wsTabs = activeWorkspaceTabs()
  const activeTab = wsTabs.find((t) => t.id === activeTabId)
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const planProjectWorktrees = useMemo(() => {
    if (!workspace) return []
    return workspaces
      .filter((w) => w.projectId === workspace.projectId)
      .map((w) => ({
        path: w.worktreePath,
        label: w.name || w.branch || w.worktreePath.split('/').filter(Boolean).pop() || w.worktreePath,
      }))
  }, [workspaces, workspace])
  const tabWorkspace = activeTab
    ? workspaces.find((w) => w.id === activeTab.workspaceId)
    : undefined

  // All terminal tabs across every workspace — kept alive to preserve PTY state
  const allTerminals = allTabs.filter((t): t is Extract<typeof t, { type: 'terminal' }> => t.type === 'terminal')

  return (
    <div className={styles.app}>
      <div className={styles.layout}>
        {settingsOpen ? (
          <SettingsPanel />
        ) : automationsOpen ? (
          <AutomationsPanel />
        ) : contextHistoryOpen ? (
          <ContextHistoryPanel />
        ) : (
          <ErrorBoundary
            fallback={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888', fontSize: 14 }}>
                Something went wrong. Try reloading the window (⌘R).
              </div>
            }
          >
          <Allotment>
            {/* Sidebar */}
            {!sidebarCollapsed && (
              <Allotment.Pane minSize={160} maxSize={400} preferredSize={220}>
                <Sidebar />
              </Allotment.Pane>
            )}

            {/* Center */}
            <Allotment.Pane>
              <div className={styles.centerPanel}>
                <TabBar />
                <div className={styles.contentArea}>
                  {/* Keep ALL terminal panels alive across workspaces so PTY
                      state (scrollback, TUI layout) is never lost */}
                  {allTerminals.map((t) => {
                    const ws = workspaces.find((w) => w.id === t.workspaceId)
                    return (
                      <TerminalSplitContainer
                        key={t.id}
                        tab={t}
                        active={t.id === activeTabId}
                        worktreePath={ws?.worktreePath}
                      />
                    )
                  })}

                  {!activeTab ? (
                    <div className={styles.welcome}>
                      <div className={styles.welcomeLogo}>constellagent</div>
                      <div className={styles.welcomeHint}>
                        Add a project to get started, or press
                        <span className={styles.welcomeShortcut}>⌘T</span>
                        for a new terminal
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* Render active file editor */}
                      {activeTab?.type === 'file' && (
                        <FileEditor
                          key={activeTab.id}
                          tabId={activeTab.id}
                          filePath={activeTab.filePath}
                          active={true}
                          worktreePath={tabWorkspace?.worktreePath}
                        />
                      )}

                      {/* Render active diff viewer */}
                      {activeTab?.type === 'diff' && workspace && (
                        <DiffViewer
                          key={activeTab.commitHash || activeTab.id}
                          worktreePath={workspace.worktreePath}
                          active={true}
                          commitHash={activeTab.commitHash}
                          commitMessage={activeTab.commitMessage}
                        />
                      )}

                      {/* Render markdown preview */}
                      {activeTab?.type === 'markdownPreview' && (
                        <MarkdownPreview
                          key={activeTab.id}
                          filePath={activeTab.filePath}
                          worktreePath={tabWorkspace?.worktreePath}
                        />
                      )}
                    </>
                  )}
                </div>
              </div>
            </Allotment.Pane>

            {/* Right Panel */}
            {rightPanelOpen && (
              <Allotment.Pane minSize={200} maxSize={500} preferredSize={280}>
                <RightPanel />
              </Allotment.Pane>
            )}
          </Allotment>
          </ErrorBoundary>
        )}
      </div>
      {quickOpenVisible && workspace && (
        <QuickOpen worktreePath={workspace.worktreePath} />
      )}
      {planPaletteVisible && workspace && (
        <PlanPalette worktreePath={workspace.worktreePath} projectWorktrees={planProjectWorktrees} />
      )}
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          destructive={confirmDialog.destructive}
          tip={confirmDialog.tip}
          loading={confirmDialog.loading}
          onConfirm={confirmDialog.onConfirm}
          onCancel={dismissConfirmDialog}
          secondaryConfirmLabel={confirmDialog.secondaryConfirmLabel}
          onSecondaryConfirm={confirmDialog.onSecondaryConfirm}
        />
      )}
      <ToastContainer />
    </div>
  )
}
