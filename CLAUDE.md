# CLAUDE.md

Constellagent — macOS desktop app for running multiple AI agents in parallel with integrated terminal, editor, git, and automation scheduling.

## Repo Structure

Monorepo with root package.json delegating to `desktop/`.

```
constellagent/
├── package.json          # Root scripts (proxy to desktop/)
└── desktop/              # Electron app (all source code lives here)
    ├── src/main/         # Main process: PTY, git, file services, IPC
    ├── src/preload/      # contextBridge (window.api)
    ├── src/renderer/     # React UI (components, store, styles)
    ├── src/shared/       # IPC channel constants (@shared alias)
    ├── e2e/              # Playwright tests
    ├── openspec/         # OpenSpec workflow artifacts
    └── CLAUDE.md         # App-specific architecture, patterns, testing details
```

## Commands

All commands run from repo root via bun:

```bash
bun run dev       # Dev server + Electron
bun run build     # Production build
bun run test      # Playwright e2e tests
bun run rebuild   # Rebuild native modules (node-pty)
bun run dist      # Package signed macOS DMG
```

## Tech Stack

Electron 40 · React 19 · TypeScript (strict) · Zustand · Monaco Editor · xterm.js · node-pty · electron-vite · Playwright · bun

## Git Conventions

- Commit style: `type: description` (e.g. `feat:`, `fix:`, `chore:`)
- Branch from `main`

## Working in This Repo

- **Package manager**: bun (not npm/pnpm/yarn)
- **App details**: See `desktop/CLAUDE.md` for architecture, IPC patterns, state management, key patterns, and testing conventions
- **OpenSpec workflow**: Feature development uses OpenSpec — commands in `desktop/.claude/commands/opsx/`
