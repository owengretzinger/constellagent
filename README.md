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
- Keyboard-driven - Quick Open, tab switching, shortcuts

## Getting started

Requires macOS and [Bun](https://bun.sh).

```bash
bun run setup
bun run dev
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
