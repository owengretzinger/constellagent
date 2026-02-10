import { useState, useCallback, useMemo } from 'react'
import { useAppStore } from '../../store/app-store'
import type { Project } from '../../store/types'
import { WorkspaceDialog } from './WorkspaceDialog'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { ConfirmDialog } from './ConfirmDialog'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './Sidebar.module.css'

export function Sidebar() {
  const {
    projects,
    workspaces,
    activeWorkspaceId,
    setActiveWorkspace,
    addProject,
    addWorkspace,
    addTab,
    addToast,
    workspaceDialogProjectId,
    openWorkspaceDialog,
    deleteWorkspace,
    updateProject,
    deleteProject,
    confirmDialog,
    showConfirmDialog,
    dismissConfirmDialog,
    toggleSettings,
    toggleAutomations,
    unreadWorkspaceIds,
  } = useAppStore()

  const [manualExpanded, setManualExpanded] = useState<Set<string>>(new Set())
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const dialogProject = workspaceDialogProjectId
    ? projects.find((p) => p.id === workspaceDialogProjectId) ?? null
    : null

  // Auto-expand the project containing the active workspace
  const activeProjectId = useMemo(() => {
    if (!activeWorkspaceId) return null
    return workspaces.find((w) => w.id === activeWorkspaceId)?.projectId ?? null
  }, [activeWorkspaceId, workspaces])

  const expandedProjects = useMemo(() => {
    const set = new Set(manualExpanded)
    if (activeProjectId) set.add(activeProjectId)
    return set
  }, [manualExpanded, activeProjectId])

  const toggleProject = useCallback((id: string) => {
    setManualExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleAddProject = useCallback(async () => {
    const dirPath = await window.api.app.selectDirectory()
    if (!dirPath) return

    const name = dirPath.split('/').pop() || dirPath
    const id = crypto.randomUUID()
    addProject({ id, name, repoPath: dirPath })
    setManualExpanded((prev) => new Set(prev).add(id))
  }, [addProject])

  const finishCreateWorkspace = useCallback(async (project: Project, name: string, branch: string, worktreePath: string) => {
    const wsId = crypto.randomUUID()
    addWorkspace({
      id: wsId,
      name,
      branch,
      worktreePath,
      projectId: project.id,
    })

    const commands = project.startupCommands ?? []

    // Pre-trust worktree in Claude Code if any command uses claude
    if (commands.some((c) => c.command.trim().startsWith('claude'))) {
      await window.api.claude.trustPath(worktreePath).catch(() => {})
    }

    if (commands.length === 0) {
      // Default: one blank terminal
      const ptyId = await window.api.pty.create(worktreePath, undefined, { AGENT_ORCH_WS_ID: wsId })
      addTab({
        id: crypto.randomUUID(),
        workspaceId: wsId,
        type: 'terminal',
        title: 'Terminal',
        ptyId,
      })
    } else {
      let firstTabId: string | null = null
      for (const cmd of commands) {
        const ptyId = await window.api.pty.create(worktreePath, undefined, { AGENT_ORCH_WS_ID: wsId })
        const tabId = crypto.randomUUID()
        if (!firstTabId) firstTabId = tabId
        addTab({
          id: tabId,
          workspaceId: wsId,
          type: 'terminal',
          title: cmd.name || cmd.command,
          ptyId,
        })
        // Delay to let shell initialize before writing command
        setTimeout(() => {
          window.api.pty.write(ptyId, cmd.command + '\n')
        }, 500)
      }
      // Activate the first terminal tab
      if (firstTabId) useAppStore.getState().setActiveTab(firstTabId)
    }
  }, [addWorkspace, addTab])

  const handleCreateWorkspace = useCallback(async (project: Project, name: string, branch: string, newBranch: boolean, force = false) => {
    try {
      const worktreePath = await window.api.git.createWorktree(
        project.repoPath,
        name,
        branch,
        newBranch,
        force
      )
      await finishCreateWorkspace(project, name, branch, worktreePath)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create workspace'
      const confirmMessages = [
        {
          key: 'WORKTREE_PATH_EXISTS',
          title: 'Worktree already exists',
          message: `A leftover directory for workspace "${name}" already exists on disk. Replace it?`,
        },
        {
          key: 'BRANCH_CHECKED_OUT',
          title: 'Branch in use',
          message: `Branch "${branch}" is checked out in another worktree. Remove the old worktree and continue?`,
        },
      ]
      const confirm = confirmMessages.find((c) => msg.includes(c.key))
      if (confirm) {
        showConfirmDialog({
          ...confirm,
          confirmLabel: 'Replace',
          destructive: true,
          onConfirm: () => {
            dismissConfirmDialog()
            handleCreateWorkspace(project, name, branch, newBranch, true)
          },
        })
        return
      }
      addToast({ id: crypto.randomUUID(), message: msg, type: 'error' })
    }
  }, [finishCreateWorkspace, addToast, showConfirmDialog, dismissConfirmDialog])

  const handleSelectWorkspace = useCallback((wsId: string) => {
    setActiveWorkspace(wsId)
  }, [setActiveWorkspace])

  const handleDeleteWorkspace = useCallback((e: React.MouseEvent, ws: { id: string; name: string }) => {
    e.stopPropagation()
    if (e.shiftKey) {
      deleteWorkspace(ws.id)
      return
    }
    showConfirmDialog({
      title: 'Delete Workspace',
      message: `Delete workspace "${ws.name}"? This will remove the git worktree from disk.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        deleteWorkspace(ws.id)
        dismissConfirmDialog()
      },
    })
  }, [showConfirmDialog, deleteWorkspace, dismissConfirmDialog])

  const handleDeleteProject = useCallback((e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    const wsCount = workspaces.filter((w) => w.projectId === project.id).length
    showConfirmDialog({
      title: 'Delete Project',
      message: `Delete project "${project.name}"${wsCount > 0 ? ` and its ${wsCount} workspace${wsCount > 1 ? 's' : ''}` : ''}? This will remove all git worktrees from disk.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => {
        deleteProject(project.id)
        dismissConfirmDialog()
      },
    })
  }, [workspaces, showConfirmDialog, deleteProject, dismissConfirmDialog])

  return (
    <div className={styles.sidebar}>
      <div className={styles.titleArea} />

      <div className={styles.projectList}>
        {projects.length === 0 && (
          <div className={styles.emptyState}>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)', padding: '0 var(--space-6)' }}>
              No projects yet. Add a git repository to get started.
            </span>
          </div>
        )}

        {projects.map((project) => {
          const isExpanded = expandedProjects.has(project.id)
          const projectWorkspaces = workspaces.filter(
            (w) => w.projectId === project.id
          )

          return (
            <div key={project.id} className={styles.projectSection}>
              <div
                className={styles.projectHeader}
                onClick={() => toggleProject(project.id)}
              >
                <span className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ''}`}>
                  ▶
                </span>
                <span className={styles.projectName}>{project.name}</span>
                <Tooltip label="Project settings">
                  <button
                    className={styles.settingsBtn}
                    onClick={(e) => { e.stopPropagation(); setEditingProject(project) }}
                  >
                    ⚙
                  </button>
                </Tooltip>
                <Tooltip label="Delete project">
                  <button
                    className={styles.deleteBtn}
                    onClick={(e) => handleDeleteProject(e, project)}
                  >
                    ✕
                  </button>
                </Tooltip>
              </div>

              {isExpanded && (
                <div className={styles.workspaceList}>
                  {projectWorkspaces.map((ws) => (
                    <div
                      key={ws.id}
                      className={`${styles.workspaceItem} ${
                        ws.id === activeWorkspaceId ? styles.active : ''
                      } ${unreadWorkspaceIds.has(ws.id) ? styles.unread : ''}`}
                      onClick={() => handleSelectWorkspace(ws.id)}
                    >
                      <span className={styles.workspaceIcon}>{ws.automationId ? '⏱' : '⌥'}</span>
                      <div className={styles.workspaceNameCol}>
                        <span className={styles.workspaceName}>{ws.automationId ? ws.name : ws.branch}</span>
                        {ws.automationId && ws.branch && (
                          <span className={styles.workspaceMeta}>{ws.branch}</span>
                        )}
                      </div>
                      <Tooltip label="Delete workspace">
                        <button
                          className={styles.deleteBtn}
                          onClick={(e) => handleDeleteWorkspace(e, ws)}
                        >
                          ✕
                        </button>
                      </Tooltip>
                    </div>
                  ))}

                  <Tooltip label="New workspace" shortcut="⌘N">
                    <button
                      className={styles.actionButton}
                      onClick={() => openWorkspaceDialog(project.id)}
                      style={{ paddingLeft: 'var(--space-4)' }}
                    >
                      <span className={styles.actionIcon}>+</span>
                      <span>New workspace</span>
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className={styles.actions}>
        <Tooltip label="Add project">
          <button className={styles.actionButton} onClick={handleAddProject}>
            <span className={styles.actionIcon}>+</span>
            <span>Add project</span>
          </button>
        </Tooltip>
        <Tooltip label="Automations">
          <button className={styles.actionButton} onClick={toggleAutomations}>
            <span className={styles.actionIcon}>⏱</span>
            <span>Automations</span>
          </button>
        </Tooltip>
        <Tooltip label="Settings" shortcut="⌘,">
          <button className={styles.actionButton} onClick={toggleSettings}>
            <span className={styles.actionIcon}>⚙</span>
            <span>Settings</span>
          </button>
        </Tooltip>
      </div>

      {dialogProject && (
        <WorkspaceDialog
          project={dialogProject}
          onConfirm={(name, branch, newBranch) => {
            handleCreateWorkspace(dialogProject, name, branch, newBranch)
            openWorkspaceDialog(null)
          }}
          onCancel={() => openWorkspaceDialog(null)}
        />
      )}

      {editingProject && (
        <ProjectSettingsDialog
          project={editingProject}
          onSave={(cmds) => {
            updateProject(editingProject.id, { startupCommands: cmds })
            setEditingProject(null)
          }}
          onCancel={() => setEditingProject(null)}
        />
      )}

      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          destructive={confirmDialog.destructive}
          onConfirm={confirmDialog.onConfirm}
          onCancel={dismissConfirmDialog}
        />
      )}
    </div>
  )
}
