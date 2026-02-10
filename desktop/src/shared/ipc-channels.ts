// IPC channel constants shared between main and renderer

export const IPC = {
  // Git operations
  GIT_LIST_WORKTREES: 'git:list-worktrees',
  GIT_CREATE_WORKTREE: 'git:create-worktree',
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

  // PTY operations
  PTY_CREATE: 'pty:create',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_DESTROY: 'pty:destroy',
  PTY_LIST: 'pty:list',
  PTY_REATTACH: 'pty:reattach',
  PTY_DATA: 'pty:data', // prefix for events: `pty:data:{id}`

  // File operations
  FS_GET_TREE: 'fs:get-tree',
  FS_GET_TREE_WITH_STATUS: 'fs:get-tree-with-status',
  FS_READ_FILE: 'fs:read-file',
  FS_WRITE_FILE: 'fs:write-file',
  FS_WATCH_START: 'fs:watch-start',
  FS_WATCH_STOP: 'fs:watch-stop',
  FS_WATCH_CHANGED: 'fs:watch-changed',

  // App operations
  APP_SELECT_DIRECTORY: 'app:select-directory',
  APP_ADD_PROJECT_PATH: 'app:add-project-path',
  APP_GET_DATA_PATH: 'app:get-data-path',

  // Claude Code integration
  CLAUDE_TRUST_PATH: 'claude:trust-path',
  CLAUDE_INSTALL_HOOKS: 'claude:install-hooks',
  CLAUDE_UNINSTALL_HOOKS: 'claude:uninstall-hooks',
  CLAUDE_CHECK_HOOKS: 'claude:check-hooks',
  CLAUDE_NOTIFY_WORKSPACE: 'claude:notify-workspace',
  CLAUDE_ACTIVITY_UPDATE: 'claude:activity-update',

  // Automation operations
  AUTOMATION_CREATE: 'automation:create',
  AUTOMATION_UPDATE: 'automation:update',
  AUTOMATION_DELETE: 'automation:delete',
  AUTOMATION_LIST: 'automation:list',
  AUTOMATION_RUN_NOW: 'automation:run-now',
  AUTOMATION_STOP: 'automation:stop',
  AUTOMATION_RUN_STARTED: 'automation:run-started',

  // GitHub operations
  GITHUB_GET_PR_STATUSES: 'github:get-pr-statuses',

  // State persistence
  STATE_SAVE: 'state:save',
  STATE_LOAD: 'state:load',
} as const
