# Cursor Cloud specific instructions

## Overview

Constellagent is a self-contained Electron desktop app (no backend services needed). All source lives in `desktop/`. The root `package.json` proxies all scripts to `desktop/`.

## Running the app

- **Dev mode**: `DISPLAY=:1 bun run dev` from repo root (starts electron-vite dev server + Electron). On headless Linux, ensure a virtual display is running (xvfb is pre-installed; DISPLAY=:1 is usually available).
- **Build**: `bun run build` — builds to `desktop/out/`.
- dbus errors on Linux are harmless and expected.

## Testing

- **E2e tests**: `CI_TEST=1 xvfb-run --auto-servernum bun run test` — runs Playwright Electron tests serially.
- Single test: `cd desktop && CI_TEST=1 xvfb-run --auto-servernum bunx playwright test e2e/<file>.spec.ts`
- Playwright browsers are installed via `npx playwright install --with-deps`.

## Lint

- No ESLint configured. TypeScript type checking: `cd desktop && npx tsc --noEmit`.

## Key caveats

- `node-pty` must be compiled for the Electron Node ABI. `bun install` triggers `postinstall` which runs `bunx electron-rebuild`. If native modules break, run `bun run rebuild` from repo root.
- The `postinstall` also runs `patch-electron-dev.sh` which patches Electron.app icon/name on macOS; it exits cleanly on Linux via an explicit platform guard.
- Standard dev commands are documented in the root `CLAUDE.md`.
