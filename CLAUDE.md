# CLAUDE.md

Constellagent — desktop app for running multiple AI agents in parallel with integrated terminal, editor, git, and automation scheduling.

## Repo Structure

Monorepo with root package.json delegating to `desktop/`.

```
constellagent/
├── package.json          # Root scripts (proxy to desktop/)
└── desktop/              # Electrobun app (all source code lives here)
    ├── src/main/         # Bun main process: PTY, git, file services, IPC bridge
    ├── src/preload/      # renderer bridge (window.api)
    ├── src/renderer/     # React UI (components, store, styles)
    ├── src/shared/       # IPC channel constants (@shared alias)
    ├── e2e/              # Playwright tests
    ├── openspec/         # OpenSpec workflow artifacts
    └── CLAUDE.md         # App-specific architecture, patterns, testing details
```

## Commands

All commands run from repo root via bun:

```bash
bun run dev       # Vite HMR + Electrobun
bun run build     # Production build
bun run test      # Playwright e2e tests
bun run rebuild   # Native module recovery helper
```

## Tech Stack

Electrobun · React 19 · TypeScript (strict) · Zustand · Monaco Editor · xterm.js · node-pty · Vite · Playwright · bun

## Git Conventions

- Commit style: `type: description` (e.g. `feat:`, `fix:`, `chore:`)
- Branch from `main`

## Working in This Repo

- **Package manager**: bun (not npm/pnpm/yarn)
- **App details**: See `desktop/CLAUDE.md` for architecture, IPC patterns, state management, key patterns, and testing conventions
- **OpenSpec workflow**: Feature development uses OpenSpec — commands in `desktop/.claude/commands/opsx/`
