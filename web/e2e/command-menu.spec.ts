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

test("menu arrows work from categories and return to result navigation", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents/codex-reviewer")
  await page.getByRole("button", { name: "Open command menu", exact: true }).last().click()
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const input = menu.getByRole("combobox")
  await expect(input).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(menu.getByRole("button", { name: "All", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowRight")
  const agents = menu.getByRole("button", { name: "Agents", exact: true })
  await expect(agents).toBeFocused()
  await expect(agents).toHaveAttribute("aria-pressed", "true")
  await page.keyboard.press("ArrowDown")
  await expect(input).toBeFocused()
  await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("ArrowDown")
  await expect(menu.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("ArrowUp")
  await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Enter")
  await expect(menu).toBeHidden()
})

test("typing and arrows still work after a category click", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await menu.getByRole("button", { name: "Agents", exact: true }).click()
  await page.keyboard.type("reviewer")
  await expect(menu.getByRole("combobox")).toHaveValue("reviewer")
  await expect(menu.getByRole("combobox")).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowUp")
  await expect(menu.getByRole("combobox")).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/agents\/codex-reviewer$/u)
})

test("keyboard-only categories show their keys and connect to the first result", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  await expect(search).toBeFocused()
  await expect(menu.locator(".command-category-enter")).toHaveText("Tab/↑Categories")
  await expect(search).toHaveAccessibleDescription(/Tab moves to categories/u)
  await page.keyboard.press("Tab")
  const categories = menu.getByRole("toolbar", { name: "Filter commands" })
  await expect(categories.getByRole("button", { name: "All", exact: true })).toBeFocused()
  await expect(menu.locator(".command-category-move")).toBeVisible()
  await expect(menu.getByText("Type to search", { exact: true })).toBeVisible()
  await expect(menu.locator(".command-footer > .command-hint").first()).toBeHidden()
  for (const name of ["Agents", "Channels", "Workspaces", "Actions", "All"]) {
    await page.keyboard.press("ArrowRight")
    const category = categories.getByRole("button", { name, exact: true })
    await expect(category).toBeFocused()
    await expect(category).toHaveAttribute("aria-pressed", "true")
  }
  await page.keyboard.press("ArrowLeft")
  await expect(categories.getByRole("button", { name: "Actions", exact: true })).toBeFocused()
  await page.keyboard.press("Home")
  await expect(categories.getByRole("button", { name: "All", exact: true })).toBeFocused()
  await page.keyboard.press("End")
  await expect(categories.getByRole("button", { name: "Actions", exact: true })).toBeFocused()
  await page.keyboard.press("Home")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Enter")
  await expect(search).toBeFocused()
  await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("ArrowUp")
  await expect(categories.getByRole("button", { name: "Agents", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(search).toBeFocused()
  await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Enter")
  await expect(menu).toBeHidden()
  await expect(page).toHaveURL(/\/agents\//u)
  expect(writes).toEqual([])
})

test("keyboard-only categories remain reachable with no matches and preserve the search", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Control+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  await expect(search).toBeFocused()
  await page.keyboard.type("message no-matching-name")
  await page.keyboard.press("ArrowUp")
  const categories = menu.getByRole("toolbar")
  await expect(categories.getByRole("button", { name: "All", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowRight")
  await expect(search).toHaveValue("message no-matching-name")
  await expect(menu.getByText("No matching items")).toBeVisible()
  await page.keyboard.press("ArrowDown")
  await expect(search).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(categories.getByRole("button", { name: "Agents", exact: true })).toBeFocused()
  await page.keyboard.press("Shift+Tab")
  await expect(search).toBeFocused()
  await page.keyboard.press("ControlOrMeta+a")
  await page.keyboard.type("reviewer")
  await page.keyboard.press("Tab")
  await page.keyboard.press("Shift+ArrowRight")
  await expect(categories.getByRole("button", { name: "Agents", exact: true })).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await expect(search).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/\/agents\/codex-reviewer$/u)
})

test("keyboard-only recipient categories keep message intent and the Back path", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  await expect(search).toBeFocused()
  await page.keyboard.type(">send")
  await page.keyboard.press("Enter")
  await expect(search).toHaveAttribute("placeholder", "Find a person or channel…")
  await page.keyboard.press("Tab")
  await page.keyboard.press("ArrowLeft")
  await expect(menu.getByRole("button", { name: "Actions", exact: true })).toBeFocused()
  await expect(menu.getByRole("button", { name: "Back in command menu" })).toBeVisible()
  await page.keyboard.press("Home")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.type("codex-reviewer")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("codex-reviewer")
  await page.keyboard.press("Enter")
  const message = menu.getByRole("textbox", { name: "Message codex-reviewer" })
  await expect(message).toBeFocused()
  await page.keyboard.type("Keep this recipient draft.")
  await page.keyboard.press("Escape")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("codex-reviewer")
  await page.keyboard.press("Tab")
  await expect(menu.getByRole("button", { name: "Agents", exact: true })).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(search).toHaveValue(">send")
  expect(writes).toEqual([])
})

test("keyboard-only category keys and focus stay visible in a narrow window", async ({ page }) => {
  await installCommandFixtures(page)
  await page.setViewportSize({ width: 320, height: 568 })
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await expect(menu.getByRole("combobox")).toBeFocused()
  await expect(menu.locator(".command-category-enter")).toBeInViewport()
  await page.screenshot({ path: "/private/tmp/sheppard-categories-mobile-search.png" })
  await page.keyboard.press("Tab")
  const categories = menu.getByRole("toolbar")
  for (const name of ["Agents", "Channels", "Workspaces", "Actions", "All"]) {
    await page.keyboard.press("ArrowRight")
    const category = categories.getByRole("button", { name, exact: true })
    await expect(category).toBeFocused()
    await expect(category).toBeInViewport({ ratio: 1 })
  }
  await expect(menu.locator(".command-category-move")).toBeInViewport({ ratio: 1 })
  expect(await menu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: "/private/tmp/sheppard-categories-mobile-focused.png" })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.screenshot({ path: "/private/tmp/sheppard-categories-desktop-focused.png" })
  await page.keyboard.press("ArrowDown")
  await expect(menu.getByRole("combobox")).toBeFocused()
  await page.screenshot({ path: "/private/tmp/sheppard-categories-desktop-search.png" })
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

const KEYBOARD_TAB_LIMIT = 40

/** Moves actual keyboard focus. Fails if a control cannot be reached without a mouse. */
async function tabTo(page: Page, target: ReturnType<Page["locator"]>): Promise<void> {
  for (let count = 0; count < KEYBOARD_TAB_LIMIT; count += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press("Tab")
  }
  await expect(target).toBeFocused()
}

test("keyboard-only nested history returns through every parent with its selection and draft", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox", { name: "Search commands and places" })
  await expect(search).toBeFocused()
  await page.keyboard.type(">send")
  await page.keyboard.press("Enter")
  await expect(search).toHaveAttribute("placeholder", "Find a person or channel…")
  await page.keyboard.type("codex-reviewer")
  await page.keyboard.press("ArrowRight")
  await expect(search).toHaveAttribute("placeholder", "Find an action…")
  await page.keyboard.type("message")
  await page.keyboard.press("Enter")
  const message = menu.getByRole("textbox", { name: "Message codex-reviewer" })
  await expect(message).toBeFocused()
  await page.keyboard.type("Keep this draft.")
  await page.keyboard.press("ArrowLeft")
  await expect(message).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("message")
  await expect(menu.getByRole("option", { selected: true })).toContainText("Message codex-reviewer")
  await page.keyboard.press("Enter")
  await expect(message).toHaveValue("Keep this draft.")
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await expect(search).toHaveAttribute("placeholder", "Find a person or channel…")
  await expect(search).toHaveValue("codex-reviewer")
  await expect(menu.getByRole("option", { selected: true })).toContainText("codex-reviewer")
  await page.keyboard.press("Escape")
  await expect(search).toHaveValue(">send")
  await page.keyboard.press("Escape")
  await expect(menu).toBeHidden()
  expect(writes).toEqual([])
})

test("keyboard-only back works from child searches, chrome, and empty results", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  await expect(search).toBeFocused()
  await page.keyboard.type("codex-reviewer")
  await page.keyboard.press("ArrowRight")
  await search.dispatchEvent("keydown", { key: "Escape", isComposing: true })
  await expect(search).toHaveAttribute("placeholder", "Find an action…")
  await expect(menu.getByRole("button", { name: "Back in command menu" })).toContainText("← / Esc")
  await page.screenshot({ path: "/private/tmp/sheppard-command-navigation-desktop.png" })
  await page.setViewportSize({ width: 390, height: 650 })
  await expect(menu.getByRole("button", { name: "Back in command menu" })).toBeInViewport()
  await page.screenshot({ path: "/private/tmp/sheppard-command-navigation-mobile.png" })
  await page.keyboard.press("ArrowLeft")
  await expect(search).toHaveValue("codex-reviewer")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Backspace")
  await expect(search).toHaveValue("codex-reviewer")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.type("no-such-action")
  await expect(menu.getByRole("button", { name: "Back in command menu" })).toHaveText("Back Esc")
  await expect(menu.getByText("No matching items")).toBeVisible()
  await page.keyboard.press("ArrowLeft")
  await expect(search).toHaveValue("no-such-action")
  await page.keyboard.press("Escape")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("Shift+Tab")
  await expect(menu.getByRole("button", { name: "Back in command menu" })).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(search).toBeFocused()
  await expect(menu.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true")
  await page.keyboard.press("Shift+Tab")
  await page.keyboard.type("message")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("message")
  await page.keyboard.press("Escape")
  await expect(search).toHaveValue("codex-reviewer")
})

test("keyboard-only fast opening keeps the first search character", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  await page.keyboard.type("codex-reviewer")
  await expect(page.getByRole("dialog", { name: "Sheppard command menu" }).getByRole("combobox")).toHaveValue(
    "codex-reviewer",
  )
})

test("keyboard-only immediate typing and Tab work during repeated open transitions", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  const openingChecks = 12
  for (let attempt = 0; attempt < openingChecks; attempt += 1) {
    await page.keyboard.press("Meta+k")
    await page.keyboard.type("reviewer")
    await expect(search).toHaveValue("reviewer")
    await page.keyboard.press("ControlOrMeta+a")
    await page.keyboard.press("Backspace")
    await page.keyboard.press("Escape")
    await page.keyboard.press("Control+k")
    await page.keyboard.press("Tab")
    await expect(menu.getByRole("button", { name: "All", exact: true })).toBeFocused()
    await page.keyboard.press("Escape")
  }
})

test("keyboard-only close returns page control without an animation delay", async ({ page }) => {
  await installCommandFixtures(page)
  await page.goto("/agents/codex-reviewer")
  await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible()
  await page.keyboard.press("Meta+k")
  await page.keyboard.type("reviewer")
  await page.keyboard.press("Escape")
  await page.keyboard.press("c")
  await expect(page.getByRole("textbox", { name: "Direct message to codex-reviewer" })).toBeFocused()
  await page.keyboard.press("Meta+k")
  await expect(page.getByRole("dialog", { name: "Sheppard command menu" }).getByRole("combobox")).toHaveValue("reviewer")
})

test("keyboard-only channel actions return from members without losing the selected action", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.route("**/api/channels/ops/members", (route) =>
    route.request().method() === "GET" ? route.fulfill({ json: { members: [] } }) : route.fallback(),
  )
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  await expect(search).toBeFocused()
  await page.keyboard.type("#ops")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowDown")
  await expect(menu.getByRole("option", { selected: true })).toContainText("Manage members")
  await page.keyboard.press("Enter")
  const members = page.locator('[data-dialog="members"]')
  await expect(members).toBeVisible()
  await expect(members.getByRole("button", { name: /Back to/ })).toContainText("Esc")
  await tabTo(page, members.getByRole("button", { name: /Back to/ }))
  await page.keyboard.press("Enter")
  await expect(members).toBeHidden()
  await expect(menu).toBeVisible()
  await expect(search).toBeFocused()
  await expect(menu.getByRole("option", { selected: true })).toContainText("Manage members")
  await page.keyboard.press("ArrowLeft")
  await expect(search).toHaveValue("#ops")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(members).toBeVisible()
  await page.keyboard.press("Meta+k")
  await expect(members).toBeHidden()
  await expect(menu).toBeHidden()
  expect(writes).toEqual([])
})

test("keyboard-only spawn pickers close one level at a time and keep selected values", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents/codex-reviewer")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await expect(menu.getByRole("combobox", { name: "Search commands and places" })).toBeFocused()
  await page.keyboard.type("spawn")
  await page.keyboard.press("Enter")
  const role = menu.getByRole("combobox", { name: "Role", exact: true })
  await tabTo(page, role)
  await page.keyboard.press("ArrowDown")
  await expect(role).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Escape")
  await expect(role).toHaveAttribute("aria-expanded", "false")
  await expect(menu.getByRole("heading", { name: "Spawn an agent" })).toBeVisible()
  await expect(role).toBeFocused()
  await page.keyboard.press("ArrowLeft")
  await expect(role).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(menu.getByRole("combobox", { name: "Search commands and places" })).toBeFocused()
  await page.keyboard.press("Enter")
  const model = menu.getByRole("combobox", { name: "Model", exact: true })
  await tabTo(page, model)
  await page.keyboard.type("gpt-5.6-sol")
  await expect(page.locator('[data-combobox-option="gpt-5.6-sol"]')).toBeVisible()
  await page.keyboard.press("Enter")
  const effort = menu.getByRole("combobox", { name: "Effort", exact: true })
  await tabTo(page, effort)
  await page.keyboard.type("high")
  await page.keyboard.press("Enter")
  const goal = menu.getByRole("textbox", { name: "Initial goal" })
  await tabTo(page, goal)
  await page.keyboard.type("Review with keyboard control.")
  await page.keyboard.press("Escape")
  await expect(menu.getByRole("combobox", { name: "Search commands and places" })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(goal).toHaveValue("Review with keyboard control.")
  await tabTo(page, menu.getByRole("button", { name: "Spawn agent", exact: true }))
  await page.keyboard.press("Enter")
  await expect(menu).toBeHidden()
  expect(writes).toHaveLength(1)
  expect(JSON.parse(writes[0]?.body ?? "{}")).toMatchObject({
    model: "gpt-5.6-sol",
    effort: "high",
    goal: "Review with keyboard control.",
  })
})

test("keyboard-only select with no match cannot submit a spawn", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents/codex-reviewer")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await expect(menu.getByRole("combobox", { name: "Search commands and places" })).toBeFocused()
  await page.keyboard.type("spawn")
  await page.keyboard.press("Enter")
  const model = menu.getByRole("combobox", { name: "Model", exact: true })
  await tabTo(page, model)
  await page.keyboard.type("no-such-model")
  await expect(page.getByText("No options found.", { exact: true })).toBeVisible()
  await page.keyboard.press("Enter")
  await expect(model).toHaveAttribute("aria-expanded", "true")
  expect(writes).toEqual([])
  await page.keyboard.press("Escape")
  await expect(model).toHaveAttribute("aria-expanded", "false")
  await page.keyboard.press("Escape")
  const search = menu.getByRole("combobox", { name: "Search commands and places" })
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("spawn")
})

