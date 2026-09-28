import { expect, test, type Page, type Route } from "@playwright/test"

import { mockChannels, mockInbox, mockMembers, mockMessages } from "../src/api/fixtures"
import type { KeepAwakePolicy } from "../src/api/types"

type JsonValue = boolean | { [key: string]: JsonValue } | JsonValue[] | null | number | string

const QUESTION_POLICY = {
  id: 7,
  target: { kind: "channel", channelId: 2, channel: "research", coordinatorId: 1, coordinator: "planner" },
  limits: { idleMinutes: 20, blockedMinutes: 30, maxWakes: 3 },
  state: {
    kind: "needs-human",
    cause: {
      kind: "agent-requested",
      handle: "planner",
      alert: {
        kind: "message",
        channelId: 101,
        channel: "dm-planner-runner",
        messageId: 12,
        excerpt: "Can you review the hand-off before the next deploy?",
      },
    },
    since: "2026-08-17T09:49:00.000Z",
  },
  humanMarkId: 0,
} satisfies KeepAwakePolicy

async function fulfillJson(route: Route, payload: JsonValue): Promise<void> {
  await route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status: 200 })
}

/** Answers every API read with fixtures, one stopped policy, and records keep-awake writes. */
async function installAlarmApi(page: Page, writes: string[]): Promise<void> {
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
    if (url.pathname === "/api/keep-awake" && method === "GET") {
      await fulfillJson(route, { policies: [QUESTION_POLICY] })
      return
    }
    if (url.pathname.startsWith("/api/keep-awake/") && method === "PUT") {
      writes.push(`${url.pathname} ${route.request().postData() ?? ""}`)
      await fulfillJson(route, { setting: { kind: "on", policy: QUESTION_POLICY } })
      return
    }
    if (url.pathname === "/api/channels" && method === "GET") {
      await fulfillJson(route, url.searchParams.get("kind") === "workspace" ? { channels: [] } : { channels: mockChannels })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await fulfillJson(route, {
        conversations: [
          { channel: "dm-planner-runner", participants: ["planner"], unread: 1, lastMessageAt: "2026-08-17T09:50:00.000Z" },
        ],
      })
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
    if ((url.pathname.endsWith("/context") || url.pathname.endsWith("/messages")) && method === "GET") {
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

test("an agent's question alarm opens the question with the composer focused", async ({ page }) => {
  const writes: string[] = []
  await installAlarmApi(page, writes)
  await page.goto("/channels/ops")

  const alarm = page.locator('[data-keep-awake-alarm="7"]')
  await expect(alarm).toContainText("#research needs you")
  await expect(alarm).toContainText("@planner: Can you review the hand-off before the next deploy?")

  await alarm.locator('[data-keep-awake-alarm-open="question"]').click()
  await expect(page).toHaveURL(/\/direct\/dm-planner-runner\?messageId=12&focus=composer$/)
  await expect(page.locator('[data-message-id="12"]')).toBeVisible()
  await expect(page.locator("#message-composer")).toBeFocused()
  expect(writes).toEqual([])
})

test("Resume sends the same limits with the channel coordinator", async ({ page }) => {
  const writes: string[] = []
  await installAlarmApi(page, writes)
  await page.goto("/channels/ops")

  await page.locator('[data-keep-awake-alarm-resume="7"]').click()
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toBe(
    '/api/keep-awake/channels/research {"coordinator":"planner","idleMinutes":20,"blockedMinutes":30,"maxWakes":3}',
  )
})
