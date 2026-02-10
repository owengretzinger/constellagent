# Constellagent

A macOS desktop app for running multiple AI agents in parallel. Each agent gets its own terminal, editor, and git worktree, all in one window.

<img width="3506" height="2200" alt="image" src="https://github.com/user-attachments/assets/9f055656-c213-4d56-8af4-251bd739ad8b" />

## Features

- Run separate agent sessions side-by-side, each in its own workspace with an isolated git worktree
- Full terminal emulator (ghostty-web + node-pty)
- Monaco code editor with syntax highlighting and diffs
- Git staging, committing, branching, and worktree management
- File tree navigation
- Cron-based automation scheduling
- Keyboard-driven - Quick Open, tab switching, shortcuts

## Getting started

Requires macOS and [Bun](https://bun.sh).

```bash
bun install
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
