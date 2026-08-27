import { test, expect, type Page, type Route } from "@playwright/test"
import * as v from "valibot"

import {
  mockAttachments,
  mockChannels,
  mockInbox,
  mockMembers,
  mockMessages,
  mockSearchResults,
} from "../src/api/fixtures"
import type { Message } from "../src/api/types"

const MARKDOWN_CONTENT = "# Release notes\n\nThe **staging** deploy is ready.\n\n- Verify the migration window\n- Run [smoke checks](https://example.com/smoke)\n\n> Keep the old route until the checks pass.\n"
const PAGE_SCOPE_KEYS = ["ArrowDown", "ArrowUp", "j", "k", "/", "c", "[", "]", "u", "Shift+G"]

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string

interface PostedMessage {
  attachments: string[]
  body: string
}

const postedMessageSchema = v.object({
  attachments: v.optional(v.array(v.string())),
  body: v.optional(v.string()),
})

const humanRequestSchema = v.object({ handle: v.string() })

function cloneMessage(message: Message): Message {
  return {
    ...message,
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
  }
}

function messageLocator(page: Page, id: number) {
  return page.locator(`[data-message-id="${id}"]`)
}

function readPostedMessage(route: Route): PostedMessage {
  const raw = route.request().postData()
  if (raw === null) return { attachments: [], body: "" }
  const parsed = v.safeParse(postedMessageSchema, JSON.parse(raw))
  return parsed.success
    ? { attachments: parsed.output.attachments ?? [], body: parsed.output.body ?? "" }
    : { attachments: [], body: "" }
}

function readHumanHandle(route: Route): string {
  const raw = route.request().postData()
  if (raw === null) return "tester"
  const parsed = v.safeParse(humanRequestSchema, JSON.parse(raw))
  return parsed.success ? parsed.output.handle : "tester"
}

async function fulfillJson(route: Route, payload: JsonValue): Promise<void> {
  await route.fulfill({
    body: JSON.stringify(payload),
    contentType: "application/json",
    status: 200,
  })
}

