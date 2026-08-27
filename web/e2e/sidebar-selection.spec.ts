import { expect, test, type Page } from "@playwright/test"

import { mockChannels, mockDirectConversations, mockMembers } from "../src/api/fixtures"

type SidebarPayload =
  | { channels: typeof mockChannels }
  | { conversations: typeof mockDirectConversations }
  | { participants: Array<{ agentKind: string | null; handle: string; kind: "agent" | "human"; routeState: "active" | "stale" }> }
  | { members: typeof mockMembers }
  | { participant: { agentKind: string; handle: string; kind: "agent"; lastSeenAt: null; routeState: "active" }; pane: null; recentMessageIds: never[]; routeState: "active" }
  | { workspaces: never[] }
  | { harnesses: string[] }
  | { roles: never[] }
  | { messages: never[] }
  | Record<string, never>

async function installSidebarMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem("msgr.identity.v1", JSON.stringify({ version: 1, hub: window.location.origin, handle: "operator" }))
  })
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const json = (payload: SidebarPayload, status = 200): Promise<void> => route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status })
    if (url.pathname === "/api/channels" && method === "GET") {
      await json({ channels: mockChannels })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await json({ conversations: mockDirectConversations })
      return
    }
    if (url.pathname === "/api/participants") {
      await json({ participants: mockMembers.map(({ agentKind, handle, kind, routeState }) => ({ agentKind, handle, kind, routeState })) })
      return
    }
    if (url.pathname === "/api/humans" && method === "POST") {
      await json({ handle: "operator" })
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      await json({ members: mockMembers })
      return
    }
    if (url.pathname.startsWith("/api/agents/") && method === "GET") {
      const handle = decodeURIComponent(url.pathname.slice("/api/agents/".length))
      await json({
        participant: { agentKind: "codex", handle, kind: "agent", lastSeenAt: null, routeState: "active" },
        pane: null,
        recentMessageIds: [],
        routeState: "active",
      })
      return
    }
    if (url.pathname === "/api/events") {
      await route.fulfill({ body: ": ready\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: "data: {\"workspaces\":[]}\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (url.pathname === "/api/herdr/workspaces") {
      await json({ workspaces: [] })
      return
    }
    if (url.pathname === "/api/herdr/harnesses") {
      await json({ harnesses: [] })
      return
    }
    if (url.pathname === "/api/herdr/roles") {
      await json({ roles: [] })
      return
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      await json({ messages: [] })
      return
    }
    if (method === "GET") {
      await json({})
      return
    }
    await json({})
  })
}

test("@guard sidebar conversation selection opens the direct conversation from page routes", async ({ page }) => {
  await installSidebarMocks(page)

  for (const route of [
    "/workspaces",
    "/workspaces/workspace-sheppard",
    "/channels",
    "/channels/ops",
    "/direct",
    "/direct/dm-planner-runner",
    "/agents",
    "/agents/codex-reviewer",
    "/workspaces/new",
    "/channels/new",
    "/direct/new",
    "/agents/new",
  ]) {
    await page.goto(route)
    await page.locator('[data-quick-nav-item="direct"]').click()
    await expect(page).toHaveURL(/\/direct$/u)
    await page.locator('aside [data-channel-row="dm-planner-runner"] > a').click()
    await expect(page).toHaveURL(/\/direct\/dm-planner-runner$/u)
    await expect(page.locator('[data-shell-page="current"]')).toBeVisible()
  }
})
