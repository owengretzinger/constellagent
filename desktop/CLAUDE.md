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

**Multiple git worktrees / parallel dev:** Normal `bun run dev` uses the standard `userData` path (projects persist in `constellagent-state.json`). For **isolated** dev (separate profile per checkout), from repo root run **`sh scripts/dev-isolated.sh`** or **`bun run dev-isolated`** (runs that shell script). That only needs the stock `desktop` `dev` script — no extra entries in `desktop/package.json`. Universal fallback (any branch): **`CONSTELLAGENT_ISOLATED_DEV=1 bun run --cwd desktop dev`**. Isolated profiles live under `…/Constellagent/dev-worktree/<hash>/`. Vite uses `strictPort: false` (port 5173, then next free). Optional: `CONSTELLAGENT_VITE_PORT`, `CONSTELLAGENT_RENDERER_PORT` / `CONSTELLAGENT_RENDERER_URL` for `constell` attach. The `constell` helper sets `ELECTRON_RENDERER_URL` when attaching (scans 5173–5190).

After modifying native dependencies: `bun run rebuild`

**Main vs renderer in dev:** Changes under `src/main/` or `src/shared/ipc-channels.ts` require a **full app quit (⌘Q)** and a fresh `bun run dev`. **⌘R / Reload** only reloads the renderer; if you see `No handler registered for 'fs:…'`, the running main process is stale.

## Architecture

Electron app with three processes communicating via IPC:

```
Main Process (Node.js)          Preload (contextBridge)       Renderer (React)
├── pty-manager.ts              └── index.ts                  ├── App.tsx (Allotment layout)
├── git-service.ts                  exposes window.api        ├── store/app-store.ts (Zustand)
├── file-service.ts                 namespaces:               └── components/
├── agentfs-service.ts             git, pty, fs, app, state      Terminal, Editor, Sidebar...
├── context-db.ts (AgentFS)
└── ipc.ts (handler registry)
```

## Context & Storage (AgentFS + Turso libSQL + Cachebro)

Cross-agent **memory** (context history, tool traces, skills metadata) lives in a **per-project embedded Turso database**: `agentfs-sdk` uses Turso’s **`@tursodatabase/database`** (libSQL) against a **local file**, not a remote `libsql://` URL. Same SQL semantics as Turso; persistence is `{project}/.constellagent/{id}.db` (default id `constellagent` → `constellagent.db`).

### AgentFS access pattern (main process)

1. **`getAgentFS(projectDir, sessionId?)`** (`agentfs-service.ts`) — Lazily `AgentFS.open({ id, path })`, dedupes concurrent inits, caches instances in a `Map`. Ensures `.constellagent/` exists, runs schema migration for the `entries` table and indexes, drops legacy FTS5 artifacts (bundled libSQL has no FTS5). Starts a periodic **`PRAGMA wal_checkpoint(TRUNCATE)`** timer so the WAL does not grow without bound.
2. **`agent.getDatabase()`** — Async libSQL API (`prepare` / `run` / `all` / `exec`). Primary structured store: **`entries`** (workspace_id, agent_type, session_id, tool_name, tool_input, file_path, project_head, event_type, tool_response, timestamp). **Search** in the UI is `LIKE` over several columns (no full-text index).
3. **`agent.tools.record(...)`** — AgentFS tool analytics hook; **timestamps are Unix seconds**, not milliseconds. `ContextDb.insert` writes both SQL and `tools.record` (latter best-effort).
4. **`agent.kv`** — Key-value namespace inside the same DB file: `skill:*`, `subagent:*`, and `entry:*` keys for fast recent retrieval (best-effort alongside SQL).

**`ContextDb`** (`context-db.ts`) takes `projectDir`, calls `getAgentFS` internally, and is the façade for inserts, search, recent rows, session metadata, and **markdown context builders** (`buildAgentContext`, `buildGlobalContext`, etc.). **`getContextDb(projectDir)`** in `ipc.ts` memoizes one `ContextDb` per project dir for handlers.

**`SkillsService`** — Files on disk are canonical; **KV** mirrors enabled skills/subagents (`skill:{name}`, `subagent:{name}`) for the app and symlinks expose them to Claude/Cursor/Codex/Gemini dirs.

