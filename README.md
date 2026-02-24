# Constellagent

A macOS desktop app for running multiple AI agents in parallel. Each agent gets its own terminal, editor, and git worktree, all in one window.

<img width="3506" height="2200" alt="image" src="https://github.com/user-attachments/assets/9f055656-c213-4d56-8af4-251bd739ad8b" />

## Features

- Run separate agent sessions side-by-side, each in its own workspace with an isolated git worktree
- Full terminal emulator (`xterm.js` + node-pty)
- Monaco code editor with syntax highlighting and diffs
- Git staging, committing, branching, and worktree management
- File tree navigation
- Cron-based automation scheduling
- Sleep/wake recovery for automations (coalesces missed runs while app stays open)
- Keyboard-driven - Quick Open, tab switching, shortcuts

## Getting started

Requires macOS and [Bun](https://bun.sh).

```bash
bun run setup
bun run dev
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

### Remote SSH projects

You can add repositories over SSH with the new **Add remote** button in the sidebar.

- Enter your SSH host alias (for example `mini`, from `~/.ssh/config`)
- Enter an absolute remote repo path (for example `/Users/yigitkonur/dev/my-saas`)
- Constellagent stores it as `ssh://host/path` and runs terminal, git, and file operations over SSH

Notes:
- Auto file watching is local-only; remote trees refresh on tab activation and git/file actions.
- Creating worktrees on SSH remotes skips `.env` file copy.

Automation scheduling notes:
- If the laptop sleeps during a scheduled time while the app is still running, Constellagent runs one catch-up execution on wake.
- If the app is fully quit, missed runs are not backfilled on next launch.
