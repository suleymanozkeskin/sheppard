import { expect, test, type Page, type Route } from "@playwright/test"

import { mockChannels, mockInbox, mockMembers, mockMessages } from "../src/api/fixtures"

type SearchResult = {
  messageId: number
  channel: string
  sender: string
  snippet: string
  createdAt: string
  attachmentCount: number
}

type JsonValue = boolean | Record<string, JsonValue> | JsonValue[] | null | number | string

async function fulfillJson(route: Route, payload: JsonValue): Promise<void> {
  await route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status: 200 })
}

async function installSearchApiMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "msgr.identity.v1",
      JSON.stringify({ version: 1, hub: window.location.origin, handle: "suleyman" }),
    )
  })
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/api/events" || url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: ": ready\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/search" && method === "GET") {
      await fulfillJson(route, { results: [], truncated: false })
      return
    }
    if (url.pathname === "/api/channels" && method === "GET") {
      await fulfillJson(route, url.searchParams.get("kind") === "workspace" ? { channels: [] } : { channels: mockChannels })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await fulfillJson(route, { conversations: [] })
      return
    }
    if (url.pathname === "/api/inbox" && method === "GET") {
      await fulfillJson(route, { entries: mockInbox })
      return
    }
    if (url.pathname === "/api/participants" && method === "GET") {
      await fulfillJson(route, {
        participants: mockMembers.map(({ agentKind, handle, kind, routeState }) => ({ agentKind, handle, kind, routeState })),
      })
      return
    }
    if (url.pathname === "/api/herdr/workspaces" && method === "GET") {
      await fulfillJson(route, { workspaces: [] })
      return
    }
    if (url.pathname === "/api/herdr/roles" && method === "GET") {
      await fulfillJson(route, { roles: [] })
      return
    }
    if (url.pathname === "/api/humans" && method === "POST") {
      await fulfillJson(route, { handle: "suleyman" })
      return
    }
    if (url.pathname.endsWith("/receipts") && method === "GET") {
      await fulfillJson(route, [])
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      await fulfillJson(route, { members: mockMembers })
      return
    }
    if (url.pathname.endsWith("/context") && method === "GET") {
      const channel = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      await fulfillJson(route, { messages: mockMessages.filter((message) => message.channel === channel) })
      return
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      const channel = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      await fulfillJson(route, { messages: mockMessages.filter((message) => message.channel === channel) })
      return
    }
    if (method === "GET") {
      await fulfillJson(route, {})
      return
    }
    await fulfillJson(route, { channel: "ops", cursorId: 0, messageId: 0 })
  })
}

function result(messageId: number, channel: string, sender = "runner", snippet = "handoff result", attachmentCount = 0): SearchResult {
  return { attachmentCount, channel, createdAt: "2026-08-20T10:00:00.000Z", messageId, sender, snippet }
}

test("@guard search route survives reload and Back", async ({ page }) => {
  await installSearchApiMocks(page)
  await page.route("**/api/search**", async (route) => {
    await fulfillJson(route, { results: [result(6, "research", "reviewer-2", "handoff context")], truncated: false })
  })
  await page.goto("/search?q=handoff&scope=channel%3Aresearch")
  await expect(page.locator('[data-shell-page="search"]')).toBeVisible()
  await expect(page.locator('[data-search-result="6"]')).toBeVisible()
  await expect(page.locator("#search-page-query")).toHaveValue("handoff")
  await expect(page.locator("select")).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Current channel", exact: true })).toHaveAttribute("aria-pressed", "true")

  await page.reload()
  await expect(page.locator('[data-search-result="6"]')).toBeVisible()
  await expect(page.getByRole("button", { name: "Current channel", exact: true })).toHaveAttribute("aria-pressed", "true")

  await page.locator('[data-search-result="6"]').click()
  await expect(page).toHaveURL(/\/channels\/research\?messageId=6$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/search\?q=handoff&scope=channel%3Aresearch$/)
  await expect(page.locator('[data-search-result="6"]')).toBeVisible()
})

