import { useEffect } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import { useAppStore } from './store/app-store'
import { Sidebar } from './components/Sidebar/Sidebar'
import { TabBar } from './components/TabBar/TabBar'
import { TerminalPanel } from './components/Terminal/TerminalPanel'
import { FileEditor } from './components/Editor/FileEditor'
import { DiffViewer } from './components/Editor/DiffEditor'
import { RightPanel } from './components/RightPanel/RightPanel'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { AutomationsPanel } from './components/Automations/AutomationsPanel'
import { QuickOpen } from './components/QuickOpen/QuickOpen'
import { ToastContainer } from './components/Toast/Toast'
import { useShortcuts } from './hooks/useShortcuts'
import { usePrStatusPoller } from './hooks/usePrStatusPoller'
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
    const unsub = window.api.claude.onActivityUpdate((workspaceIds: string[]) => {
      const nextActive = new Set(workspaceIds)
      const state = useAppStore.getState()

      // Fallback unread signal on activity completion:
      // if a workspace was active and is now inactive, mark unread unless it's open.
      for (const wsId of prevActive) {
        if (!nextActive.has(wsId) && wsId !== state.activeWorkspaceId && state.workspaces.some((w) => w.id === wsId)) {
          state.markWorkspaceUnread(wsId)
        }
      }

      state.setActiveClaudeWorkspaces(workspaceIds)
      prevActive = nextActive
    })
    return unsub
  }, [])

  const {
    tabs: allTabs,
    activeTabId,
    rightPanelOpen,
    sidebarCollapsed,
    activeWorkspaceTabs,
    workspaces,
    activeWorkspaceId,
    settingsOpen,
    automationsOpen,
    quickOpenVisible,
  } = useAppStore()

  const wsTabs = activeWorkspaceTabs()
  const activeTab = wsTabs.find((t) => t.id === activeTabId)
  const workspace = workspaces.find((w) => w.id === activeWorkspaceId)

  // All terminal tabs across every workspace — kept alive to preserve PTY state
  const allTerminals = allTabs.filter((t): t is Extract<typeof t, { type: 'terminal' }> => t.type === 'terminal')

  return (
    <div className={styles.app}>
      <div className={styles.layout}>
        {settingsOpen ? (
          <SettingsPanel />
        ) : automationsOpen ? (
          <AutomationsPanel />
        ) : (
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
                  {allTerminals.map((t) => (
                    <TerminalPanel
                      key={t.id}
                      ptyId={t.ptyId}
                      active={t.id === activeTabId}
                    />
                  ))}

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
                        />
                      )}

                      {/* Render active diff viewer */}
                      {activeTab?.type === 'diff' && workspace && (
                        <DiffViewer
                          key={activeTab.id}
                          worktreePath={workspace.worktreePath}
                          active={true}
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
        )}
      </div>
      {quickOpenVisible && workspace && (
        <QuickOpen worktreePath={workspace.worktreePath} />
      )}
      <ToastContainer />
    </div>
  )
}
