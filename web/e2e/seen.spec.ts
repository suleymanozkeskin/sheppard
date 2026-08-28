import { expect, test, type Page, type Route } from "@playwright/test"

import { mockChannels, mockInbox, mockMembers, mockMessages } from "../src/api/fixtures"
import type { Member } from "../src/api/types"

declare global {
  interface Window {
    __closeMsgrStream?: () => void
    __msgrStreamOpen?: boolean
    __pushMsgrEvent?: (record: string) => void
  }
}

type JsonValue = boolean | Record<string, JsonValue> | JsonValue[] | null | number | string

async function fulfillJson(route: Route, payload: JsonValue): Promise<void> {
  await route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status: 200 })
}

interface SeenMockOptions {
  channelReceipts?: Record<string, JsonValue[]>
  members?: Member[]
  receiptDelayMs?: number
  receipts?: JsonValue[]
}

interface SeenMockHandle {
  closeStream: () => Promise<void>
  pushEvent: (record: string) => Promise<void>
  receiptRequests: () => number
  setReceipts: (receipts: JsonValue[]) => void
}

async function installSeenApiMocks(page: Page, options: SeenMockOptions = {}): Promise<SeenMockHandle> {
  let receiptRequests = 0
  let currentReceipts = options.receipts ?? [
    { cursorMessageId: 0, handle: "old-runner", routeState: "stale" },
    { cursorMessageId: 0, handle: "planner", routeState: "active" },
    { cursorMessageId: 0, handle: "runner", routeState: "active" },
    { cursorMessageId: 99, handle: "suleyman", routeState: "active" },
  ]
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "msgr.identity.v1",
      JSON.stringify({ version: 1, hub: window.location.origin, handle: "suleyman" }),
    )
  })
  await page.addInitScript(() => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
    const encoder = new TextEncoder()
    const originalFetch = globalThis.fetch.bind(globalThis)
    const streamWindow = window
    streamWindow.__msgrStreamOpen = false
    streamWindow.__pushMsgrEvent = (record) => {
      streamController?.enqueue(encoder.encode(`${record}\n\n`))
    }
    streamWindow.__closeMsgrStream = () => {
      const controller = streamController
      streamController = undefined
      streamWindow.__msgrStreamOpen = false
      if (controller === undefined) return
      try {
        controller.close()
      } catch {
        // The client already closed this stream.
      }
    }
    globalThis.fetch = (input, init) => {
      const href = String(input instanceof Request ? input.url : input)
      if (new URL(href, globalThis.location.origin).pathname !== "/api/events") return originalFetch(input, init)
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          streamController = controller
          streamWindow.__msgrStreamOpen = true
          controller.enqueue(encoder.encode(": ready\n\n"))
          init?.signal?.addEventListener("abort", () => {
            if (streamController !== controller) return
            streamController = undefined
            streamWindow.__msgrStreamOpen = false
            try {
              controller.close()
            } catch {
              // The client already closed this stream.
            }
          }, { once: true })
        },
      })
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" }, status: 200 }))
    }
  })
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/api/events" || url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: ": ready\n\n", contentType: "text/event-stream", status: 200 })
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
      receiptRequests += 1
      const channel = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      if ((options.receiptDelayMs ?? 0) > 0) await new Promise((resolve) => setTimeout(resolve, options.receiptDelayMs))
      await fulfillJson(route, options.channelReceipts?.[channel] ?? currentReceipts)
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      await fulfillJson(route, { members: options.members ?? mockMembers.slice(0, 4) })
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
  return {
    closeStream: async () => {
      await page.waitForFunction(() => window.__msgrStreamOpen === true)
      await page.evaluate(() => {
        if (window.__closeMsgrStream === undefined) throw new Error("the stream close hook is not installed")
        window.__closeMsgrStream()
      })
    },
    pushEvent: async (record) => {
      await page.waitForFunction(() => window.__msgrStreamOpen === true)
      await page.evaluate((nextRecord) => {
        if (window.__pushMsgrEvent === undefined) throw new Error("the message stream is not open")
        window.__pushMsgrEvent(nextRecord)
      }, record)
    },
    receiptRequests: () => receiptRequests,
    setReceipts: (receipts) => { currentReceipts = receipts },
  }
}

function topologyWithRunner(routeState: "active" | "stale"): string {
  const pane = {
    agentKind: "codex",
    agentStatus: "idle",
    focused: false,
    label: "runner",
    paneId: "pane-runner",
    participant: "runner",
    participantRouteState: routeState,
    title: null,
  }
  return `event: topology\ndata: ${JSON.stringify({
    workspaces: [{ id: "workspace-seen", label: "seen", panes: [pane], tabs: [{ id: "tab-seen", label: "main", panes: [pane] }] }],
  })}`
}

