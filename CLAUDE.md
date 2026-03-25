# Constellagent Cross-Agent Context

## Session & Activity Context
Read these files to see what other agents (and you) have been doing recently:
- `.constellagent/context/sliding-window.md` — Compact table of last 20 agent actions across all agents
- `.constellagent/context/agent-context.md` — Rich context summary (files touched, tool details, activity timeline)
- `.constellagent/sessions/` — Session-end summaries with timestamps

## Cachebro (MCP — auto-configured)
Cachebro is pre-configured via `npx cachebro init`. Use the cachebro MCP tools (`read_file`, `read_files`, `cache_status`, `cache_clear`) instead of raw file reads to save tokens.

Monorepo with root package.json delegating to `desktop/`.

```
constellagent/
├── package.json          # Root scripts (proxy to desktop/)
├── scripts/              # e.g. dev-isolated.sh (parallel worktree dev)
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
bun run dev                 # Dev server + Electron
bun run dev-isolated        # Isolated app data per checkout (see scripts/dev-isolated.sh)
# Any worktree, no new package scripts: CONSTELLAGENT_ISOLATED_DEV=1 bun run --cwd desktop dev
bun run build     # Production build
bun run test      # Playwright e2e tests
bun run rebuild   # Rebuild native modules (node-pty)
bun run dist      # Package signed macOS DMG
```

## Tech Stack

Electron 40 · React 19 · TypeScript (strict) · Zustand · Monaco Editor · xterm.js · node-pty · AgentFS (Turso libSQL embedded via `agentfs-sdk`) · Cachebro · electron-vite · Playwright · bun

## Git Conventions

- Commit style: `type: description` (e.g. `feat:`, `fix:`, `chore:`)
- Branch from `main`

## Working in This Repo

- **Package manager**: bun (not npm/pnpm/yarn)
- **App details**: See `desktop/CLAUDE.md` for architecture, IPC patterns, state management, key patterns, and testing conventions
- **OpenSpec workflow**: Feature development uses OpenSpec — commands in `desktop/.claude/commands/opsx/`

## Context Database
Agent tool calls and activity are recorded in `.constellagent/constellagent.db` (libSQL/SQLite via AgentFS).
The `entries` table stores: workspace_id, agent_type, session_id, tool_name, tool_input, file_path, tool_response, timestamp.