test("@guard search scope controls change the header and search-page scope", async ({ page }) => {
  await installSearchApiMocks(page)
  await page.route("**/api/search**", async (route) => {
    await fulfillJson(route, { results: [], truncated: false })
  })

  await page.goto("/")
  await expect(page.locator("select")).toHaveCount(0)
  const headerScope = page.locator("[data-search-header-scope]")
  await expect(headerScope).toBeVisible()
  await expect(headerScope).toHaveAttribute("data-search-header-scope", "all")
  await headerScope.click()
  await expect(headerScope).toHaveAttribute("data-search-header-scope", "channel")
  await expect(page.locator("#message-search")).toHaveAttribute("placeholder", "Search this chat…")
  await headerScope.click()
  await expect(headerScope).toHaveAttribute("data-search-header-scope", "all")
  await expect(page).toHaveURL(/\/$/)

  await page.goto("/")
  await expect(page.locator("[data-search-header-scope]")).toHaveAttribute("data-search-header-scope", "all")
  await page.fill("#message-search", "scope")
  await page.press("#message-search", "Enter")
  await expect(page).toHaveURL(/\/search\?q=scope&scope=all$/)
  await expect(page.locator("select")).toHaveCount(0)

  const allChannels = page.getByRole("button", { name: "All channels", exact: true })
  const currentChannel = page.getByRole("button", { name: "Current channel", exact: true })
  await expect(allChannels).toHaveAttribute("aria-pressed", "true")
  await currentChannel.click()
  await expect(page).toHaveURL(/\/search\?q=scope&scope=channel%3Aops$/)
  await expect(currentChannel).toHaveAttribute("aria-pressed", "true")

  await page.reload()
  await expect(page.getByRole("button", { name: "Current channel", exact: true })).toHaveAttribute("aria-pressed", "true")
  await page.getByRole("button", { name: "All channels", exact: true }).click()
  await expect(page).toHaveURL(/\/search\?q=scope&scope=all$/)
  await expect(page.getByRole("button", { name: "All channels", exact: true })).toHaveAttribute("aria-pressed", "true")
})

test("@guard live search edits replace history", async ({ page }) => {
  await installSearchApiMocks(page)
  await page.route("**/api/search**", async (route) => {
    await fulfillJson(route, { results: [], truncated: false })
  })
  await page.goto("/")
  await expect(page.locator("[data-search-header-scope]")).toHaveAttribute("data-search-header-scope", "all")
  await page.fill("#message-search", "first")
  await page.press("#message-search", "Enter")
  await expect(page).toHaveURL(/\/search\?q=first&scope=all$/)
  await page.fill("#search-page-query", "second")
  await expect(page).toHaveURL(/\/search\?q=second&scope=all$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator("#message-search")).toBeVisible()
})

test("@guard mobile search entry opens the page query", async ({ page }) => {
  await installSearchApiMocks(page)
  await page.setViewportSize({ height: 800, width: 390 })
  await page.goto("/")
  const entry = page.getByRole("button", { name: "Search messages" })
  await expect(entry).toBeVisible()
  await entry.click()
  await expect(page).toHaveURL(/\/search\?q=&scope=all$/)
  const query = page.locator("#search-page-query")
  await expect(query).toBeVisible()
  await expect(query).toBeFocused()
  await query.fill("mobile")
  await expect(query).toHaveValue("mobile")
})

test("@guard search page submits with Enter, closes with Escape, and shows the exact count below the limit", async ({ page }) => {
  await installSearchApiMocks(page)
  await page.route("**/api/search**", async (route) => {
    await fulfillJson(route, { results: [result(9, "research", "runner", "enter result")], truncated: false })
  })
  await page.goto("/search?q=&scope=all")
  const query = page.locator("#search-page-query")
  await expect(query).toBeFocused()
  await query.fill("enter")
  await query.press("Enter")
  await expect(page.locator('[data-search-result="9"]')).toBeVisible()
  await expect(page.locator("[data-search-count]")).toHaveText("1 matches shown")
  await query.press("Escape")
  await expect(page).toHaveURL(/\/channels\/ops$/)
})

test("@guard scope reload, sender filter, and exact truncation survive", async ({ page }) => {
  await installSearchApiMocks(page)
  const requests: Array<{ channel: string | null; q: string | null; sender: string | null }> = []
  await page.route("**/api/search**", async (route) => {
    const url = new URL(route.request().url())
    requests.push({ channel: url.searchParams.get("channel"), q: url.searchParams.get("q"), sender: url.searchParams.get("sender") })
    await fulfillJson(route, { results: [result(6, "research", "runner", "truncate result")], truncated: true })
  })
  await page.goto("/search?q=from%3Arunner%20truncate&scope=channel%3Aresearch")
  await expect(page.locator('[data-search-truncated="true"]')).toHaveText(/1 matches shown · more may exist — refine the query/)
  expect(requests.at(-1)).toEqual({ channel: "research", q: "truncate", sender: "runner" })
  await page.reload()
  await expect(page.locator('[data-search-truncated="true"]')).toBeVisible()
  expect(requests.at(-1)).toEqual({ channel: "research", q: "truncate", sender: "runner" })
})

