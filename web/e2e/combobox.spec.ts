import { expect, test, type Page, type Route } from "@playwright/test"

import { mockChannels, mockMembers, mockMessages } from "../src/api/fixtures"

type JsonValue = boolean | Record<string, JsonValue> | JsonValue[] | null | number | string

async function json(route: Route, value: JsonValue, status = 200): Promise<void> {
  await route.fulfill({ body: JSON.stringify(value), contentType: "application/json", status })
}

function catalogueFixture(status: "ready" | "stale" = "ready"): JsonValue {
  return {
    catalogues: [{
      launcher: "claude-main",
      checkedAt: null,
      executableAvailable: true,
      fetchedAt: null,
      freshUntil: null,
      harness: "claude",
      revision: 1,
      models: [
        { default: true, description: "First alpha device", efforts: [{ default: true, description: "Balanced", name: "medium" }], label: "Shared model", name: "model-one", resolvedModel: null },
        { default: false, description: "Second beta device", efforts: [{ default: true, description: "Fast", name: "low" }], label: "Shared model", name: "model-two", resolvedModel: null },
      ],
      error: status === "stale" ? "The device model catalogue is stale." : null,
      status,
    }],
  }
}

function launcherScopedCatalogueFixture(): JsonValue {
  return {
    catalogues: [
      {
        launcher: "claude-main",
        checkedAt: null,
        executableAvailable: true,
        fetchedAt: null,
        freshUntil: null,
        harness: "claude",
        revision: 1,
        models: [{ default: true, description: "Main launcher model", efforts: [{ default: true, description: "Main balanced effort", name: "main-medium" }], label: "Main model", name: "main-model", resolvedModel: "provider/main-model" }],
        error: null,
        status: "ready",
      },
      {
        launcher: "claude-alt",
        checkedAt: null,
        executableAvailable: true,
        fetchedAt: null,
        freshUntil: null,
        harness: "claude",
        revision: 2,
        models: [{ default: true, description: "Alternate launcher model", efforts: [{ default: true, description: "Alternate careful effort", name: "alt-high" }], label: "Alternate model", name: "alt-model", resolvedModel: "provider/alt-model" }],
        error: null,
        status: "ready",
      },
    ],
  }
}

async function openSpawnPage(page: Page, options: { stale?: boolean; refreshFailure?: boolean; refreshDelayMs?: number; catalogue?: JsonValue; launcherScoped?: boolean } = {}, path = "/agents/new"): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    if (url.pathname === "/api/events") {
      await route.fulfill({ body: ": ready\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: "data: {\"workspaces\":[{\"id\":\"w1\",\"label\":\"Test workspace\",\"panes\":[],\"tabs\":[]}] }\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/herdr/launchers" && method === "GET") {
      const launchers = options.launcherScoped === true
        ? [
          { agentKind: "claude", argv: ["claude"], envKeys: [], name: "claude-main", startTimeoutMs: 35_000 },
          { agentKind: "claude", argv: ["claude"], envKeys: [], name: "claude-alt", startTimeoutMs: 35_000 },
          { agentKind: "codex", argv: ["codex"], envKeys: [], name: "codex-main", startTimeoutMs: 35_000 },
        ]
        : [
        { agentKind: "claude", argv: ["claude"], envKeys: [], name: "claude-main", startTimeoutMs: 35_000 },
        { agentKind: "codex", argv: ["codex"], envKeys: [], name: "codex-main", startTimeoutMs: 35_000 },
        ]
      await json(route, { launchers })
      return
    }
    if (url.pathname === "/api/herdr/roles" && method === "GET") {
      await json(route, { roles: [
        { agentKind: "codex", effort: null, launcher: "codex-main", model: null, name: "worker", summary: "General task worker." },
        { agentKind: "claude", effort: "medium", launcher: "claude-main", model: "model-one", name: "briefed", summary: "Alpha planning role." },
      ] })
      return
    }
    if (url.pathname.startsWith("/api/herdr/roles/") && method === "GET") {
      const name = decodeURIComponent(url.pathname.slice("/api/herdr/roles/".length))
      await json(route, { role: { agentKind: name === "briefed" ? "claude" : "codex", briefing: name === "briefed" ? "A useful briefing." : "", launcher: name === "briefed" ? "claude-main" : "codex-main", model: name === "briefed" ? "model-one" : null, name, summary: "Role summary.", effort: name === "briefed" ? "medium" : null } })
      return
    }
    if (url.pathname === "/api/herdr/model-catalogue" && method === "GET") {
      await json(route, options.catalogue ?? (options.stale === true ? catalogueFixture("stale") : catalogueFixture()))
      return
    }
    if (url.pathname === "/api/herdr/model-catalogue" && method === "POST") {
      if (options.refreshDelayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs))
      if (options.refreshFailure === true) {
        await json(route, { code: "Unavailable", error: "The device model query failed." }, 503)
      } else {
        await json(route, options.catalogue ?? catalogueFixture())
      }
      return
    }
    if (url.pathname === "/api/herdr/agents" && method === "POST") {
      await json(route, { handle: "spawned", paneId: "pane-spawned" })
      return
    }
    if (url.pathname === "/api/channels" && method === "GET") { await json(route, { channels: mockChannels }); return }
    if (url.pathname === "/api/inbox" && method === "GET") { await json(route, { entries: [] }); return }
    if (url.pathname === "/api/direct" && method === "GET") { await json(route, { conversations: [] }); return }
    if (url.pathname === "/api/participants" && method === "GET") { await json(route, { participants: mockMembers }); return }
    if (url.pathname.endsWith("/members") && method === "GET") { await json(route, { members: mockMembers }); return }
    if (url.pathname.endsWith("/messages") && method === "GET") { await json(route, { messages: mockMessages }); return }
    if (url.pathname.startsWith("/api/herdr/")) { await json(route, { workspaces: [{ id: "w1", label: "Test workspace", panes: [], tabs: [] }] }); return }
    await json(route, {})
  })
  await page.addInitScript(() => {
    window.localStorage.setItem("msgr.identity.v1", JSON.stringify({ version: 1, hub: "http://127.0.0.1:4173", handle: "operator" }))
  })
  await page.goto(path)
  await expect(page.locator("[data-spawn-page]")).toBeVisible()
}

