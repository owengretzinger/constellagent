# Cursor Cloud specific instructions

## Overview

Constellagent is a self-contained Electrobun desktop app (no backend services needed). All source lives in `desktop/`. The root `package.json` proxies all scripts to `desktop/`.

## Running the app

- **Dev mode**: `DISPLAY=:1 bun run dev` from repo root (starts Vite + Electrobun).
- **Build**: `bun run build`.

## Testing

- **E2e tests**: `CI_TEST=1 xvfb-run --auto-servernum bun run test` — runs Playwright tests serially.
- Single test: `cd desktop && CI_TEST=1 xvfb-run --auto-servernum bunx playwright test e2e/<file>.spec.ts`
- Playwright browsers are installed via `npx playwright install --with-deps`.

## Lint

- No ESLint configured. TypeScript type checking: `cd desktop && npx tsc --noEmit`.

## Key caveats

- If native modules break, run `bun run rebuild` from repo root.
- Standard dev commands are documented in the root `CLAUDE.md`.
