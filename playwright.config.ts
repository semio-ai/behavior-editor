import { defineConfig, devices } from "@playwright/test";

/** The port the demo is served on for the suite: not the demo's own, which a person may be using. */
const DEMO_PORT = 5287;

/**
 * The end-to-end suite: the demo in Chromium, on the mock, the Arora device
 * in the page, and a native Arora device the suite starts (`e2e/device`).
 * One worker: the device's bridge serves one editor at a time. Each step waits
 * on what the page states, with timeouts generous enough for a loaded host.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  // The language's wasm glue is an ES module: Node loads it as one, rather
  // than the runner compiling it to CommonJS with the suite.
  build: { external: ["**/wasm/pkg/**"] },
  use: {
    baseURL: `http://localhost:${DEMO_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1500, height: 1000 } } }],
  webServer: {
    command: `npx vite --config demo/vite.config.ts --port ${DEMO_PORT} --strictPort`,
    url: `http://localhost:${DEMO_PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