test("@guard result readiness does not steal query focus and j/k roves", async ({ page }) => {
  await installSearchApiMocks(page)
  await page.route("**/api/search**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 75))
    await fulfillJson(route, {
      results: [result(6, "research", "runner", "focus first"), result(7, "research", "planner", "focus second")],
      truncated: false,
    })
  })
  await page.goto("/search?q=focus&scope=all")
  const query = page.locator("#search-page-query")
  await query.focus()
  await expect(page.locator('[data-search-result="6"]')).toBeVisible()
  await expect(query).toBeFocused()
  await query.fill("next")
  await expect(page).toHaveURL(/\/search\?q=next&scope=all$/)
  await expect(page.locator('[data-search-result="6"]')).toBeVisible()
  await expect(query).toBeFocused()

  const first = page.locator('[data-search-result="6"]')
  const second = page.locator('[data-search-result="7"]')
  await first.focus()
  await page.keyboard.press("j")
  await expect(second).toHaveAttribute("aria-current", "true")
  await expect(second).toBeFocused()
})

test("@guard search attachment counts and result menus preserve row actions", async ({ page }) => {
  await installSearchApiMocks(page)
  await page.route("**/api/search**", async (route) => {
    await fulfillJson(route, {
      results: [
        result(4, "research", "runner", "with two files", 2),
        result(5, "research", "planner", "with one file", 1),
        result(7, "research", "scout", "without files", 0),
      ],
      truncated: false,
    })
  })
  await page.goto("/search?q=files&scope=all")

  const withFilesRow = page.locator('[data-search-result-row="4"]')
  const withFiles = withFilesRow.locator('[data-search-result="4"]')
  await expect(withFiles.locator('[data-search-attachment-count="2"]')).toHaveAccessibleName("2 attachments")
  await expect(page.locator('[data-search-result="5"] [data-search-attachment-count="1"]')).toHaveAccessibleName("1 attachment")
  await expect(page.locator('[data-search-result="7"] [data-search-attachment-count]')).toHaveCount(0)
  await expect(page.locator('[data-search-result="7"] [data-search-menu-trigger]')).toHaveCount(0)

  await withFilesRow.locator('[data-search-menu-trigger="4"]').click()
  const pointerMenu = page.locator('[data-search-menu]')
  const pointerItem = pointerMenu.getByRole("menuitem", { name: "Show in attachments" })
  await expect(pointerItem).toBeFocused()
  await page.keyboard.press("ArrowDown")
  await expect(pointerItem).toBeFocused()
  await page.keyboard.press("ArrowUp")
  await expect(pointerItem).toBeFocused()
  await pointerItem.click()
  await expect(page).toHaveURL(/\/attachments\?scope=channel%3Aresearch&kind=all$/)

  await page.goto("/search?q=files&scope=all")
  const keyboardRow = page.locator('[data-search-result="4"]')
  await keyboardRow.focus()
  await page.keyboard.press(".")
  await expect(page.locator('[data-search-menu]')).toBeVisible()
  await expect(page.locator('[data-search-result-row="4"] [data-search-menu-trigger="4"]')).toHaveAttribute("aria-expanded", "true")
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-search-menu]')).toHaveCount(0)
  await expect(keyboardRow).toBeFocused()

  await page.locator('[data-search-result="7"]').focus()
  await page.keyboard.press(".")
  await expect(page.locator('[data-search-menu]')).toHaveCount(0)
})

test("@guard ws search results use a channel route without a storage label", async ({ page }) => {
  await installSearchApiMocks(page)
  await page.route("**/api/search**", async (route) => {
    await fulfillJson(route, { results: [result(8, "ws-storage-hidden", "runner", "workspace handoff")], truncated: false })
  })
  await page.goto("/search?q=workspace&scope=all")
  await page.locator('[data-search-result="8"]').click()
  await expect(page).toHaveURL(/\/channels\/ws-storage-hidden\?messageId=8$/)
  await expect(page.locator('textarea[placeholder="Message Workspace broadcast"]')).toBeVisible()
  const bodyText = await page.locator("body").innerText()
  expect(bodyText).not.toContain("ws-storage-hidden")
})