for (const command of ["Settings", "Keyboard shortcuts", "Open inbox"] as const) {
  test(`keyboard-only ${command} returns to its command`, async ({ page }) => {
    const writes = await installCommandFixtures(page)
    await page.goto("/agents")
    await page.keyboard.press("Meta+k")
    const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
    const search = menu.getByRole("combobox")
    await expect(search).toBeFocused()
    await page.keyboard.type(command)
    await page.keyboard.press("Enter")
    await expect(menu).toBeHidden()
    const back = page.getByRole("button", { name: "Back to Commands Esc", exact: true })
    await expect(back).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(search).toBeFocused()
    await expect(search).toHaveValue(command)
    expect(writes).toEqual([])
  })
}

test("keyboard-only terminal input and stop confirmation keep the agent action parent", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  await expect(search).toBeFocused()
  await page.keyboard.type("codex-reviewer")
  await page.keyboard.press("ArrowRight")
  await page.keyboard.type("prompt terminal")
  await page.keyboard.press("Enter")
  const terminal = menu.getByRole("textbox", { name: "Terminal input", exact: true })
  await expect(terminal).toBeFocused()
  await page.keyboard.type("Keep the terminal draft.")
  await page.keyboard.press("Escape")
  await expect(search).toHaveValue("prompt terminal")
  await page.keyboard.press("Meta+a")
  await page.keyboard.type("stop")
  await page.keyboard.press("Enter")
  const confirmation = page.getByRole("textbox", { name: "Confirmation", exact: true })
  await expect(confirmation).toBeFocused()
  await page.keyboard.type("not-a-confirmation")
  await page.keyboard.press("ArrowLeft")
  await expect(confirmation).toBeFocused()
  await page.keyboard.press("Escape")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("stop")
  await page.keyboard.press("Escape")
  await expect(search).toHaveValue("codex-reviewer")
  expect(writes).toEqual([])
})