async function choose(page: Page, id: string, value: string): Promise<void> {
  await page.locator(`#${id}`).click()
  const option = page.locator(`[data-combobox-option="${value}"]`)
  await expect(option).toBeVisible()
  await option.click()
}

test.describe("SpawnAgentPage", () => {
  test("has no native selects, defaults to worker, and renders the split review layout", async ({ page }) => {
    await openSpawnPage(page)
    await expect(page.locator("select")).toHaveCount(0)
    await expect(page.locator('[data-combobox="spawn-agent-role"] [data-combobox-value]')).toContainText("worker")
    await expect(page.locator('[data-spawn-layout]')).toBeVisible()
    await expect(page.locator('[data-spawn-review-column]')).toBeVisible()
    await expect(page.locator('[data-spawn-review]')).toContainText("Test workspace")
    await expect(page.locator('[data-spawn-review]')).toContainText("worker")
  })

  test("searches role labels and summaries and preserves duplicate model identity", async ({ page }) => {
    await openSpawnPage(page)
    const roleInput = page.locator("#spawn-agent-role")
    await roleInput.click()
    await roleInput.fill("planning")
    await expect(page.locator('[data-combobox-option="briefed"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="worker"]')).toHaveCount(0)
    await page.locator('[data-combobox-option="briefed"]').click()

    const modelInput = page.locator("#spawn-agent-model")
    await modelInput.click()
    await modelInput.fill("Second beta device")
    await expect(page.locator('[data-combobox-option="model-two"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="model-one"]')).toHaveCount(0)
    await modelInput.fill("Shared model")
    await expect(page.locator('[data-combobox-option="model-one"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="model-two"]')).toBeVisible()
  })

  test("supports keyboard selection, query reset, and page Escape", async ({ page }) => {
    await openSpawnPage(page)
    const roleInput = page.locator("#spawn-agent-role")
    await roleInput.click()
    await roleInput.fill("briefed")
    await roleInput.press("ArrowDown")
    await roleInput.press("Enter")
    await expect(page.locator('[data-combobox="spawn-agent-role"] [data-combobox-value]')).toContainText("briefed")

    await roleInput.click()
    await roleInput.fill("worker")
    await roleInput.press("Escape")
    await expect(page.locator('[data-combobox="spawn-agent-role"]')).toHaveAttribute("data-combobox-open", "false")
    await roleInput.click()
    await expect(page.locator('[data-combobox-option="briefed"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="worker"]')).toBeVisible()
    await roleInput.press("Escape")
    await page.keyboard.press("Escape")
    await expect(page).toHaveURL(/\/agents$/)
  })

  test("clears role, harness, launcher, model, and effort dependencies", async ({ page }) => {
    await openSpawnPage(page)
    await choose(page, "spawn-agent-role", "briefed")
    await choose(page, "spawn-agent-model", "model-two")
    await expect(page.locator('[data-combobox="spawn-agent-effort"] [data-combobox-value]')).toContainText("low")
    await choose(page, "spawn-agent-role", "worker")
    await expect(page.locator('[data-combobox="spawn-agent-harness"] [data-combobox-value]')).toContainText("codex")
    await expect(page.locator('[data-combobox="spawn-agent-launcher"] [data-combobox-value]')).toContainText("codex-main")
    await expect(page.locator('[data-spawn-review]')).toContainText("Model")
    await expect(page.locator('[data-spawn-review]')).toContainText("—")
    await choose(page, "spawn-agent-role", "__no_role__")
    await expect(page.locator("#spawn-agent-role")).toHaveValue("No role")
    await choose(page, "spawn-agent-harness", "claude")
    await expect(page.locator('[data-combobox="spawn-agent-launcher"] [data-combobox-value]')).toHaveCount(0)
    await choose(page, "spawn-agent-launcher", "claude-main")
    await expect(page.locator('[data-combobox="spawn-agent-model"] [data-combobox-value]')).toContainText("Shared model")
  })

  test("uses exact model efforts and submits the literal Claude model default", async ({ page }) => {
    await openSpawnPage(page)
    await choose(page, "spawn-agent-role", "briefed")
    await choose(page, "spawn-agent-model", "model-two")
    await page.locator("#spawn-agent-effort").click()
    await expect(page.locator('[data-combobox-option="low"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="medium"]')).toHaveCount(0)
    await expect(page.locator('[data-combobox-option="high"]')).toHaveCount(0)

    const defaultCatalogue: JsonValue = {
      catalogues: [{ checkedAt: null, executableAvailable: true, fetchedAt: null, freshUntil: null, launcher: "claude-main", harness: "claude", error: null, revision: 1, models: [{ default: true, description: "Configured launcher model.", efforts: [], label: "Launcher default", name: "default", resolvedModel: null }], status: "default-only" }],
    }
    const bodies: JsonValue[] = []
    await openSpawnPage(page, { catalogue: defaultCatalogue })
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/herdr/agents" && request.method() === "POST") bodies.push(JSON.parse<JsonValue>(request.postData() ?? "{}"))
    })
    await choose(page, "spawn-agent-role", "briefed")
    await page.locator("#spawn-agent-handle").fill("claude-default")
    await page.getByRole("button", { name: "Spawn agent", exact: true }).click()
    await expect.poll(() => bodies.length).toBe(1)
    const body = bodies[0]
    expect(body).toEqual({ handle: "claude-default", launcher: "claude-main", model: "default", role: "briefed", workspaceId: "w1" })
  })

  test("scopes models and reasoning values to the selected launcher", async ({ page }) => {
    await openSpawnPage(page, { catalogue: launcherScopedCatalogueFixture(), launcherScoped: true })
    await choose(page, "spawn-agent-role", "__no_role__")
    await choose(page, "spawn-agent-harness", "claude")
    await choose(page, "spawn-agent-launcher", "claude-main")
    await choose(page, "spawn-agent-model", "main-model")
    await choose(page, "spawn-agent-effort", "main-medium")

    await choose(page, "spawn-agent-launcher", "claude-alt")
    await expect(page.locator('[data-combobox="spawn-agent-model"] [data-combobox-value]')).not.toContainText("main-model")
    await expect(page.locator('[data-combobox="spawn-agent-effort"] [data-combobox-value]')).not.toContainText("main-medium")
    await page.locator("#spawn-agent-model").click()
    await page.locator("#spawn-agent-model").fill("alt")
    await expect(page.locator('[data-combobox-option="alt-model"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="main-model"]')).toHaveCount(0)
    await page.locator('[data-combobox-option="alt-model"]').click()
    await page.locator("#spawn-agent-effort").click()
    await page.locator("#spawn-agent-effort").fill("alt")
    await expect(page.locator('[data-combobox-option="alt-high"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="main-medium"]')).toHaveCount(0)
  })

  test("keeps the model input enabled for stale refresh errors and exposes Retry", async ({ page }) => {
    await openSpawnPage(page, { refreshFailure: true, stale: true })
    await choose(page, "spawn-agent-role", "briefed")
    await expect(page.locator("#spawn-agent-model")).toBeEnabled()
    await expect(page.getByRole("button", { name: "Retry", exact: true }).last()).toBeVisible()
    await expect(page.locator('[data-spawn-review]')).toContainText("briefed")
  })
})
