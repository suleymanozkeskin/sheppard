import { expect, test, type Page } from "@playwright/test"

import {
  mockChannels,
  mockHarnesses,
  mockLaunchers,
  mockMembers,
  mockModelCatalogue,
  mockRoles,
  mockWorkspaces,
} from "../src/api/fixtures"
import type { AgentSession } from "../src/api/types"

interface CommandRequest {
  readonly path: string
  readonly body: string
}
const reviewerSession: AgentSession = {
  source: {
    state: "ready",
    harness: "codex",
    sessionPath: "/sessions/review.jsonl",
    glance: "The review is ready. All 18 checks pass.",
    reason: null,
  },
  mapping: { confidence: "exact", candidates: [] },
  nextBefore: null,
  turns: [
    {
      kind: "turn",
      role: "user",
      text: "Review the message delivery changes. Check that a reconnect keeps the same identity and channel memberships.",
      at: "2026-09-24T12:00:00Z",
      tool: null,
      sidechain: false,
    },
    {
      kind: "tool",
      role: "assistant",
      text: "bun test src/identity — 18 tests passed",
      at: "2026-09-24T12:02:00Z",
      tool: { name: "exec_command", outcome: "ok" },
      sidechain: false,
    },
    {
      kind: "turn",
      role: "assistant",
      text: "## Review complete\n\nThe reconnect path keeps the existing identity. Channel memberships and unread cursors do not change.\n\n- Verified reconnect with a stale route.\n- Verified two agents with the same display name.\n- Checked that an unconfirmed send is not repeated.\n\nAll **18 checks pass**. The change is ready for review.",
      at: "2026-09-24T12:04:00Z",
      tool: null,
      sidechain: false,
    },
  ],
}

async function installCommandFixtures(page: Page): Promise<CommandRequest[]> {
  const writes: CommandRequest[] = []
  await page.addInitScript(() => {
    localStorage.setItem("msgr.identity.v1", JSON.stringify({ version: 1, hub: location.origin, handle: "operator" }))
    const original = globalThis.fetch.bind(globalThis)
    globalThis.fetch = (input, init) => {
      const path = new URL(String(input instanceof Request ? input.url : input), location.origin).pathname
      if (path !== "/api/events") return original(input, init)
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode(": ready\n\n"))
              init?.signal?.addEventListener("abort", () => stream.close(), { once: true })
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      )
    }
  })
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const method = route.request().method()
    if (method === "POST") {
      if (path === "/api/humans") {
        await route.fulfill({ json: { handle: "operator" } })
        return
      }
      writes.push({ path, body: route.request().postData() ?? "" })
      if (path === "/api/direct") {
        await route.fulfill({ status: 201, json: { channel: "dm-operator-reviewer", messageId: 101 } })
        return
      }
      if (path === "/api/herdr/agents") {
        await route.fulfill({ status: 201, json: { handle: "new-reviewer", paneId: "new-pane" } })
        return
      }
      await route.fulfill({
        status: 400,
        json: { code: "ValidationFailed", error: "Unexpected write in command test" },
      })
      return
    }
    switch (path) {
      case "/api/channels":
        await route.fulfill({ json: { channels: url.searchParams.get("kind") === "workspace" ? [] : mockChannels } })
        return
      case "/api/direct":
        await route.fulfill({ json: { conversations: [] } })
        return
      case "/api/participants":
        await route.fulfill({ json: { participants: mockMembers } })
        return
      case "/api/inbox":
        await route.fulfill({
          json: { entries: [{ channel: "ops", unread: 0, senders: [], routeState: "active", pushEnabled: true }] },
        })
        return
      case "/api/herdr/workspaces":
        await route.fulfill({ json: { workspaces: mockWorkspaces } })
        return
      case "/api/herdr/roles":
        await route.fulfill({ json: { roles: mockRoles } })
        return
      case "/api/herdr/harnesses":
        await route.fulfill({ json: { harnesses: mockHarnesses } })
        return
      case "/api/herdr/launchers":
        await route.fulfill({ json: { launchers: mockLaunchers } })
        return
      case "/api/herdr/model-catalogue":
        await route.fulfill({ json: mockModelCatalogue })
        return
      default:
        if (path.startsWith("/api/herdr/roles/")) {
          const role = mockRoles.find((item) => item.name === path.split("/").at(-1))
          await route.fulfill({ json: { role } })
          return
        }
        if (path.endsWith("/session")) {
          await route.fulfill({ json: reviewerSession })
          return
        }
        if (path.endsWith("/messages")) {
          await route.fulfill({ json: { messages: [] } })
          return
        }
        if (path.endsWith("/members")) {
          await route.fulfill({ json: { members: mockMembers } })
          return
        }
        if (path.endsWith("/receipts")) {
          await route.fulfill({ json: { receipts: [] } })
          return
        }
        if (path.startsWith("/api/agents/")) {
          const handle = decodeURIComponent(path.slice("/api/agents/".length))
          await route.fulfill({
            json: {
              participant: {
                handle,
                kind: "agent",
                agentKind: "codex",
                role: "reviewer",
                routeState: "active",
                lastSeenAt: null,
              },
              routeState: "active",
              pane: null,
              recentMessageIds: [],
              channels: [
                { channel: "ops", unread: 2 },
                { channel: "reviews", unread: 0 },
              ],
            },
          })
          return
        }
        await route.fulfill({ json: {} })
    }
  })
  return writes
}

