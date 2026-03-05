# Cursor Cloud specific instructions

## Overview

Constellagent is a self-contained Electrobun desktop app (no backend services needed). All source lives in `desktop/`. The root `package.json` proxies all scripts to `desktop/`.

## Running the app

- **Dev mode**: `cd desktop && DISPLAY=:1 bunx electrobun dev` (builds bun process and serves the app). On headless Linux, ensure a virtual display is running (xvfb is pre-installed; DISPLAY=:1 is usually available).
- **Build view**: `cd desktop && npx vite build` — builds the React view to `desktop/dist/`.
- **Full build**: `cd desktop && npx vite build && bunx electrobun dev` — builds view + runs the app.
- **HMR mode**: `cd desktop && bun run dev:hmr` — runs Vite dev server + Electrobun concurrently for hot reload.
- dbus/libEGL/X11 errors on Linux are harmless and expected.

## Testing

- Manual testing: Launch the app and interact with it.
- Playwright e2e tests are not yet adapted for Electrobun.

## Lint

- No ESLint configured. TypeScript type checking: `cd desktop && npx tsc --noEmit`.

## Key caveats

- PTY support uses Bun's built-in `Bun.Terminal` API (no native node-pty module needed).
- The app requires `libwebkit2gtk-4.1-dev` and GTK3 dev packages on Linux for the system webview.
- Standard dev commands are documented in the root `CLAUDE.md`.
