import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  retries: 0,
  // Run tests serially to avoid multiple Electron windows fighting for focus
  workers: 1,
  projects: [
    {
      name: 'desktop',
    },
  ],
})