test("command menu opens with Cmd+K and keeps input focus while filtering", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await expect(menu).toBeVisible()
  const input = menu.getByRole("combobox", { name: "Search commands and places" })
  await expect(input).toBeFocused()
  await page.screenshot({ path: "/private/tmp/sheppard-command-home.png" })
  await input.pressSequentially("codex-reviewer")
  await expect(input).toHaveValue("codex-reviewer")
  await expect(input).toBeFocused()
  await expect(menu.getByRole("option", { name: /^codex-reviewer/u })).toBeVisible()
  await page.screenshot({ path: "/private/tmp/sheppard-command-dark.png" })
  await input.press("Enter")
  await expect(page).toHaveURL(/\/agents\/codex-reviewer$/u)
  await expect(menu).toBeHidden()
})

test("current agent actions can be found by name", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents/codex-reviewer")
  await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible()
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("focus")
  await expect(menu.getByRole("option", { name: /^Focus terminal/u })).toBeVisible()
})

test("category filters keep the search text and message intent", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("message codex-reviewer")
  await menu.getByRole("button", { name: "Agents", exact: true }).click()
  await expect(menu.getByRole("combobox")).toHaveValue("message codex-reviewer")
  await menu.getByRole("option", { name: /^codex-reviewer/u }).click()
  await expect(menu.getByRole("textbox", { name: "Message codex-reviewer" })).toBeVisible()
})

test("unconfirmed spawn keeps its setup and requires an explicit retry choice", async ({ page }) => {
  await installCommandFixtures(page)
  let attempts = 0
  await page.route("**/api/herdr/agents", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    attempts += 1
    await route.abort("failed")
  })
  await page.setViewportSize({ width: 390, height: 560 })
  await page.goto("/agents/codex-reviewer")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("spawn")
  await menu.getByRole("combobox").press("Enter")
  await menu.getByRole("textbox", { name: "Initial goal" }).fill("Review once.")
  const submit = menu.getByRole("button", { name: "Spawn agent", exact: true })
  await expect(submit).toBeInViewport()
  await page.screenshot({ path: "/private/tmp/sheppard-command-spawn-mobile.png" })
  await submit.click()
  await expect(submit).toBeDisabled()
  await menu.getByRole("button", { name: "Back in command menu" }).click()
  await menu.getByRole("combobox").press("Enter")
  await expect(submit).toBeDisabled()
  await expect(menu.getByRole("textbox", { name: "Initial goal" })).toHaveValue("Review once.")
  expect(attempts).toBe(1)
  await menu.getByRole("button", { name: "I checked; allow another start" }).click()
  await expect(submit).toBeEnabled()
  expect(attempts).toBe(1)
})

test("a failed agent refresh preserves the page and draft", async ({ page }) => {
  await installCommandFixtures(page)
  let reads = 0
  await page.route("**/api/agents/codex-reviewer", async (route) => {
    reads += 1
    if (reads === 1) {
      await route.fallback()
      return
    }
    await route.fulfill({ status: 503, json: { error: "Detail read unavailable" } })
  })
  await page.goto("/agents/codex-reviewer")
  const composer = page.locator("#agent-composer")
  await composer.fill("Keep this message while details refresh.")
  await page.getByRole("link", { name: "Channel activity", exact: true }).click()
  await expect(page.getByRole("alert").filter({ hasText: "could not be refreshed" })).toBeVisible()
  await expect(composer).toHaveValue("Keep this message while details refresh.")
  await expect(page.getByRole("heading", { name: "codex-reviewer", exact: true })).toBeVisible()
})