async function installApiMocks(page: Page): Promise<void> {
  const messages = mockMessages.map(cloneMessage)
  let nextMessageId = Math.max(...messages.map((message) => message.id)) + 1

  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    if (url.pathname === "/api/events") {
      await route.fulfill({
        body: ": ready\n\n",
        contentType: "text/event-stream",
        status: 200,
      })
      return
    }

    if (url.pathname === "/api/channels" && method === "GET") {
      await fulfillJson(route, { channels: mockChannels.map((channel) => ({ ...channel })) })
      return
    }

    if (url.pathname === "/api/inbox" && method === "GET") {
      await fulfillJson(route, {
        entries: mockInbox.map((entry) => ({ ...entry, senders: [...entry.senders] })),
      })
      return
    }

    if (url.pathname === "/api/direct" && method === "GET") {
      await fulfillJson(route, { conversations: [] })
      return
    }

    if (url.pathname === "/api/direct" && method === "POST") {
      await fulfillJson(route, { channel: "dm-test", messageId: 0 })
      return
    }

    if (url.pathname === "/api/search" && method === "GET") {
      const query = url.searchParams.get("q")?.toLocaleLowerCase() ?? ""
      const channel = url.searchParams.get("channel")
      const results = mockSearchResults.filter((result) =>
        result.snippet.toLocaleLowerCase().includes(query) &&
        (channel === null || result.channel === channel),
      )
      await fulfillJson(route, { results, truncated: false })
      return
    }

    if (url.pathname === "/api/humans" && method === "POST") {
      await fulfillJson(route, { handle: readHumanHandle(route) })
      return
    }

    const attachmentMatch = /^\/api\/attachments\/(\d+)\/content$/u.exec(url.pathname)
    if (attachmentMatch !== null && method === "GET") {
      const attachmentId = Number(attachmentMatch[1])
      if (attachmentId === 103) {
        await route.fulfill({ body: MARKDOWN_CONTENT, contentType: "text/markdown", status: 200 })
      } else {
        await route.fulfill({ body: "", contentType: "application/octet-stream", status: 200 })
      }
      return
    }

    const channelMatch = /^\/api\/channels\/([^/]+)(?:\/([^/]+))?$/u.exec(url.pathname)
    if (channelMatch !== null) {
      const channelName = decodeURIComponent(channelMatch[1] ?? "")
      const operation = channelMatch[2]
      const channelMessages = messages.filter((message) => message.channel === channelName)

      if (operation === undefined && method === "GET") {
        await fulfillJson(route, { channels: mockChannels })
        return
      }
      if (operation === "messages" && method === "GET") {
        await fulfillJson(route, { messages: channelMessages.map(cloneMessage) })
        return
      }
      if (operation === "context" && method === "GET") {
        await fulfillJson(route, { messages: channelMessages.map(cloneMessage) })
        return
      }
      if (operation === "members" && method === "GET") {
        await fulfillJson(route, { members: mockMembers.map((member) => ({ ...member })) })
        return
      }
      if (operation === "join" && method === "POST") {
        const latest = channelMessages.at(-1)?.id ?? 0
        await fulfillJson(route, { channel: channelName, cursorId: latest })
        return
      }
      if (operation === "ack" && method === "POST") {
        const latest = channelMessages.at(-1)?.id ?? 0
        await fulfillJson(route, { cursorId: latest })
        return
      }
      if (operation === "messages" && method === "POST") {
        const posted = readPostedMessage(route)
        const attachmentData = posted.attachments.flatMap((path) => {
          const attachment = mockAttachments.find((candidate) => candidate.path === path)
          return attachment === undefined ? [] : [{ ...attachment }]
        })
        const message: Message = {
          attachments: attachmentData,
          body: posted.body,
          channel: channelName,
          createdAt: "2026-08-17T10:00:00.000Z",
          id: nextMessageId,
          sender: "tester",
          senderAgentKind: null,
          senderKind: "human",
        }
        nextMessageId += 1
        messages.push(message)
        await fulfillJson(route, message)
        return
      }
    }

    await route.fulfill({ body: "Not mocked", contentType: "text/plain", status: 404 })
  })
}

async function waitForWorkspace(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "ops" })).toBeVisible()
  await expect(page.getByRole("list", { name: "Messages" })).toBeVisible()
}

async function openWorkspace(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("e2e.anonymous") === null) {
      localStorage.setItem(
        "msgr.identity.v1",
        JSON.stringify({ handle: "tester", hub: globalThis.location.origin, version: 1 }),
      )
    }
  })
  await installApiMocks(page)
  await page.goto("/")
  await waitForWorkspace(page)
}

async function expectFocusedMessage(page: Page, id: number): Promise<void> {
  await expect(messageLocator(page, id)).toHaveAttribute("tabindex", "0")
}

async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press("Control+,")
  await expect(page.getByRole("heading", { exact: true, name: "Workspace settings" })).toBeVisible()
}

test.beforeEach(async ({ page }) => {
  await openWorkspace(page)
})

test("@guard dispatches the default navigation and utility actions", async ({ page }) => {
  const searchScope = page.locator("[data-search-header-scope]")
  await expect(searchScope).toHaveAttribute("data-search-header-scope", "all")
  await page.keyboard.press("s")
  await expect(searchScope).toHaveAttribute("data-search-header-scope", "channel")
  await expect(page.locator("#message-search")).toHaveAttribute("placeholder", "Search this chat…")
  await page.keyboard.press("s")
  await expect(searchScope).toHaveAttribute("data-search-header-scope", "all")

  await page.keyboard.press("]")
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "research" })).toBeVisible()
  await expect(messageLocator(page, 5)).toBeVisible()
  await page.keyboard.press("[")
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "ops" })).toBeVisible()
  await expect(messageLocator(page, 1)).toBeVisible()

  await page.keyboard.press("j")
  await page.keyboard.press("j")
  await expectFocusedMessage(page, 2)
  await page.keyboard.press("ArrowDown")
  await expectFocusedMessage(page, 3)
  await page.keyboard.press("k")
  await expectFocusedMessage(page, 2)
  await page.keyboard.press("ArrowUp")
  await expectFocusedMessage(page, 1)
  await page.keyboard.press("u")
  await expectFocusedMessage(page, 10)
  await page.keyboard.press("Shift+G")
  await expectFocusedMessage(page, 11)

  await page.keyboard.press("/")
  await expect(page.locator("#message-search")).toBeFocused()
  await page.keyboard.press("Escape")
  await page.keyboard.press("c")
  await expect(page.locator("#message-composer")).toBeFocused()
  await page.keyboard.press("Control+Shift+a")
  await expect(page.locator("#attachment-path")).toBeFocused()
  await page.locator("#attachment-path").fill("/tmp/keyboard.md")
  await page.keyboard.press("Enter")
  await expect(page.getByText("/tmp/keyboard.md", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.locator("#attachment-path")).toHaveCount(0)
})

