import { defineConfig, devices } from '@playwright/test';

const port = process.env.DATABRICKS_APP_PORT || process.env.PORT || '8177';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: process.env.PLAYWRIGHT_WEB_SERVER_COMMAND || 'npm run build && npm run start',
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