test("keyboard-only inbox selection ends the menu flow even on the current page", async ({ page }) => {
  await installCommandFixtures(page)
  await page.route("**/api/inbox", (route) =>
    route.fulfill({
      json: { entries: [{ channel: "ops", unread: 2, senders: [], routeState: "active", pushEnabled: true }] },
    }),
  )
  await page.goto("/channels/ops")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  await expect(menu.getByRole("combobox")).toBeFocused()
  await page.keyboard.type("Open inbox")
  await page.keyboard.press("Enter")
  const inbox = page.locator('[data-dialog="inbox"]')
  await expect(inbox).toBeVisible()
  await expect(inbox.getByRole("option")).toContainText("ops")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(inbox).toBeHidden()
  await expect(menu).toBeHidden()
  await expect(page).toHaveURL(/\/channels\/ops$/u)
})

test("keyboard-only channel join replaces the completed step and returns to the recipient search", async ({ page }) => {
  await installCommandFixtures(page)
  let joins = 0
  await page.route("**/api/channels/research/join", async (route) => {
    joins += 1
    await route.fulfill({ json: { channel: "research", cursorId: 0 } })
  })
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  await expect(search).toBeFocused()
  await page.keyboard.type(">send")
  await page.keyboard.press("Enter")
  await page.keyboard.type("#research")
  await page.keyboard.press("Enter")
  await expect(menu.getByRole("button", { name: "Join and write a message" })).toBeFocused()
  expect(joins).toBe(0)
  await page.keyboard.press("Escape")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("#research")
  await page.keyboard.press("Enter")
  await page.keyboard.press("Enter")
  const message = menu.getByRole("textbox", { name: "Message #research" })
  await expect(message).toBeFocused()
  await page.keyboard.type("Keep the channel draft.")
  await page.keyboard.press("Escape")
  await expect(search).toHaveValue("#research")
  await expect(search).toHaveAttribute("placeholder", "Find a person or channel…")
  await page.keyboard.press("Escape")
  await expect(search).toHaveValue(">send")
  expect(joins).toBe(1)
})