test("command message stays in the menu and sends only to its named agent", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Control+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("message @codex-reviewer")
  await menu.getByRole("combobox").press("Enter")
  const message = menu.getByRole("textbox", { name: "Message codex-reviewer" })
  await expect(message).toBeVisible()
  await message.fill("Review the current change.")
  await message.press("Enter")
  expect(writes).toHaveLength(0)
  await message.press("Meta+Enter")
  await expect(page.getByRole("status").filter({ hasText: "Message sent to codex-reviewer." })).toBeVisible()
  expect(writes).toEqual([
    { path: "/api/direct", body: JSON.stringify({ to: ["codex-reviewer"], body: "Review the current change." }) },
  ])
})

test("closing and reopening keeps a message draft", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("message @codex-reviewer")
  await menu.getByRole("combobox").press("Enter")
  await menu.getByRole("textbox").fill("Keep this draft.")
  await menu.getByRole("button", { name: "Close command menu", exact: true }).click()
  await expect(menu).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect(menu.getByRole("textbox")).toHaveValue("Keep this draft.")
})

test("target actions stay tied to the selected agent", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("codex-reviewer")
  await menu.getByRole("combobox").press("ArrowRight")
  await expect(menu.getByRole("option", { name: /Message codex-reviewer/ })).toBeVisible()
  await expect(menu.getByRole("option", { name: /Focus terminal/ })).toBeVisible()
  await expect(menu.getByRole("option", { name: /Stop agent/ })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(menu.getByRole("combobox")).toBeVisible()
  await expect(menu.getByRole("combobox")).toHaveValue("codex-reviewer")
  await expect(menu).toBeVisible()
})