**External agents / CLI** — Hooks and skills can read **`.constellagent/context/*.md`** (debounced exports from `ContextDb`) and query the same file with **`sqlite3 .constellagent/constellagent.db "…"`** for raw memory.

### Using AgentFS-style search (Turso model vs this repo)

**Turso / AgentFS (product)** — When AgentFS is installed in an **isolated agent environment**, the database can be surfaced as a **POSIX-style tree of virtual files** mapped to tables or records. In that setup, standard **`grep`** on a virtual path, **shell globbing** (e.g. `*.txt`, `user_*`), and **`rg`** across the mounted tree are valid ways to search that filesystem view of the DB.

**Constellagent** — The Electron app uses **`agentfs-sdk` in the main process only**; it does **not** expose a FUSE/virtual mount to the host workspace. Host-side assistants (Cursor, Claude Code in a normal shell, etc.) should treat memory as:

| Intent | Here |
|--------|------|
| **grep** / **rg** | Run on **text exports**: `.constellagent/context/**/*.md` (and `sessions/` if present). Avoid expecting line-oriented matches inside the raw `.db` blob. |
| **glob** | List `.constellagent/*.db`, `.constellagent/context/*.md`, etc., to find shards and exports. |
| **Table / row search** | **`sqlite3`** on `constellagent.db` with `LIKE` / `GLOB` on `entries` (and KV keys if you add queries) — same data the virtual-file story would map, but via SQL on the real libSQL file. |

So: the **grep / glob / rg** story applies **literally** only where AgentFS provides that virtual filesystem; in this repository it applies to **exported markdown + glob discovery**, with **`sqlite3`** for structured grep over the Turso-backed file on disk.

**Cachebro** — CLI-only MCP server (`cachebro serve`) auto-configured in `.claude.json` and `.cursor/mcp.json`. Provides `read_file`, `read_files`, `cache_status`, `cache_clear` tools that return diffs instead of full re-reads (~26% token savings).

No `better-sqlite3` — all SQLite access goes through AgentFS / Turso libSQL.

**IPC pattern**: Renderer calls `window.api.*` methods → preload uses `ipcRenderer.invoke()` / `.send()` → main process handlers in `ipc.ts` delegate to service classes. PTY data flows back via `ipc:data:{ptyId}` events.

**GitHub PR integration**: `github-service.ts` uses the `gh` CLI (same `execFileAsync` pattern as `GitService`) to fetch PR status per branch. Polls every 90s via `usePrStatusPoller` hook. Ephemeral state in Zustand (`prStatusMap`, `ghAvailability`) — not persisted to disk. Degrades silently when `gh` is missing, not authenticated, or repo isn't on GitHub.

**Shared code**: `src/shared/ipc-channels.ts` defines channel name constants used by both main and preload. The `@shared` alias resolves to `src/shared/` across all three processes (configured in `electron-vite.config.ts`). Shared types live in `src/shared/` (e.g., `github-types.ts`).

## State Management

