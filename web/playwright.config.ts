import { defineConfig, devices } from "@playwright/test"
import { fileURLToPath } from "node:url"

function portForCheckout(checkoutPath: string): number {
  let hash = 0
  for (const character of checkoutPath) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return 4200 + (hash % 800)
}

const checkoutPath = fileURLToPath(new URL("..", import.meta.url))
const previewPort = portForCheckout(checkoutPath)
const previewUrl = `http://127.0.0.1:${previewPort}`

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI === undefined ? "list" : "line",
  testDir: "./e2e",
  timeout: 20_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: previewUrl,
    permissions: ["clipboard-read", "clipboard-write"],
    trace: "retain-on-failure",
  },
  webServer: {
    // Build before serving: the preview server happily serves whatever dist is
    // on disk, so a run that skips the build reports a fixed defect as live.
    // Three such diagnoses cost an evening; vite only rebuilds what changed.
    command: `bun run build && bun run preview --host 127.0.0.1 --port ${previewPort}`,
    reuseExistingServer: false,
    timeout: 30_000,
    url: previewUrl,
  },
})
