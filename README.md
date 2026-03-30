# Constellagent

A macOS desktop app for running multiple AI agents in parallel. Each agent gets its own terminal, editor, and git worktree, all in one window.

<img width="3506" height="2200" alt="image" src="https://github.com/user-attachments/assets/9f055656-c213-4d56-8af4-251bd739ad8b" />

## Features

- Multi-project workspace manager with isolated git worktrees per workspace
- Add local folders as projects, including in-app git initialization for non-repos
- Create workspaces from new branches, existing branches, PR refs, or open GitHub PRs
- Project startup commands that can open and orchestrate multiple terminal tabs on workspace creation
- Full terminal emulator (`xterm.js` + `node-pty`) with persistent PTY state and split panes
- Agent-aware terminals for Claude, Codex, Gemini, and Cursor, including last-session resume flows
- Monaco file editing with markdown preview, diff views, and Quick Open
- File tree with git-aware status styling, split-open actions, and markdown-first preview behavior
- Git changes panel for staging, unstaging, discarding, committing, and inspecting diffs
- Git history graph and commit diff browsing
- GitHub PR badges in the workspace list showing PR state, CI state, approvals, and unresolved comments
- Open-PR browser per project with filtering and one-click "Pull locally" into a new workspace
- Graphite integration for stack detection, stack cloning, and Graphite PR links
- Cron-based automations that create timestamped workspaces and launch agent prompts automatically
- Context history backed by `.constellagent/constellagent.db`, with search, markdown summaries, and checkpoint restore
- Diff annotations for human review comments persisted per worktree
- Plan workflow for agent-written markdown plans, including a searchable plan palette, build status, relocation, and build launch
- MCP server management plus skills and subagent syncing into project agent directories
- Claude/Codex hook configuration for notifications and context capture
- Optional Phone Control integration over iMessage for start/finish notifications and remote control flows
- Keyboard-first UX for Quick Open, tab and workspace switching, pane management, settings, and plan/context panels

## Getting started

Requires macOS and [Bun](https://bun.sh).

```bash
bun run setup
bun run dev
```

For isolated development state per git worktree:

```bash
bun run dev-isolated
```

### `constell` CLI

The app installs a `constell` command globally on first launch (symlinks `desktop/bin/constell` → `/usr/local/bin/constell`). Use it to open Constellagent from any terminal:

```bash
constell .          # Open the current directory
constell ~/project  # Open a specific directory
```

In dev mode, `constell` attaches to an already-running Vite dev server (ports 5173–5190) and launches Electron against it. If no dev server is running, it starts one. You can override the renderer URL:

```bash
CONSTELLAGENT_RENDERER_PORT=5174 constell .
CONSTELLAGENT_RENDERER_URL=http://127.0.0.1:5174 constell .
```

### Build and package

```bash
bun run build     # Production build
bun run dist      # Package as signed macOS DMG
```

### Test

```bash
bun run test      # Playwright e2e tests
```
