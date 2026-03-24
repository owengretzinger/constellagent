// IPC channel constants shared between main and renderer

export const IPC = {
  // Git operations
  GIT_LIST_WORKTREES: 'git:list-worktrees',
  GIT_CREATE_WORKTREE: 'git:create-worktree',
  GIT_CREATE_WORKTREE_FROM_PR: 'git:create-worktree-from-pr',
  GIT_CREATE_WORKTREE_PROGRESS: 'git:create-worktree-progress',
  GIT_REMOVE_WORKTREE: 'git:remove-worktree',
  GIT_GET_STATUS: 'git:get-status',
  GIT_GET_DIFF: 'git:get-diff',
  GIT_GET_FILE_DIFF: 'git:get-file-diff',
  GIT_GET_BRANCHES: 'git:get-branches',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_DISCARD: 'git:discard',
  GIT_COMMIT: 'git:commit',
  GIT_GET_CURRENT_BRANCH: 'git:get-current-branch',
  GIT_GET_DEFAULT_BRANCH: 'git:get-default-branch',
  GIT_SHOW_FILE_AT_HEAD: 'git:show-file-at-head',
  GIT_GET_LOG: 'git:get-log',
  GIT_GET_COMMIT_DIFF: 'git:get-commit-diff',
  GIT_SYNC_ALL_WORKTREES: 'git:sync-all-worktrees',
  GIT_SYNC_PROGRESS: 'git:sync-progress',
  GIT_CHECK_REMOTE_HEAD: 'git:check-remote-head',

  // PTY operations
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_DESTROY: 'pty:destroy',
  PTY_LIST: 'pty:list',
  PTY_REATTACH: 'pty:reattach',
  PTY_DATA: 'pty:data', // prefix for events: `pty:data:{id}`
  PTY_TITLE_CHANGED: 'pty:title-changed',
  PTY_AGENT_DETECTED: 'pty:agent-detected',
  /** Renderer → main: current input line on Enter (xterm often sends only \\r to PTY) */
  PTY_SUGGEST_TAB_TITLE: 'pty:suggest-tab-title',

  // File operations
  FS_GET_TREE: 'fs:get-tree',
  FS_GET_TREE_WITH_STATUS: 'fs:get-tree-with-status',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_DELETE_FILE: 'fs:delete-file',
  FS_WATCH_START: 'fs:watch-start',
  FS_WATCH_STOP: 'fs:watch-stop',
  FS_WATCH_CHANGED: 'fs:watch-changed',
  /** Newest .md/.mdx by mtime under agent plan dirs (e.g. .cursor/plans) */
  FS_FIND_NEWEST_PLAN: 'fs:find-newest-plan',
  /** All plan .md/.mdx files sorted newest-first with agent tag + meta */
  FS_LIST_AGENT_PLANS: 'fs:list-agent-plans',
  /** Read constellagent plan meta from YAML frontmatter (no disk write) */
  FS_READ_PLAN_META: 'fs:read-plan-meta',
  /** Update constellagent-namespaced YAML frontmatter on a plan .md */
  FS_UPDATE_PLAN_META: 'fs:update-plan-meta',
  /** Copy or move a plan file to a different agent's plan directory */
  FS_RELOCATE_AGENT_PLAN: 'fs:relocate-agent-plan',

  // App operations
  APP_SELECT_DIRECTORY: 'app:select-directory',
  APP_ADD_PROJECT_PATH: 'app:add-project-path',
  APP_OPEN_IN_EDITOR: 'app:open-in-editor',
  /** Node os.homedir() — for resolving ~/.claude/plans etc. in the renderer */
  APP_GET_HOME_DIR: 'app:get-home-dir',

  // Claude Code integration
  CLAUDE_TRUST_PATH: 'claude:trust-path',
  CLAUDE_INSTALL_HOOKS: 'claude:install-hooks',
  CLAUDE_UNINSTALL_HOOKS: 'claude:uninstall-hooks',
  CLAUDE_CHECK_HOOKS: 'claude:check-hooks',
  CLAUDE_NOTIFY_WORKSPACE: 'claude:notify-workspace',
  CLAUDE_ACTIVITY_UPDATE: 'claude:activity-update',

  // Codex integration
  CODEX_INSTALL_NOTIFY: 'codex:install-notify',
  CODEX_UNINSTALL_NOTIFY: 'codex:uninstall-notify',
  CODEX_CHECK_NOTIFY: 'codex:check-notify',

  // Automation operations
  AUTOMATION_CREATE: 'automation:create',
  AUTOMATION_UPDATE: 'automation:update',
  AUTOMATION_DELETE: 'automation:delete',
  AUTOMATION_RUN_NOW: 'automation:run-now',
  AUTOMATION_STOP: 'automation:stop',
  AUTOMATION_RUN_STARTED: 'automation:run-started',

  // GitHub operations
  GITHUB_GET_PR_STATUSES: 'github:get-pr-statuses',
  GITHUB_LIST_OPEN_PRS: 'github:list-open-prs',
  GITHUB_RESOLVE_PR: 'github:resolve-pr',

  // LSP operations
  LSP_GET_PORT: 'lsp:get-port',
  LSP_GET_AVAILABLE_LANGUAGES: 'lsp:get-available-languages',

  // Clipboard operations
  CLIPBOARD_SAVE_IMAGE: 'clipboard:save-image',

  // MCP operations
  MCP_LOAD_SERVERS: 'mcp:load-servers',
  MCP_REMOVE_SERVER: 'mcp:remove-server',
  MCP_GET_CONFIG_PATHS: 'mcp:get-config-paths',

  // Context repository
  CONTEXT_REPO_INIT: 'context:repo-init',
  CONTEXT_SEARCH: 'context:search',
  CONTEXT_GET_RECENT: 'context:get-recent',
  CONTEXT_INSERT: 'context:insert',
  CONTEXT_RESTORE_CHECKPOINT: 'context:restore-checkpoint',
  CONTEXT_BUILD_SUMMARY: 'context:build-summary',
  CONTEXT_WAL_CHECKPOINT: 'context:wal-checkpoint',
  CONTEXT_SESSION_CONTEXT: 'context:session-context',
  CONTEXT_SESSION_META_SAVE: 'context:session-meta-save',
  CONTEXT_SESSION_META_GET: 'context:session-meta-get',
  /** Main → renderer: suggest tab title from first Codex UserPrompt in context DB */
  CONTEXT_CODEX_TAB_TITLE_HINT: 'context:codex-tab-title-hint',
  /** Main → renderer: AgentFS ingested new context entries from shell hooks */
  CONTEXT_ENTRIES_UPDATED: 'context:entries-updated',

  // Session
  SESSION_GET_LAST: 'session:get-last',

  // Skills & Subagents
  SKILLS_SCAN: 'skills:scan',
  SKILLS_SYNC: 'skills:sync',
  SKILLS_REMOVE: 'skills:remove',
  SUBAGENTS_SCAN: 'subagents:scan',
  SUBAGENTS_SYNC: 'subagents:sync',
  SUBAGENTS_REMOVE: 'subagents:remove',

  // Skills & Subagents KV persistence (AgentFS-backed)
  SKILLS_KV_SAVE: 'skills:kv-save',
  SKILLS_KV_REMOVE: 'skills:kv-remove',
  SKILLS_KV_LIST: 'skills:kv-list',
  SUBAGENTS_KV_SAVE: 'subagents:kv-save',
  SUBAGENTS_KV_REMOVE: 'subagents:kv-remove',
  SUBAGENTS_KV_LIST: 'subagents:kv-list',

  // App file picker
  APP_SELECT_FILE: 'app:select-file',

  // Annotations (human review comments on diffs)
  ANNOTATION_LOAD: 'annotation:load',
  ANNOTATION_ADD: 'annotation:add',
  ANNOTATION_RESOLVE: 'annotation:resolve',
  ANNOTATION_DELETE: 'annotation:delete',
  ANNOTATION_CHANGED: 'annotation:changed',

  // State persistence
  STATE_SAVE: 'state:save',
  STATE_SAVE_SYNC: 'state:save-sync',
  STATE_LOAD: 'state:load',
} as const