test("agent workbench puts the session and composer within reach", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents/codex-reviewer")
  await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible()
  const composer = page.locator("#agent-composer")
  await expect(composer).toBeInViewport()
  await page.screenshot({ path: "/private/tmp/sheppard-agent-workbench-dark.png" })
  await page.getByRole("button", { name: "Message", exact: true }).click()
  await expect(page).toHaveURL(/view=messages/u)
  await expect(composer).toBeFocused()
  await expect(page.getByRole("heading", { name: "Start a direct conversation" })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(composer).toBeInViewport()
  await page.screenshot({ path: "/private/tmp/sheppard-agent-workbench-mobile.png" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("an unconfirmed send stays blocked after Back and reopening", async ({ page }) => {
  await installCommandFixtures(page)
  let attempts = 0
  await page.route("**/api/direct", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    attempts += 1
    await route.abort("failed")
  })
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("message @codex-reviewer")
  await menu.getByRole("combobox").press("Enter")
  await menu.getByRole("textbox").fill("Send this once.")
  await menu.getByRole("textbox").press("Meta+Enter")
  await expect(menu.getByRole("button", { name: /Send message/ })).toBeDisabled()
  await page.keyboard.press("Escape")
  await menu.getByRole("combobox").fill("")
  await menu.getByRole("option", { name: /Resume message to codex-reviewer/ }).click()
  await expect(menu.getByRole("textbox")).toHaveValue("Send this once.")
  await expect(menu.getByRole("button", { name: /Send message/ })).toBeDisabled()
  await menu.getByRole("textbox").press("Meta+Enter")
  expect(attempts).toBe(1)
})

test("spawn setup keeps exact runtime values and survives Back", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents/codex-reviewer")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("Spawn agent")
  await menu.getByRole("combobox").press("Enter")
  await expect(menu.getByRole("heading", { name: "Spawn an agent" })).toBeVisible()
  await expect(menu.locator('[data-combobox="command-launcher"] [data-combobox-value]')).toHaveText("codex")
  await menu.getByRole("combobox", { name: "Model" }).click()
  await page.locator('[data-combobox-option="gpt-5.6-sol"]').click()
  await menu.getByRole("combobox", { name: "Effort" }).click()
  await page.locator('[data-combobox-option="high"]').click()
  await menu.getByRole("textbox", { name: "Handle", exact: true }).fill("reviewer")
  await menu.getByRole("textbox", { name: "Initial goal" }).fill("Review the patch.")
  await page.screenshot({ path: "/private/tmp/sheppard-command-spawn.png" })
  await expect(menu.getByRole("button", { name: "Spawn agent", exact: true })).toBeInViewport()
  await menu.getByRole("button", { name: "Back in command menu" }).click()
  await menu.getByRole("combobox").press("Enter")
  await expect(menu.getByRole("textbox", { name: "Initial goal" })).toHaveValue("Review the patch.")
  await menu.getByRole("button", { name: "Spawn agent", exact: true }).click()
  await expect(page.getByRole("status").filter({ hasText: "Started new-reviewer." })).toBeVisible()
  expect(writes).toEqual([
    {
      path: "/api/herdr/agents",
      body: JSON.stringify({
        handle: "reviewer",
        launcher: "codex",
        workspaceId: "workspace-sheppard",
        role: "worker",
        model: "gpt-5.6-sol",
        effort: "high",
        goal: "Review the patch.",
      }),
    },
  ])
})

test("light and small-screen menus keep keyboard control", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.addInitScript(() => localStorage.setItem("msgr.theme.v1", JSON.stringify({ version: 1, mode: "light" })))
  await page.goto("/agents/codex-reviewer")
  await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible()
  await page.screenshot({ path: "/private/tmp/sheppard-agent-workbench-light.png" })
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const input = menu.getByRole("combobox")
  await input.fill("codex-reviewer")
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true })
  await expect(menu).toBeVisible()
  await page.screenshot({ path: "/private/tmp/sheppard-command-light.png" })
  await page.setViewportSize({ width: 390, height: 844 })
  await input.fill("")
  await page.screenshot({ path: "/private/tmp/sheppard-command-mobile.png" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await input.press("Shift+Tab")
  expect(await menu.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  expect(writes).toHaveLength(0)
})

test("agent page and command menu share one message draft", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents/codex-reviewer")
  const pageComposer = page.locator("#agent-composer")
  await pageComposer.fill("Continue the review.")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("option", { name: /^Message codex-reviewer/u }).click()
  await expect(menu.getByRole("textbox")).toHaveValue("Continue the review.")
  await menu.getByRole("textbox").fill("Continue the review, then report.")
  await menu.getByRole("button", { name: "Close command menu", exact: true }).click()
  await expect(pageComposer).toHaveValue("Continue the review, then report.")
  await pageComposer.press("Meta+Enter")
  await expect(pageComposer).toHaveValue("")
  expect(writes.filter((write) => write.path === "/api/direct")).toHaveLength(1)
})

test("unconfirmed page sends remain blocked in the command menu", async ({ page }) => {
  await installCommandFixtures(page)
  let attempts = 0
  await page.route("**/api/direct", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback()
      return
    }
    attempts += 1
    await route.abort("failed")
  })
  await page.goto("/agents/codex-reviewer")
  await page.locator("#agent-composer").fill("Only once.")
  await page.locator("#agent-composer").press("Meta+Enter")
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled()
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("option", { name: /^Message codex-reviewer/u }).click()
  await expect(menu.getByRole("textbox")).toHaveValue("Only once.")
  await expect(menu.getByRole("button", { name: /Send message/ })).toBeDisabled()
  await menu.getByRole("textbox").press("Meta+Enter")
  expect(attempts).toBe(1)
})

test("a contextual spawn cannot silently reuse another workspace", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.route("**/api/herdr/workspaces", (route) =>
    route.fulfill({
      json: { workspaces: [...mockWorkspaces, { id: "workspace-east", label: "East", panes: [], tabs: [] }] },
    }),
  )
  await page.goto("/agents/codex-reviewer")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("combobox").fill("Spawn agent")
  await menu.getByRole("combobox").press("Enter")
  await menu.getByRole("textbox", { name: "Initial goal" }).fill("Keep this goal.")
  await menu.getByRole("button", { name: "Back in command menu" }).click()
  await menu.getByRole("combobox").fill("East")
  await menu.getByRole("combobox").press("ArrowRight")
  await menu.getByRole("option", { name: /^Spawn agent/u }).click()
  await expect(menu.getByRole("button", { name: "Spawn agent", exact: true })).toBeDisabled()
  await expect(menu.getByText("Your saved setup uses a different workspace.", { exact: false })).toBeVisible()
  await menu.getByRole("button", { name: "Use East", exact: true }).click()
  await expect(menu.locator('[data-combobox="command-workspace"] [data-combobox-value]')).toHaveText("East")
  await expect(menu.getByRole("textbox", { name: "Initial goal" })).toHaveValue("Keep this goal.")
  expect(writes).toHaveLength(0)
})
