import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4174', headless: true, trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'node scripts/collaboration-signaling.mjs',
      url: 'http://127.0.0.1:4444/health',
      env: { COLLABORATION_SIGNALING_ORIGINS: 'http://127.0.0.1:4174' },
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 4174 --strictPort',
      url: 'http://127.0.0.1:4174',
      env: { VITE_PUBKY_TESTNET: 'true', VITE_PUBKY_TESTNET_HOST: '127.0.0.1', VITE_COLLAB_SIGNAL_URL: process.env.COLLAB_E2E_SIGNAL_URL ?? 'ws://127.0.0.1:4444' },
      reuseExistingServer: false,
    },
  ],
})
