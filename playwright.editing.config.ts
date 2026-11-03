import { defineConfig } from '@playwright/test'

// These browser workflows use disposable guest notebooks only. Test the actual
// production bundle without a testnet, signaling server or development imports.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['notebook-tools.spec.ts', 'visual-enhancements.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4174', headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', use: { browserName: 'firefox' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
  },
})
