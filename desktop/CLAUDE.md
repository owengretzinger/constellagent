# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run dev          # Start dev server + Electron app
bun run build        # Production build to out/
bun run test         # Run Playwright e2e tests (all)
bunx playwright test e2e/tabs.spec.ts              # Single test file
bunx playwright test --grep "creates terminal"     # Single test by name
bun run rebuild      # Rebuild native modules (node-pty) for Electron
```

After modifying native dependencies: `bun run rebuild`

## Architecture

Electron app with three processes communicating via IPC:

```
Main Process (Node.js)          Preload (contextBridge)       Renderer (React)
├── pty-manager.ts              └── index.ts                  ├── App.tsx (Allotment layout)
├── git-service.ts                  exposes window.api        ├── store/app-store.ts (Zustand)
├── file-service.ts                 namespaces:               └── components/
└── ipc.ts (handler registry)      git, pty, fs, app, state      Terminal, Editor, Sidebar...
```

**IPC pattern**: Renderer calls `window.api.*` methods → preload uses `ipcRenderer.invoke()` / `.send()` → main process handlers in `ipc.ts` delegate to service classes. PTY data flows back via `ipc:data:{ptyId}` events.

**GitHub PR integration**: `github-service.ts` uses the `gh` CLI (same `execFileAsync` pattern as `GitService`) to fetch PR status per branch. Polls every 90s via `usePrStatusPoller` hook. Ephemeral state in Zustand (`prStatusMap`, `ghAvailability`) — not persisted to disk. Degrades silently when `gh` is missing, not authenticated, or repo isn't on GitHub.

**Shared code**: `src/shared/ipc-channels.ts` defines channel name constants used by both main and preload. The `@shared` alias resolves to `src/shared/` across all three processes (configured in `electron-vite.config.ts`). Shared types live in `src/shared/` (e.g., `github-types.ts`).

## State Management

Single Zustand store (`app-store.ts`) with this shape:
- `projects` → `workspaces` → `tabs` (hierarchical ownership)
- Tab types: `terminal` (has ptyId), `file` (has filePath), `diff`
- UI state: activeWorkspaceId, activeTabId, panel visibility, settings
- Auto-persists to disk via debounced IPC (500ms) to `~/.userData/constellagent-state.json`
- Exposed as `window.__store` in dev for e2e testing

## Key Patterns

**Terminal lifecycle**: xterm terminals are rendered with `visibility:hidden` when inactive (not unmounted) to preserve scrollback and TUI state. PTY processes live in main process via node-pty.

**Capture-phase keyboard shortcuts**: terminal input can consume keydown events before global handlers run. All global shortcuts in `useShortcuts.ts` must use capture phase (`addEventListener('keydown', handler, true)`) and call `stopPropagation()` on consumed shortcuts.

**Shift+Enter workaround**: the shortcuts hook intercepts Shift+Enter and writes `\x1b[13;2u` (kitty keyboard protocol) directly to PTY so CLIs like Claude Code can distinguish new-line from submit.

**Monaco in Allotment**: Pane children need `height: 100%` (not flex) and `position: absolute; inset: 0` within a `position: relative` parent to size correctly.

## Testing

E2e tests use Playwright's `_electron` adapter. Key conventions:
- `CI_TEST=1` env var suppresses `mainWindow.show()` and redirects `userData` to a temp directory (tests never touch real app state)
- Tests reset store state at start: `store.hydrateState({ projects: [], workspaces: [] })`
- Tests create temp git repos in `/tmp`, use `realpathSync()` for macOS symlink resolution
- `contextBridge` freezes `window.api` — can't spy on methods, test behavior indirectly
- CSS modules mangle class names — use `[class*="specificName"]` selectors
- Tests run serially (`workers: 1`) due to window focus dependencies
