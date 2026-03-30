# Constellagent Agent Notes

## Session Context
Check recent shared context before making assumptions:
- `.constellagent/context/` if present for exported markdown summaries
- `.constellagent/sessions/` for session-end summaries
- `.constellagent/constellagent.db` for structured cross-agent history

Some repos may not have exported markdown context files yet. If they are missing, use the database-backed context and the codebase itself.

## Cachebro
Cachebro is pre-configured via `npx cachebro init`. Prefer the Cachebro MCP tools (`read_file`, `read_files`, `cache_status`, `cache_clear`) over raw file reads when possible.

## Repo Map
- `desktop/src/renderer/` React UI: sidebar, terminals, editor, right panel, settings, automations, context history
- `desktop/src/main/` Electron main process services: git, PTY, GitHub, Graphite, automations, context DB, annotations, AgentFS, iMessage, MCP, LSP
- `desktop/src/shared/` shared IPC channels, feature types, git/PR/worktree/automation metadata
- `desktop/e2e/` Playwright coverage for core workflows
- `desktop/CLAUDE.md` deeper app architecture and implementation notes

## Implemented Product Areas
- Project and workspace management: add folders as projects, initialize git repos in-app, create and delete git worktrees, create workspaces from branches or PRs, reorder and rename workspaces, run startup command sets per project
- Terminal and agent orchestration: persistent PTY-backed terminals, split panes, agent detection for Claude/Codex/Gemini/Cursor, unread/activity indicators, session resume, add-to-chat flows, drag files into terminals
- Editor and review tools: Monaco editor, markdown preview, Quick Open, git-aware file tree, working-tree and commit diff viewers, diff annotations, git graph browsing
- Git and PR workflows: stage/unstage/discard/commit, project-level open PR browser, PR status badges with CI and review signals, pull PRs locally into workspaces, provider links for GitHub/Graphite/Devin Review, worktree sync status
- Automations and plans: cron automations that create timestamped workspaces and launch agent prompts, markdown plan palette, plan metadata, plan relocation, build launch from plans
- Context and history: `.constellagent/constellagent.db` activity capture, markdown context exports, recent history/search, checkpoint restore, session metadata
- Settings and integrations: Claude/Codex hook setup, MCP server management, skills/subagent sync, favorite editor/shell preferences, optional iMessage phone control, optional T3 Code tab, optional Graphite stack tooling

## Commands
- `bun run setup` install desktop dependencies and rebuild native modules
- `bun run dev` start Electron + Vite
- `bun run dev-isolated` run with isolated app state per git worktree
- `bun run build` build production bundles
- `bun run test` run Playwright e2e tests
- `bun run dist` package the macOS app

## Documentation Intent
Keep docs aligned with implemented behavior, especially in these areas that are easy to under-document:
- PR and Graphite workflows
- context history and checkpoint restore
- startup-command orchestration and session resume
- plan workflow and diff annotations
- settings-side integrations like MCP, hooks, skills, subagents, and phone control