test("@guard does not dispatch single-key actions from text inputs", async ({ page }) => {
  const search = page.locator("#message-search")
  await page.keyboard.press("/")
  await expect(search).toBeFocused()
  await page.keyboard.press("s")
  await page.keyboard.press("]")
  await expect(search).toHaveValue("s]")
  await expect(page.locator("[data-search-header-scope]")).toHaveAttribute("data-search-header-scope", "all")
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "ops" })).toBeVisible()
  await expectFocusedMessage(page, 1)

  const composer = page.locator("#message-composer")
  await page.keyboard.press("Escape")
  await page.keyboard.press("c")
  await expect(composer).toBeFocused()
  await composer.fill("")
  await page.keyboard.type("jk/[]uG")
  await expect(composer).toHaveValue("jk/[]uG")
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "ops" })).toBeVisible()
  await expectFocusedMessage(page, 1)

  await page.keyboard.press("Control+k")
  await expect(page.getByRole("heading", { exact: true, name: "Switch channel" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(composer).toBeFocused()
})

test("@guard keeps the message list unchanged while the picker owns arrow keys", async ({ page }) => {
  const focused = messageLocator(page, 2)
  await focused.focus()
  await expectFocusedMessage(page, 2)
  await page.keyboard.press("Control+k")
  await expect(page.getByRole("heading", { exact: true, name: "Switch channel" })).toBeVisible()

  await page.keyboard.press("ArrowDown")
  await expect(page.getByRole("option", { name: "Attachments" })).toHaveAttribute("aria-selected", "true")
  await expectFocusedMessage(page, 2)
  for (const key of PAGE_SCOPE_KEYS) await page.keyboard.press(key)
  await expectFocusedMessage(page, 2)
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "ops" })).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { exact: true, name: "Switch channel" })).toHaveCount(0)
  await expect(focused).toBeFocused()

  await page.keyboard.press("Control+k")
  await expect(page.locator("#channel-picker-input")).toBeFocused()
  await page.keyboard.type("research")
  await expect(page.getByRole("option", { name: "research" })).toHaveCount(1)
  await page.keyboard.press("Enter")
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "research" })).toBeVisible()
})

test("@guard blocks page-scope actions on modal layers and keeps globals alive in the viewer", async ({ page }) => {
  const layers = [
    {
      heading: "Switch channel",
      open: () => page.keyboard.press("Control+k"),
    },
    {
      heading: "Workspace settings",
      open: () => openSettings(page),
    },
    {
      heading: "Keyboard shortcuts",
      open: () => page.keyboard.press("?"),
    },
    {
      heading: "Inbox",
      open: () => page.keyboard.press("b"),
    },
  ]

  for (const layer of layers) {
    const underlying = messageLocator(page, 2)
    await underlying.focus()
    await expectFocusedMessage(page, 2)
    await layer.open()
    await expect(page.getByRole("heading", { exact: true, name: layer.heading })).toBeVisible()
    for (const key of PAGE_SCOPE_KEYS) await page.keyboard.press(key)
    await expect(page.getByRole("heading", { exact: true, level: 1, name: "ops" })).toBeVisible()
    await expectFocusedMessage(page, 2)
    await page.keyboard.press("Escape")
    await expect(page.getByRole("heading", { exact: true, name: layer.heading })).toHaveCount(0)
    await expect(underlying).toBeFocused()
  }

  const viewerMessage = messageLocator(page, 4)
  await viewerMessage.focus()
  await expectFocusedMessage(page, 4)
  await page.keyboard.press("v")
  await expect(page.getByText("The staging deploy is ready.", { exact: true })).toBeVisible()
  await page.keyboard.press("m")
  await expect(page.getByRole("heading", { exact: true, name: /Members · #ops/ })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { exact: true, name: /Members · #ops/ })).toHaveCount(0)
  await page.keyboard.press("b")
  await expect(page.getByRole("heading", { exact: true, name: "Inbox" })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { exact: true, name: "Inbox" })).toHaveCount(0)
  const closeViewer = page.getByRole("button", { exact: true, name: "Close markdown viewer" })
  await expect(closeViewer).toBeVisible()
  await closeViewer.click()
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "ops" })).toBeVisible()
  await expect(page.getByText("The staging deploy is ready.", { exact: true })).toHaveCount(0)
})

