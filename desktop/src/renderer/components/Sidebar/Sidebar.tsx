import { useState, useEffect, useCallback, useRef } from "react";
import { useAppStore } from "../../store/app-store";
import type { Project } from "../../store/types";
import type { CreateWorktreeProgressEvent } from "../../../shared/workspace-creation";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { ConfirmDialog } from "./ConfirmDialog";
import { Tooltip } from "../Tooltip/Tooltip";
import styles from "./Sidebar.module.css";

const PR_ICON_SIZE = 10;
const PR_REVIEW_ICON_SIZE = 10;
const START_TERMINAL_MESSAGE = "Starting terminal...";
const MAX_COMMENT_COUNT_DISPLAY = 9;

interface WorkspaceCreationState {
  requestId: string;
  message: string;
}

function PrStateIcon({ state }: { state: "open" | "merged" | "closed" }) {
  if (state === "open") {
    // GitHub git-pull-request icon (simplified)
    return (
      <svg width={PR_ICON_SIZE} height={PR_ICON_SIZE} viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
      </svg>
    );
  }
  if (state === "merged") {
    // GitHub git-merge icon
    return (
      <svg width={PR_ICON_SIZE} height={PR_ICON_SIZE} viewBox="0 0 16 16" fill="currentColor">
        <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
      </svg>
    );
  }
  // closed — GitHub git-pull-request-closed icon
  return (
    <svg width={PR_ICON_SIZE} height={PR_ICON_SIZE} viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.75.75 0 1 1 1.06 1.06l-.97.97.97.97a.75.75 0 0 1-1.06 1.06l-.97-.97-.97.97a.75.75 0 1 1-1.06-1.06l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM3.25 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

function CommentCountIcon({ count }: { count: number }) {
  const text =
    count > MAX_COMMENT_COUNT_DISPLAY
      ? `${MAX_COMMENT_COUNT_DISPLAY}+`
      : String(count);
  return (
    <span className={styles.prCommentIcon}>
      <svg
        className={styles.prCommentIconBubble}
        width="18"
        height="14"
        viewBox="0 0 18 14"
        aria-hidden="true"
      >
        <path d="M2.25 2.75C2.25 1.784 3.034 1 4 1h10c.966 0 1.75.784 1.75 1.75v6.5c0 .966-.784 1.75-1.75 1.75H9L5.5 13V11H4c-.966 0-1.75-.784-1.75-1.75Z" />
      </svg>
      <span className={styles.prCommentIconCount}>{text}</span>
    </span>
  );
}

function PrReviewDecisionIcon({
  decision,
}: {
  decision: "approved" | "changes_requested";
}) {
  if (decision === "approved") {
    return (
      <svg width={PR_REVIEW_ICON_SIZE} height={PR_REVIEW_ICON_SIZE} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-6.25 6.25a.75.75 0 0 1-1.06 0L2.22 7.28a.75.75 0 1 1 1.06-1.06L7 9.94l5.72-5.72a.75.75 0 0 1 1.06 0Z" />
      </svg>
    );
  }

  return (
    <svg width={PR_REVIEW_ICON_SIZE} height={PR_REVIEW_ICON_SIZE} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6.78 2.97a.75.75 0 0 1 0 1.06L4.81 6H9.5A4.5 4.5 0 0 1 14 10.5v1.75a.75.75 0 0 1-1.5 0V10.5A3 3 0 0 0 9.5 7.5H4.81l1.97 1.97a.75.75 0 1 1-1.06 1.06L2.47 7.28a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

function WorkspaceMeta({
  projectId,
  branch,
  showBranch,
}: {
  projectId: string;
  branch: string;
  showBranch: boolean;
}) {
  const prInfo = useAppStore((s) =>
    s.prStatusMap.get(`${projectId}:${branch}`),
  );
  const ghAvailable = useAppStore((s) => s.ghAvailability.get(projectId));
  const prLinkProvider = useAppStore((s) => s.settings.prLinkProvider);
  const hasPr = !!(ghAvailable && prInfo !== undefined && prInfo !== null);

  if (!hasPr && !showBranch) return null;

  const stateClass = hasPr ? styles[`pr_${prInfo!.state}`] || "" : "";
  const openPr = hasPr && prInfo!.state === "open";
  const pendingCommentCount = openPr ? Math.max(0, prInfo!.pendingCommentCount || 0) : 0;
  const hasPendingComments = pendingCommentCount > 0;
  const isBlockedByCi = openPr && !!prInfo!.isBlockedByCi;
  const isApproved = openPr && !!prInfo!.isApproved;
  const isChangesRequested = openPr && !!prInfo!.isChangesRequested;
  const reviewDecision: "approved" | "changes_requested" | null = isChangesRequested
    ? "changes_requested"
    : isApproved
      ? "approved"
      : null;
  const isCiPassing = openPr && prInfo!.checkStatus === "passing" && !isBlockedByCi;

  return (
    <span className={styles.workspaceMeta}>
      {hasPr && (
        <span
          className={`${styles.prInline} ${stateClass}`}
          title={`PR #${prInfo!.number}: ${prInfo!.title}`}
          onClick={(e) => {
            e.stopPropagation();
            const domains: Record<string, string> = {
              github: 'github.com',
              graphite: 'graphite.dev',
              devinreview: 'devinreview.com',
            };
            const url = prInfo!.url.replace('github.com', domains[prLinkProvider] || 'github.com');
            window.open(url);
          }}
        >
          <PrStateIcon state={prInfo!.state} />
          <span className={styles.prNumber}>#{prInfo!.number}</span>
          {openPr && reviewDecision && (
            <span
              className={`${styles.prReviewDecisionIcon} ${styles.prReviewDecisionInline} ${
                reviewDecision === "approved" ? styles.prApproved : styles.prChangesRequested
              }`}
              title={reviewDecision === "approved" ? "Approved" : "Changes requested"}
            >
              <PrReviewDecisionIcon decision={reviewDecision} />
            </span>
          )}
          {openPr && (
            <span className={styles.prSignals}>
              {hasPendingComments && (
                <span
                  className={styles.prPendingComments}
                  title={`${pendingCommentCount} unresolved review comment${pendingCommentCount === 1 ? "" : "s"}`}
                >
                  <CommentCountIcon count={pendingCommentCount} />
                </span>
              )}
              {isBlockedByCi && (
                <span
                  className={`${styles.prBadge} ${styles.prBlockedCi}`}
                  title="Blocked by CI checks"
                >
                  CI
                </span>
              )}
              {isCiPassing && (
                <span
                  className={`${styles.prBadge} ${styles.prCiPassing}`}
                  title="CI checks passing"
                >
                  CI
                </span>
              )}
            </span>
          )}
        </span>
      )}
      {hasPr && showBranch && <span style={{ marginRight: 4 }} />}
      {showBranch && branch}
    </span>
  );
}

export function Sidebar() {
  const projects = useAppStore((s) => s.projects);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
  const setActiveWorkspace = useAppStore((s) => s.setActiveWorkspace);
  const addProjectWithRootWorkspace = useAppStore((s) => s.addProjectWithRootWorkspace);
  const addWorkspace = useAppStore((s) => s.addWorkspace);
  const addTab = useAppStore((s) => s.addTab);
  const addToast = useAppStore((s) => s.addToast);
  const workspaceDialogProjectId = useAppStore((s) => s.workspaceDialogProjectId);
  const openWorkspaceDialog = useAppStore((s) => s.openWorkspaceDialog);
  const deleteWorkspace = useAppStore((s) => s.deleteWorkspace);
  const updateProject = useAppStore((s) => s.updateProject);
  const deleteProject = useAppStore((s) => s.deleteProject);
  const confirmDialog = useAppStore((s) => s.confirmDialog);
  const showConfirmDialog = useAppStore((s) => s.showConfirmDialog);
  const dismissConfirmDialog = useAppStore((s) => s.dismissConfirmDialog);
  const toggleSettings = useAppStore((s) => s.toggleSettings);
  const toggleAutomations = useAppStore((s) => s.toggleAutomations);
  const unreadWorkspaceIds = useAppStore((s) => s.unreadWorkspaceIds);
  const activeClaudeWorkspaceIds = useAppStore((s) => s.activeClaudeWorkspaceIds);
  const renameWorkspace = useAppStore((s) => s.renameWorkspace);

  const [manualCollapsed, setManualCollapsed] = useState<Set<string>>(
    new Set(),
  );
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [editingWorkspaceId, setEditingWorkspaceId] = useState<string | null>(
    null,
  );
  const [workspaceCreation, setWorkspaceCreation] =
    useState<WorkspaceCreationState | null>(null);
  const [showSlowCreateMessage, setShowSlowCreateMessage] = useState(false);
  const editRef = useRef<string>("");
  const dialogProject = workspaceDialogProjectId
    ? (projects.find((p) => p.id === workspaceDialogProjectId) ?? null)
    : null;
  const isCreatingWorkspace = workspaceCreation !== null;

  useEffect(() => {
    const unsub = window.api.git.onCreateWorktreeProgress(
      (progress: CreateWorktreeProgressEvent) => {
        if (!progress.requestId) return;
        setWorkspaceCreation((prev) => {
          if (!prev || prev.requestId !== progress.requestId) return prev;
          return { ...prev, message: progress.message };
        });
      },
    );
    return unsub;
  }, []);

  useEffect(() => {
    if (!workspaceCreation) {
      setShowSlowCreateMessage(false);
      return;
    }

    setShowSlowCreateMessage(false);
    const timer = setTimeout(() => setShowSlowCreateMessage(true), 5000);
    return () => clearTimeout(timer);
  }, [workspaceCreation?.requestId]);

  const isProjectExpanded = useCallback(
    (id: string) => {
      return !manualCollapsed.has(id);
    },
    [manualCollapsed],
  );

  const toggleProject = useCallback((id: string) => {
    setManualCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAddProject = useCallback(async () => {
    const dirPath = await window.api.app.selectDirectory();
    if (!dirPath) return;

    const name = dirPath.split("/").pop() || dirPath;
    const id = crypto.randomUUID();
    addProjectWithRootWorkspace({ id, name, repoPath: dirPath });
  }, [addProjectWithRootWorkspace]);

  const finishCreateWorkspace = useCallback(
    async (
      project: Project,
      name: string,
      branch: string,
      worktreePath: string,
    ) => {
      const wsId = crypto.randomUUID();
      addWorkspace({
        id: wsId,
        name,
        branch,
        worktreePath,
        projectId: project.id,
      });

      const commands = project.startupCommands ?? [];

      // Pre-trust worktree in Claude Code if any command uses claude
      if (commands.some((c) => c.command.trim().startsWith("claude"))) {
        await window.api.claude.trustPath(worktreePath).catch(() => {});
      }

      if (commands.length === 0) {
        // Default: one blank terminal
        const ptyId = await window.api.pty.create(worktreePath, undefined, {
          AGENT_ORCH_WS_ID: wsId,
        });
        addTab({
          id: crypto.randomUUID(),
          workspaceId: wsId,
          type: "terminal",
          title: "Terminal",
          ptyId,
        });
      } else {
        let firstTabId: string | null = null;
        for (const cmd of commands) {
          const ptyId = await window.api.pty.create(worktreePath, undefined, {
            AGENT_ORCH_WS_ID: wsId,
          });
          const tabId = crypto.randomUUID();
          if (!firstTabId) firstTabId = tabId;
          addTab({
            id: tabId,
            workspaceId: wsId,
            type: "terminal",
            title: cmd.name || cmd.command,
            ptyId,
          });
          // Delay to let shell initialize before writing command
          setTimeout(() => {
            window.api.pty.write(ptyId, cmd.command + "\n");
          }, 500);
        }
        // Activate the first terminal tab
        if (firstTabId) useAppStore.getState().setActiveTab(firstTabId);
      }
    },
    [addWorkspace, addTab],
  );

  const handleCreateWorkspace = useCallback(
    async (
      project: Project,
      name: string,
      branch: string,
      newBranch: boolean,
      force = false,
      baseBranch?: string,
    ) => {
      if (workspaceCreation) return;
      const requestId = crypto.randomUUID();
      setWorkspaceCreation({
        requestId,
        message: "Syncing remote...",
      });

      try {
        const worktreePath = await window.api.git.createWorktree(
          project.repoPath,
          name,
          branch,
          newBranch,
          baseBranch,
          force,
          requestId,
        );
        setWorkspaceCreation((prev) => {
          if (!prev || prev.requestId !== requestId) return prev;
          return { ...prev, message: START_TERMINAL_MESSAGE };
        });
        await finishCreateWorkspace(project, name, branch, worktreePath);
        openWorkspaceDialog(null);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to create workspace";
        const confirmMessages = [
          {
            key: "WORKTREE_PATH_EXISTS",
            title: "Worktree already exists",
            message: `A leftover directory for workspace "${name}" already exists on disk. Replace it?`,
          },
          {
            key: "BRANCH_CHECKED_OUT",
            title: "Branch in use",
            message: `Branch "${branch}" is checked out in another worktree. Remove the old worktree and continue?`,
          },
        ];
        const confirm = confirmMessages.find((c) => msg.includes(c.key));
        if (confirm) {
          showConfirmDialog({
            ...confirm,
            confirmLabel: "Replace",
            destructive: true,
            onConfirm: () => {
              dismissConfirmDialog();
              handleCreateWorkspace(project, name, branch, newBranch, true, baseBranch);
            },
          });
          return;
        }
        addToast({ id: crypto.randomUUID(), message: msg, type: "error" });
      } finally {
        setWorkspaceCreation((prev) => {
          if (!prev || prev.requestId !== requestId) return prev;
          return null;
        });
      }
    },
    [
      workspaceCreation,
      finishCreateWorkspace,
      addToast,
      showConfirmDialog,
      dismissConfirmDialog,
      openWorkspaceDialog,
    ],
  );

  const handleSelectWorkspace = useCallback(
    (wsId: string) => {
      setActiveWorkspace(wsId);
    },
    [setActiveWorkspace],
  );

  const handleDeleteWorkspace = useCallback(
    (e: React.MouseEvent, ws: { id: string; name: string; isRoot?: boolean }) => {
      e.stopPropagation();
      if (ws.isRoot) return;
      if (e.shiftKey) {
        deleteWorkspace(ws.id);
        return;
      }
      showConfirmDialog({
        title: "Delete Workspace",
        message: `Delete workspace "${ws.name}"? This will remove the git worktree from disk.`,
        confirmLabel: "Delete",
        destructive: true,
        onConfirm: () => {
          deleteWorkspace(ws.id);
          dismissConfirmDialog();
        },
      });
    },
    [showConfirmDialog, deleteWorkspace, dismissConfirmDialog],
  );

  const handleDeleteProject = useCallback(
    (e: React.MouseEvent, project: Project) => {
      e.stopPropagation();
      const worktreeCount = workspaces.filter(
        (w) => w.projectId === project.id && !w.isRoot,
      ).length;
      showConfirmDialog({
        title: "Delete Project",
        message: `Delete project "${project.name}"${worktreeCount > 0 ? ` and its ${worktreeCount} worktree workspace${worktreeCount > 1 ? "s" : ""}` : ""}? This will remove all git worktrees from disk.`,
        confirmLabel: "Delete",
        destructive: true,
        onConfirm: () => {
          deleteProject(project.id);
          dismissConfirmDialog();
        },
      });
    },
    [workspaces, showConfirmDialog, deleteProject, dismissConfirmDialog],
  );

  return (
    <div className={styles.sidebar}>
      <div className={styles.titleArea} />

      <div className={styles.projectList}>
        {projects.length === 0 && (
          <div className={styles.emptyState}>
            <span
              style={{
                color: "var(--text-tertiary)",
                fontSize: "var(--text-sm)",
                padding: "0 var(--space-6)",
              }}
            >
              No projects yet. Add a git repository to get started.
            </span>
          </div>
        )}

        {projects.map((project) => {
          const isExpanded = isProjectExpanded(project.id);
          const projectWorkspaces = workspaces
            .filter((w) => w.projectId === project.id)
            .sort((a, b) => (Number(Boolean(b.isRoot)) - Number(Boolean(a.isRoot))));

          return (
            <div key={project.id} className={styles.projectSection}>
              <div
                className={styles.projectHeader}
                onClick={() => toggleProject(project.id)}
              >
                <span
                  className={`${styles.chevron} ${isExpanded ? styles.chevronOpen : ""}`}
                >
                  ▶
                </span>
                <span className={styles.projectName}>{project.name}</span>
                <Tooltip label="Project settings">
                  <button
                    className={styles.settingsBtn}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingProject(project);
                    }}
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
                  {projectWorkspaces.map((ws) => {
                    const isEditing = editingWorkspaceId === ws.id;
                    const isAutoName = /^ws-[a-z0-9]+$/.test(ws.name);
                    const displayName = isAutoName ? ws.branch : ws.name;
                    const showMeta =
                      !isAutoName && ws.branch && ws.branch !== ws.name;

                    return (
                      <div
                        key={ws.id}
                        className={`${styles.workspaceItem} ${
                          ws.id === activeWorkspaceId ? styles.active : ""
                        } ${unreadWorkspaceIds.has(ws.id) ? styles.unread : ""} ${activeClaudeWorkspaceIds.has(ws.id) ? styles.claudeActive : ""} ${ws.isRoot ? styles.rootWorkspace : ""}`}
                        onClick={() =>
                          !isEditing && handleSelectWorkspace(ws.id)
                        }
                        onDoubleClick={() => {
                          editRef.current = displayName;
                          setEditingWorkspaceId(ws.id);
                        }}
                      >
                        <span className={styles.workspaceIcon}>
                          {ws.isRoot ? "~" : ws.automationId ? "⏱" : "⌥"}
                        </span>
                        <div className={styles.workspaceNameCol}>
                          {isEditing ? (
                            <input
                              className={styles.workspaceNameInput}
                              defaultValue={displayName}
                              autoFocus
                              ref={(el) => {
                                if (el) {
                                  el.select();
                                }
                              }}
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.currentTarget.blur();
                                } else if (e.key === "Escape") {
                                  editRef.current = "";
                                  setEditingWorkspaceId(null);
                                }
                              }}
                              onBlur={(e) => {
                                const val = e.currentTarget.value.trim();
                                if (val && val !== ws.name) {
                                  renameWorkspace(ws.id, val);
                                }
                                setEditingWorkspaceId(null);
                              }}
                            />
                          ) : (
                            <span className={styles.workspaceName}>
                              {displayName}
                            </span>
                          )}
                          <WorkspaceMeta
                            projectId={ws.projectId}
                            branch={ws.branch}
                            showBranch={!!showMeta}
                          />
                        </div>
                        {!ws.isRoot && (
                          <Tooltip label="Delete workspace">
                            <button
                              className={styles.deleteBtn}
                              onClick={(e) => handleDeleteWorkspace(e, ws)}
                            >
                              ✕
                            </button>
                          </Tooltip>
                        )}
                      </div>
                    );
                  })}

                  <Tooltip label="New workspace" shortcut="⌘N">
                    <button
                      className={styles.actionButton}
                      onClick={() => openWorkspaceDialog(project.id)}
                      style={{ paddingLeft: "var(--space-4)" }}
                    >
                      <span className={styles.actionIcon}>+</span>
                      <span>New workspace</span>
                    </button>
                  </Tooltip>
                </div>
              )}
            </div>
          );
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
          onConfirm={(name, branch, newBranch, baseBranch) => {
            handleCreateWorkspace(
              dialogProject,
              name,
              branch,
              newBranch,
              false,
              baseBranch,
            );
          }}
          onCancel={() => {
            if (!isCreatingWorkspace) openWorkspaceDialog(null);
          }}
          isCreating={isCreatingWorkspace}
          createProgressMessage={workspaceCreation?.message}
          showSlowCreateMessage={showSlowCreateMessage}
        />
      )}

      {editingProject && (
        <ProjectSettingsDialog
          project={editingProject}
          onSave={(cmds) => {
            updateProject(editingProject.id, { startupCommands: cmds });
            setEditingProject(null);
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
  );
}