test("@guard shows seen state only on the latest own message", async ({ page }) => {
  const requests = await installSeenApiMocks(page)
  await page.goto("/channels/ops")
  await page.locator('[data-message-id="4"]').waitFor()

  const latestOwnMessage = page.locator('[data-message-id="4"]')
  await expect(latestOwnMessage.locator('[data-receipt-state="missing"]')).toContainText("Not yet seen by 2: planner, runner")
  await expect(latestOwnMessage.locator('[data-receipt-kind="cannot-receive"]')).toContainText("old-runner is not running")
  await expect(page.locator('[data-message-id="2"] [data-receipt-state]')).toHaveCount(0)
  await expect(page.locator('[data-message-id="1"] [data-receipt-state]')).toHaveCount(0)
  expect(requests.receiptRequests()).toBe(1)
})

test("@guard receipt frames and route transitions preserve the three states", async ({ page }) => {
  const members = mockMembers.slice(0, 3).map((member) => member.handle === "runner" ? { ...member, routeState: "stale" as const } : member)
  const requests = await installSeenApiMocks(page, {
    members,
    receipts: [
      { cursorMessageId: 0, handle: "planner", routeState: "active" },
      { cursorMessageId: 0, handle: "runner", routeState: "active" },
      { cursorMessageId: 99, handle: "suleyman", routeState: "active" },
    ],
  })
  await page.goto("/channels/ops")
  await page.locator('[data-message-id="4"]').waitFor()
  const latestOwnMessage = page.locator('[data-message-id="4"]')
  await expect(latestOwnMessage.locator('[data-receipt-kind="not-yet"]')).toHaveText("Not yet seen by 1: planner")
  await expect(latestOwnMessage.locator('[data-receipt-kind="cannot-receive"]')).toHaveText("runner is not running")

  await requests.pushEvent(topologyWithRunner("active"))
  await expect(latestOwnMessage.locator('[data-receipt-kind="not-yet"]')).toHaveText("Not yet seen by 2: planner, runner")
  await expect(latestOwnMessage.locator('[data-receipt-kind="cannot-receive"]')).toHaveCount(0)

  await requests.pushEvent('event: receipt\ndata: {"channel":"handoff","handle":"planner","cursorMessageId":4}')
  await expect(latestOwnMessage.locator('[data-receipt-kind="not-yet"]')).toHaveText("Not yet seen by 2: planner, runner")
  await requests.pushEvent('event: receipt\ndata: {"channel":"ops","handle":"planner","cursorMessageId":4}')
  await expect(latestOwnMessage.locator('[data-receipt-kind="not-yet"]')).toHaveText("Not yet seen by 1: runner")
  await requests.pushEvent('event: receipt\ndata: {"channel":"ops","handle":"runner","cursorMessageId":4}')
  await expect(latestOwnMessage.locator('[data-receipt-state="seen"]')).toHaveText("Seen")

  await requests.pushEvent(topologyWithRunner("stale"))
  await expect(latestOwnMessage.locator('[data-receipt-state="seen"]')).toHaveText("Seen")
  expect(requests.receiptRequests()).toBe(1)
})

test("@guard receipt rows are keyed by the selected channel", async ({ page }) => {
  await installSeenApiMocks(page, {
    channelReceipts: {
      ops: [
        { cursorMessageId: 0, handle: "planner", routeState: "active" },
        { cursorMessageId: 0, handle: "runner", routeState: "active" },
        { cursorMessageId: 0, handle: "old-runner", routeState: "stale" },
      ],
      research: [
        { cursorMessageId: 0, handle: "planner", routeState: "active" },
        { cursorMessageId: 0, handle: "runner", routeState: "active" },
      ],
    },
    receiptDelayMs: 300,
  })
  await page.goto("/channels/ops")
  await page.locator('[data-message-id="4"]').waitFor()
  await page.locator('[data-channel-row="research"] > a').click()
  await page.locator('[data-message-id="7"]').waitFor()
  await expect(page.locator('[data-message-id="7"] [data-receipt-state]')).toHaveCount(0)
  await expect(page.locator('[data-message-id="7"] [data-receipt-kind="not-yet"]')).toHaveText("Not yet seen by 2: planner, runner")
})

test("@guard reconnect refetches the current channel receipts", async ({ page }) => {
  const requests = await installSeenApiMocks(page, {
    receipts: [
      { cursorMessageId: 0, handle: "planner", routeState: "active" },
      { cursorMessageId: 0, handle: "runner", routeState: "active" },
      { cursorMessageId: 99, handle: "suleyman", routeState: "active" },
    ],
  })
  await page.goto("/channels/ops")
  await page.locator('[data-message-id="4"]').waitFor()
  await expect.poll(requests.receiptRequests).toBe(1)
  requests.setReceipts([
    { cursorMessageId: 4, handle: "planner", routeState: "active" },
    { cursorMessageId: 4, handle: "runner", routeState: "active" },
    { cursorMessageId: 99, handle: "suleyman", routeState: "active" },
  ])
  await requests.closeStream()
  await expect.poll(requests.receiptRequests, { timeout: 5_000 }).toBe(2)
  await expect(page.locator('[data-message-id="4"] [data-receipt-state="seen"]')).toHaveText("Seen")
})