test("@guard keeps global actions available when a markdown preview fails", async ({ page }) => {
  await page.route("**/api/attachments/103/content", async (route) => {
    await route.fulfill({ body: "Not found", contentType: "text/plain", status: 404 })
  })

  const focused = messageLocator(page, 4)
  await focused.focus()
  await page.keyboard.press("v")
  const attachmentError = page.locator('[data-slot="attachment"] p[role="alert"]')
  await expect(attachmentError).toHaveText("This file is no longer available.")
  expect(await page.locator("body").innerText()).not.toMatch(/ask the sender|send it again|preview is pinned|changed after it was sent/i)
  await expect(page.getByRole("button", { exact: true, name: "Close markdown viewer" })).toBeVisible()

  await page.keyboard.press("m")
  await expect(page.getByRole("heading", { exact: true, name: /Members · #ops/ })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { exact: true, name: /Members · #ops/ })).toHaveCount(0)

  await page.getByRole("button", { exact: true, name: "Close markdown viewer" }).click()
  await expect(attachmentError).toHaveCount(0)
})

test("@guard keeps global actions available while a markdown preview loads", async ({ page }) => {
  await page.route("**/api/attachments/103/content", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    await route.fulfill({ body: MARKDOWN_CONTENT, contentType: "text/markdown", status: 200 })
  })

  await messageLocator(page, 4).focus()
  await page.keyboard.press("v")
  await expect(page.getByText("Loading markdown…", { exact: true })).toBeVisible()

  await page.keyboard.press("m")
  await expect(page.getByRole("heading", { exact: true, name: /Members · #ops/ })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("heading", { exact: true, name: /Members · #ops/ })).toHaveCount(0)
})

test("@guard persists a rebinding and rejects a conflicting combo", async ({ page }) => {
  await openSettings(page)
  const searchBinding = page.getByRole("button", { exact: true, name: "Rebind Focus search" })
  await searchBinding.click()
  await page.keyboard.press("t")
  await page.getByRole("button", { exact: true, name: "Save bindings" }).click()
  await expect(page.getByText("Keyboard bindings saved.", { exact: true })).toBeVisible()

  const stored = await page.evaluate(() => localStorage.getItem("msgr.keyboard.v1"))
  expect(stored).not.toBeNull()
  expect(stored).toContain('"combo":"t"')
  await page.keyboard.press("Escape")
  await page.reload()
  await waitForWorkspace(page)
  await page.keyboard.press("t")
  await expect(page.locator("#message-search")).toBeFocused()

  await page.keyboard.press("Escape")
  await page.keyboard.press("?")
  const help = page.getByRole("list", { name: "Current keyboard shortcuts" })
  await expect(help.locator("li").filter({ hasText: "Focus search" }).locator("kbd")).toHaveText("t")
  await page.keyboard.press("Escape")
  await openSettings(page)
  await page.getByRole("button", { exact: true, name: "Rebind Focus search" }).click()
  await page.keyboard.press("s")
  await expect(page.getByText("Duplicate bindings are highlighted. Resolve them before saving.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { exact: true, name: "Save bindings" })).toBeDisabled()
  await page.getByRole("button", { exact: true, name: "Reset defaults" }).click()
  await expect(page.getByRole("button", { exact: true, name: "Save bindings" })).toBeEnabled()
})

test("@guard falls back to defaults when stored bindings are stale", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("msgr.keyboard.v1", JSON.stringify({ bindings: [], version: 1 }))
  })
  await page.reload()
  await waitForWorkspace(page)
  await page.keyboard.press("/")
  await expect(page.locator("#message-search")).toBeFocused()
})

test("@guard supports composer newline, send, and the eight-line grow cap", async ({ page }) => {
  const composer = page.locator("#message-composer")
  await composer.fill("first line")
  await composer.press("Shift+Enter")
  await expect(composer).toHaveValue("first line\n")

  await composer.fill(Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"))
  await expect.poll(async () => Number.parseFloat(await composer.evaluate((element) => element.style.height))).toBeLessThanOrEqual(192)
  await expect(composer).toHaveCSS("overflow-y", "auto")

  await composer.fill("sent from the keyboard")
  const sendRequest = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/api/channels/ops/messages"),
  )
  await composer.press("Enter")
  await sendRequest
  await expect(page.getByText("sent from the keyboard", { exact: true })).toBeVisible()
})

test("@guard keeps composer behavior after automatic identification", async ({ page }) => {
  // A session with no stored identity identifies itself: exactly one POST
  // /api/humans, no name input, and the composer sends directly after it.
  const humanPosts: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/humans") {
      humanPosts.push(request.postData() ?? "")
    }
  })
  await page.evaluate(() => {
    sessionStorage.setItem("e2e.anonymous", "true")
    localStorage.removeItem("msgr.identity.v1")
  })
  await page.reload()
  await waitForWorkspace(page)

  const composer = page.locator("#message-composer")
  await page.keyboard.press("c")
  await expect(composer).toBeFocused()
  await composer.fill("draft before identity")
  await composer.press("Shift+Enter")
  await expect(composer).toHaveValue("draft before identity\n")
  const sendRequest = page.waitForRequest((request) =>
    request.method() === "POST" && request.url().endsWith("/api/channels/ops/messages"),
  )
  await page.keyboard.press("Enter")
  await sendRequest
  await expect(composer).toHaveValue("")
  await expect(page.locator("#composer-identity")).toHaveCount(0)
  expect(humanPosts, "the automatic claim happens exactly once").toHaveLength(1)
  expect(JSON.parse(humanPosts[0] ?? "{}")).toEqual({ handle: "human" })
})

test("@guard copies and views the focused attachment through keyboard actions", async ({ page }) => {
  const focused = messageLocator(page, 4)
  await focused.focus()
  await page.keyboard.press("y")
  await expect(page.getByTitle("Copied")).toBeVisible()
  await expect(page.evaluate(() => navigator.clipboard.readText())).resolves.toBe("/Users/demo/notes/runbook.pdf")

  const markdownCopy = focused.locator('[data-attachment-id="103"] [data-attachment-action="copy"]')
  await markdownCopy.focus()
  await page.keyboard.press("y")
  await expect(page.evaluate(() => navigator.clipboard.readText())).resolves.toBe("/Users/demo/notes/release-notes.md")

  await focused.focus()
  await page.keyboard.press("v")
  await expect(page.getByText("The staging deploy is ready.", { exact: true })).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByText("The staging deploy is ready.", { exact: true })).toHaveCount(0)
  await expect(focused).toBeFocused()
})

test("@guard captures modifier chords as one binding", async ({ page }) => {
  await openSettings(page)
  const searchBinding = page.getByRole("button", { exact: true, name: "Rebind Focus search" })
  await searchBinding.click()
  await page.keyboard.press("Control+f")
  await expect(searchBinding.locator("kbd")).toHaveText("Ctrl+F")
  await page.getByRole("button", { exact: true, name: "Save bindings" }).click()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Control+f")
  await expect(page.locator("#message-search")).toBeFocused()
})