test("keyboard-only connect cancellation returns to the same unconnected pane", async ({ page }) => {
  const writes = await installCommandFixtures(page)
  await page.route("**/api/herdr/workspaces", (route) =>
    route.fulfill({
      json: {
        workspaces: mockWorkspaces.map((workspace) => ({
          ...workspace,
          panes: workspace.panes.map((pane) => ({ ...pane, participant: null, participantRouteState: null })),
        })),
      },
    }),
  )
  await page.goto("/agents")
  await page.keyboard.press("Meta+k")
  const menu = page.getByRole("dialog", { name: "Sheppard command menu" })
  const search = menu.getByRole("combobox")
  await expect(search).toBeFocused()
  await page.keyboard.type("pane-web")
  await expect(menu.getByRole("option", { selected: true })).toContainText("Not connected to chat")
  await page.keyboard.press("Enter")
  const handle = page.getByRole("textbox", { name: "Chat handle" })
  await expect(handle).toBeFocused()
  await page.keyboard.type("new-worker")
  await page.keyboard.press("Escape")
  await expect(search).toBeFocused()
  await expect(search).toHaveValue("pane-web")
  expect(writes).toEqual([])
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
  await expect(composer).toBeHidden()
  await page.keyboard.press("c")
  await expect(composer).toBeInViewport()
  await expect(composer).toBeFocused()
  await page.screenshot({ path: "/private/tmp/sheppard-agent-workbench-mobile.png" })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test("agent session and chat share the full page height in a vertical split", async ({ page }) => {
  await installCommandFixtures(page)
  await page.setViewportSize({ width: 960, height: 700 })
  await page.goto("/agents/codex-reviewer")
  await page.getByRole("button", { name: "Hide sidebar", exact: true }).click()
  await expect(page.getByRole("heading", { name: "Review complete" })).toBeVisible()
  const session = page.locator("[data-agent-session-pane]")
  const messages = page.locator("[data-agent-messages-pane]")
  await expect(session).toBeVisible()
  await expect(messages).toBeVisible()
  const left = await session.boundingBox()
  const right = await messages.boundingBox()
  if (left === null || right === null) throw new Error("Both agent panes must have a layout box")
  expect(left.x + left.width).toBeLessThanOrEqual(right.x + 1)
  expect(Math.abs(left.y - right.y)).toBeLessThan(1)
  expect(left.height).toBeGreaterThan(500)
  expect(Math.abs(left.height - right.height)).toBeLessThan(1)
  await page.screenshot({ path: "/private/tmp/sheppard-agent-vertical-split.png" })
})

test("ambiguous session choices open at the start instead of the last path", async ({ page }) => {
  await installCommandFixtures(page)
  await page.route("**/api/herdr/agents/*/session", (route) =>
    route.fulfill({
      json: {
        ...reviewerSession,
        turns: [],
        source: { ...reviewerSession.source, state: "ambiguous", sessionPath: null, glance: null },
        mapping: {
          confidence: "ambiguous",
          candidates: Array.from({ length: 5 }, (_, index) => ({
            sessionId: `choice-${index}`,
            path: `/sessions/review-${index}.jsonl`,
            startedAt: "2026-09-24T12:00:00Z",
            sizeBytes: 2048,
            cwd: "/work/review",
            firstUserText: `Review batch ${index}.`,
          })),
        },
      },
    }),
  )
  await page.goto("/agents/codex-reviewer")
  await expect(page.getByText("Candidate sessions", { exact: true })).toBeInViewport()
  await expect(page.getByRole("button", { name: "Select session choice-0", exact: true })).toBeInViewport()
  expect(await page.locator("[data-agent-session-pane] .agent-reading-scroll").evaluate((node) => node.scrollTop)).toBe(
    0,
  )
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