Single Zustand store (`app-store.ts`) with this shape:
- `projects` → `workspaces` → `tabs` (hierarchical ownership)
- Tab types: `terminal` (has ptyId), `file` (has filePath), `diff`, `markdownPreview` (rendered `.md` / `.mdx` via Streamdown)
- **Markdown plans**: Clicking `.md`/`.mdx` in the file tree or quick-open opens a **preview tab** (live reload on disk changes). Right-click → **Open in editor** for Monaco; preview tab toolbar has **Edit**. Cmd/Ctrl+click still opens **split** with the file editor. **Streamdown** uses plugins `@streamdown/code` (Shiki), `@streamdown/mermaid`, `@streamdown/math` (KaTeX), and `@streamdown/cjk`; `MarkdownRenderer` passes **`shikiTheme={['github-dark','github-dark']}`** (context defaults are light+dark). Styling: `global.css` imports `streamdown/styles.css`, `katex/dist/katex.min.css`, **`@import "tailwindcss"` without a class prefix** (v4 `prefix(tw)` breaks Streamdown), `@theme inline` for shadcn semantic colors, **`@custom-variant dark (&:where(.dark, .dark *))`** plus **`class="dark"` on `<html>`** so Shiki’s `dark:*` token utilities apply even when the OS theme is light; **`@source inline(…)`** safelists Streamdown/Shiki arbitrary utilities (minified `node_modules` bundles are not reliably scanned). `MarkdownRenderer.module.css` adds layout/color fallbacks for code blocks, tables, and Mermaid toolbars.
- **Latest plan**: Sidebar **Plans** button opens the newest `.md`/`.mdx` (by mtime) under `.cursor/plans`, `.claude/plans`, `.codex/plans`, or `.gemini/plans` in the active workspace (`FileService.findNewestPlanMarkdown`, IPC `FS_FIND_NEWEST_PLAN`). **⇧⌘M** opens a **plan palette** (`PlanPalette`) with prefix-based search and per-agent filter chips (`FileService.listAgentPlanMarkdowns`, IPC `FS_LIST_AGENT_PLANS`). The palette shows **Built/Not built** pills and optional **codingAgent** label per entry.
- **Plan metadata**: Plans use a `constellagent`-namespaced block inside YAML frontmatter (`constellagent.built`, `constellagent.codingAgent`). Parsed via `plan-meta.ts` (`readPlanMetaPrefix` reads only a 16 KiB prefix for list performance; `writePlanMeta` deep-merges the namespace). IPC: `FS_READ_PLAN_META` (read-only), `FS_UPDATE_PLAN_META` (patch frontmatter), `FS_RELOCATE_AGENT_PLAN` (copy/move between agent plan dirs with collision handling). **MarkdownPreview** toolbar (plan files only) exposes a model dropdown, Build button, and relocate menu. Shared plan-path helpers live in `src/shared/agent-plan-path.ts` (imported from main/renderer via **relative** paths like `../shared/...` so electron-vite’s main bundle resolves them reliably).
- **Plan Build**: The plan preview toolbar has a **harness** selector (Claude / Codex / Gemini / Cursor, or “Match folder”) stored as `constellagent.buildHarness` (null = use the plan file’s directory). The **model** dropdown follows the selected harness (`PLAN_MODEL_PRESETS` in `src/shared/plan-build-command.ts`). **Build** moves the plan into the target harness folder if it is elsewhere (`FS_RELOCATE_AGENT_PLAN` with `move`), retargets the preview tab, then spawns a terminal with the matching CLI (`claude`, `codex`, `gemini`, or `cursor-agent`) and `--model` when applicable. A spinner runs until `onNotifyWorkspace` fires, then `constellagent.built` is set true. Limitation: notify is workspace-level, not plan-correlated; 5-minute spinner timeout as a safety net.
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

### Checkpoint restore (manual)

Main process logs use prefix **`[constellagent:restore-checkpoint]`** when `context.restoreCheckpoint` runs (`ipc.ts`). Watch the terminal where `bun run dev` is running.

**Quick test**

1. Open a **git** project in Constellagent (worktree with `.git/`).
2. Ensure context capture is active (`.constellagent/` exists; agent hooks have run at least once so `entries` have a `project_head` hash).
3. Change the repo: add or edit a file (e.g. create `scratch.txt` with `before`).
4. Open **Context History**, pick an **older** entry that shows a checkpoint hash, click **Restore** and confirm.
5. **Expected logs** (in order): `start` → `resolved` (`objType`, `tree`) → `read-tree --reset done` → `checkout-index` → `clean -fd done` → `verify` (`verified: true` when worktree matches) → `fs-watch notify` (subscriber count ≥ 0) → `ok`.
6. **Expected UI**: toast “Checkpoint restored and verified” (or “verification pending” if trees differ); **Changes** and **file tree** refresh; `scratch.txt` / edits reverted if that file wasn’t in the snapshot.

**Note:** Restore runs against the workspace **worktree path**. If `verified` is false, compare `expectedTree` vs `worktreeTree` in the log (often line endings, `.gitattributes`, or timing); new captures from hooks use `save_checkpoint` in `agent-hooks/shared.sh`.
