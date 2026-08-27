/**
 * The UX merge contract for web changes.
 *
 * `@guard` tests cover behaviour that works today. They must stay green; a web
 * change that breaks one is a regression and does not merge.
 *
 * `@finding` identifies focused UX regression cases.
 *
 * Everything runs against the preview build with the API mocked, so no hub and no
 * real participants are involved.
 */

import { expect, test, type Locator, type Page, type Route } from "@playwright/test"
import { createServer, type ServerResponse } from "node:http"
import * as v from "valibot"

import { mockAttachments, mockChannels, mockInbox, mockLaunchers, mockMembers, mockMessages, mockModelCatalogue, mockModels } from "../src/api/fixtures"
import type { Message, ModelCatalogueSnapshot } from "../src/api/types"

declare global {
  interface Window {
    /** Installed by `installLiveStream`, absent otherwise. */
    __pushLiveRecord?: (path: string, record: Message | JsonValue, event?: string) => boolean
    /** Ends one held-open stream, so the client takes its reconnect path. */
    __endLiveStream?: (path: string) => boolean
    /** How many times each held-open stream has been opened by the client. */
    __liveStreamOpens?: (path: string) => number
    /** Makes the next `times` opens of `path` fail, as a starved connection does. */
    __failLiveStream?: (path: string, times: number) => void
    /** React commits observed by the render-stability guard. */
    __herdrReactCommits?: number
    /** Skeleton sightings recorded by the reconnect check. */
    __seen?: { channels: number; workspaces: number }
    /** Theme writes observed before and during application boot. */
    __themeWrites?: string[]
  }
}

const MARKDOWN_BODY = "# Release notes\n\n- Verify the migration window\n- Run smoke checks\n"
const CURRENT_MARKDOWN_BODY = "# Current file\n\nThis is the content after the file changed on disk.\n"
const LATEST_MARKDOWN_BODY = "# Latest file\n\nThis is the latest content on disk.\n"
const TINY_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
const REQUIRED_SURFACE_KINDS = ["code-chip", "notice", "menu", "dialog", "error-text"] as const

const createLauncherRequestSchema = v.object({
  agentKind: v.string(),
  argv: v.array(v.string()),
  name: v.string(),
  startTimeoutMs: v.optional(v.number()),
})

const updateLauncherRequestSchema = v.object({
  agentKind: v.string(),
  argv: v.array(v.string()),
  startTimeoutMs: v.optional(v.number()),
})

const acknowledgementRequestSchema = v.object({
  throughId: v.number(),
})

const sendMessageRequestSchema = v.object({
  attachments: v.optional(v.array(v.string())),
  body: v.string(),
})

/** A markdown attachment, and a message whose timestamp crosses a UTC date boundary. */
function messagesForContract(): Message[] {
  const base = mockMessages.map((message) => ({
    ...message,
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
  }))
  const withMarkdown = base.find((message) =>
    message.attachments.some((attachment) => attachment.mediaType === "text/markdown"),
  )
  if (withMarkdown === undefined) throw new Error("fixtures lost the markdown attachment")
  return base
}

function acknowledgementTimingMessage(id: number): Message {
  const template = mockMessages.find((message) => message.channel === "ops")
  if (template === undefined) throw new Error("fixtures lost an ops message")
  return {
    ...template,
    id,
    body: `Acknowledgement timing probe ${String(id)}`,
    attachments: [],
  }
}

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement) active.blur()
  })
}

/** Makes message visibility reachable in a headless viewport for acknowledgement guards. */
async function forceVisibleMessages(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const visibleObserver = class {
      public readonly root: Element | null = null
      public readonly rootMargin = "0px"
      public readonly thresholds: readonly number[] = [0]
      private readonly callback: IntersectionObserverCallback
      private readonly targets = new Set<Element>()
      private readonly timer: number

      public constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
        this.timer = globalThis.setInterval(() => this.emit(), 50)
      }

      public disconnect(): void {
        globalThis.clearInterval(this.timer)
        this.targets.clear()
      }

      public observe(target: Element): void {
        this.targets.add(target)
        this.emit()
      }

      private emit(): void {
        for (const target of this.targets) {
          const rect = target.getBoundingClientRect()
          const entry = {
            boundingClientRect: rect,
            intersectionRatio: 1,
            intersectionRect: rect,
            isIntersecting: true,
            rootBounds: null,
            target,
            time: performance.now(),
          } satisfies IntersectionObserverEntry
          this.callback([entry], this)
        }
      }

      public takeRecords(): IntersectionObserverEntry[] {
        return []
      }

      public unobserve(target: Element): void {
        this.targets.delete(target)
      }
    }
    globalThis.IntersectionObserver = visibleObserver
  })
}

/** Parses a request body without asserting its type. Throws if it is not an object. */
function parseJsonObject(text: string): JsonObject {
  const parsed: JsonValue = JSON.parse(text)
  if (!(parsed instanceof Object) || Array.isArray(parsed)) throw new Error("expected a JSON object")
  return parsed
}

async function fulfillJson(route: Route, payload: JsonValue): Promise<void> {
  await route.fulfill({ body: JSON.stringify(payload), contentType: "application/json", status: 200 })
}

interface MockOptions {
  identityHandle?: string
  /** Serve one channel without the current identity until Join is used. */
  nonMemberChannel?: string
  /** Fail the attachment preview, to reach the viewer's error state. */
  previewStatus?: number
  /** Serve valid image bytes for the image attachment preview contract. */
  imagePreview?: boolean
  /** Extra channels, for the sidebar scaling check. */
  extraChannels?: number
  /** Serve one direct conversation. */
  withDirect?: boolean
  /** Simulate a soft-deleted participant whose historical messages and DM remain. */
  deactivatedHandle?: string
  /** Load with no stored identity, the state an operator lands in before first send. */
  anonymous?: boolean
  /** Some checks inspect the sidebar while the selected channel is empty. */
  waitForMessages?: boolean
  /** Return 401 for identity-scoped reads to verify the terminal session state. */
  expiredSession?: boolean
  /**
   * Hold both event streams open so the test can push records into them.
   * See `installLiveStream`.
   */
  liveStream?: boolean
  /** Start the transcript empty so an acknowledgement window is test-controlled. */
  ackTimingFixture?: boolean
  /** Route the message stream to a shared test server instead of the page stub. */
  sharedLiveStream?: boolean
  /** Add working panes to make the workspace list scroll. */
  topologyExtraPanes?: JsonValue[]
  /** Promote one fixture pane in a topology snapshot. */
  promotedPaneId?: string
  /** Replace the default topology for scale and ordering guards. */
  topology?: JsonValue
  /** Responses for the agent lifecycle endpoints. */
  lifecycle?: {
    harnesses?: string[]
    launchers?: { name: string; agentKind: string; argv: string[]; envKeys?: string[]; startTimeoutMs?: number }[]
    roles?: { name: string; summary: string; native?: boolean; agentKind?: string | null; launcher?: string | null; model?: string | null; effort?: string | null }[]
    models?: { harness: string; name: string; label?: string }[]
    modelCatalogue?: ModelCatalogueSnapshot
    modelCatalogueRefresh?: ModelCatalogueSnapshot
    modelCatalogueRefreshFailure?: { status: number; body: JsonValue }
    roleDetails?: Record<string, { name: string; summary: string; briefing: string; native?: boolean; agentKind?: string | null; launcher?: string | null; model?: string | null; effort?: string | null }>
    /** The body of a successful `POST /api/herdr/agents`. */
    spawn?: JsonValue
    spawnFailure?: { status: number; body: JsonValue }
    stopFailure?: { status: number; body: JsonValue }
  }
}

async function installApiMocks(page: Page, options: MockOptions = {}): Promise<void> {
  const messages = options.ackTimingFixture === true ? [] : messagesForContract()
  const directHandle = options.deactivatedHandle ?? "lead"
  const activeParticipants = mockMembers
    .filter((member) => member.handle !== options.deactivatedHandle)
    .map((member) => ({ ...member }))
  if (options.withDirect === true && options.deactivatedHandle === undefined) {
    activeParticipants.push({
      agentKind: "claude",
      handle: "lead",
      joinedAt: "2026-08-12T08:08:00.000Z",
      kind: "agent",
      routeState: "active",
      unread: 0,
    })
  }
  const channels = [
    ...mockChannels.map((channel) => ({ ...channel })),
    ...Array.from({ length: options.extraChannels ?? 0 }, (_unused, index) => ({
      id: 500 + index,
      kind: "chat",
      name: `alpha-${String(index).padStart(2, "0")}`,
      topic: null,
      memberCount: 3,
      messageCount: 5,
      lastMessageAt: "2026-08-17T15:00:00.000Z",
    })),
  ].sort((left, right) => left.name.localeCompare(right.name))
  let joinedNonMemberChannel: string | undefined

  await page.route("**/api/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    if (url.pathname === "/api/herdr/launchers" && method === "GET") {
      const configuredLaunchers = options.lifecycle?.launchers ?? mockLaunchers
      await fulfillJson(route, { launchers: configuredLaunchers.map((launcher) => ({ ...launcher, argv: [...launcher.argv], envKeys: launcher.envKeys ?? [], startTimeoutMs: launcher.startTimeoutMs ?? 35_000 })) })
      return
    }

    // Dedicated topology and search handlers are registered before this broad
    // route. Let Playwright continue to those handlers instead of returning the
    // generic `{}` response below.
    if (url.pathname === "/api/search" || url.pathname.startsWith("/api/herdr/")) {
      await route.fallback()
      return
    }

    if (url.pathname === "/api/events") {
      if (options.sharedLiveStream === true) {
        await route.fallback()
        return
      }
      await route.fulfill({ body: ": ready\n\n", contentType: "text/event-stream", status: 200 })
      return
    }
    if (options.expiredSession === true && (
      url.pathname === "/api/inbox"
      || url.pathname === "/api/direct"
      || url.pathname.endsWith("/members")
      || url.pathname.endsWith("/messages")
    )) {
      await route.fulfill({ body: JSON.stringify({ code: "Unauthorized", error: "A valid token is required" }), contentType: "application/json", status: 401 })
      return
    }
    if (url.pathname.startsWith("/api/attachments/")) {
      if (options.imagePreview === true && url.pathname === "/api/attachments/101/content") {
        await route.fulfill({ body: TINY_PNG, contentType: "image/png", status: 200 })
        return
      }
      const status = options.previewStatus ?? 200
      if (status === 200) {
        await route.fulfill({ body: MARKDOWN_BODY, contentType: "text/markdown", status: 200 })
        return
      }
      await route.fulfill({
        body: JSON.stringify({ error: "Attachment not found", code: "NotFound" }),
        contentType: "application/json",
        status,
      })
      return
    }
    if (url.pathname === "/api/channels" && method === "GET") {
      await fulfillJson(route, { channels })
      return
    }
    if (url.pathname === "/api/channels" && method === "POST") {
      await route.fulfill({
        body: JSON.stringify({ error: "name must start with a letter and use only a-z, 0-9, _ or - (max 32)", code: "ValidationFailed" }),
        contentType: "application/json",
        status: 400,
      })
      return
    }
    if (url.pathname === "/api/inbox") {
      const entries = mockInbox.map((entry) => {
        const senders = entry.senders.filter((handle) => handle !== options.deactivatedHandle)
        return { ...entry, senders, unread: entry.senders.length > 0 && senders.length === 0 ? 0 : entry.unread }
      })
      if (options.withDirect === true) {
        // The inbox returns direct conversations under their storage name, so the
        // dm- assertion below is only meaningful when one is present.
        entries.push({
          channel: "dm-abc123def456",
          unread: options.deactivatedHandle === undefined ? 3 : 0,
          senders: options.deactivatedHandle === undefined ? [directHandle] : [],
          routeState: "active",
          pushEnabled: false,
        })
      }
      await fulfillJson(route, { entries })
      return
    }
    if (url.pathname === "/api/direct" && method === "GET") {
      await fulfillJson(route, {
        conversations: options.withDirect === true
          ? [{ channel: "dm-abc123def456", participants: [directHandle], unread: 0 }]
          : [],
      })
      return
    }
    if (url.pathname === "/api/participants") {
      await fulfillJson(route, { participants: activeParticipants })
      return
    }
    if (url.pathname.endsWith("/join") && method === "POST") {
      const channel = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      if (options.nonMemberChannel === channel) joinedNonMemberChannel = channel
      await fulfillJson(route, { channel, cursorId: 10 })
      return
    }
    if (url.pathname.endsWith("/members") && method === "GET") {
      const channel = decodeURIComponent(url.pathname.split("/").at(-2) ?? "")
      const nonMember = options.nonMemberChannel === channel && joinedNonMemberChannel !== channel
      const identityHandle = options.identityHandle ?? "operator"
      if (options.withDirect === true && channel === "dm-abc123def456") {
        await fulfillJson(route, {
          members: [{
            agentKind: "claude",
            handle: directHandle,
            joinedAt: "2026-08-12T08:08:00.000Z",
            kind: "agent",
            routeState: "active",
            unread: 0,
          }],
        })
        return
      }
      await fulfillJson(route, {
        members: mockMembers
          .filter((member) => member.handle !== options.deactivatedHandle)
          .filter((member) => !nonMember || member.handle !== identityHandle)
          .map((member) => ({ ...member })),
      })
      return
    }
    if (url.pathname.endsWith("/messages") && method === "GET") {
      await fulfillJson(route, { messages })
      return
    }
    if (url.pathname === "/api/humans" && method === "POST") {
      // Anonymous means the automatic identify FAILED: it is the only unidentified
      // state left, so the mock must refuse the claim to make it reachable.
      if (options.anonymous === true) {
        await route.fulfill({ body: JSON.stringify({ code: "Internal", error: "identify refused for this check" }), contentType: "application/json", status: 503 })
        return
      }
      await fulfillJson(route, { handle: options.identityHandle ?? "operator" })
      return
    }
    if (method === "GET") {
      await fulfillJson(route, {})
      return
    }
    await fulfillJson(route, { channel: "dm-abc123def456", cursorId: 0, messageId: 0 })
  })
}

/**
 * Holds the event stream open for the life of the page, so a test can deliver a
 * record and then measure what that arrival cost.
 *
 * `route.fulfill` cannot do this. It answers with a complete body, so the stream
 * ends the moment it is served, and the client reconnects. A reconnect calls
 * `onRecovery` and re-runs the snapshot load, which re-sweeps every roster — so a
 * check built on `route.fulfill` measures reconnect behaviour and reports it as the
 * cost of an arriving record. This patches `fetch` inside the page instead and keeps
 * one stream open per page, which is the only way the connection budget can be
 * measured.
 *
 * `/api/events` is seeded with a topology event when it opens, because the client
 * renders no workspaces until its first snapshot, and a test that had to push that
 * first snapshot itself could not tell an update apart from an initial load.
 */
async function installLiveStream(page: Page, topology?: JsonValue): Promise<void> {
  await page.addInitScript((seed: JsonValue | undefined) => {
    const encoder = new TextEncoder()
    const sinks = new Map<string, ReadableStreamDefaultController<Uint8Array>>()
    const opens = new Map<string, number>()
    const failures = new Map<string, number>()
    const held = new Set(["/api/events", "/api/herdr/events"])
    const passThrough = globalThis.fetch.bind(globalThis)

    const patched: typeof globalThis.fetch = (input, init) => {
      const href = String(input instanceof Request ? input.url : input)
      const path = new URL(href, globalThis.location.origin).pathname
      if (!held.has(path)) return passThrough(input, init)
      const pending = failures.get(path) ?? 0
      if (pending > 0) {
        failures.set(path, pending - 1)
        opens.set(path, (opens.get(path) ?? 0) + 1)
        return Promise.reject(new TypeError("Failed to fetch"))
      }
      const body = new ReadableStream<Uint8Array>({
        cancel: () => { sinks.delete(path) },
        start: (controller) => {
          sinks.set(path, controller)
          opens.set(path, (opens.get(path) ?? 0) + 1)
          controller.enqueue(encoder.encode(": ready\n\n"))
          if (path === "/api/events" && seed !== undefined) {
            controller.enqueue(encoder.encode(`event: topology\ndata: ${JSON.stringify(seed)}\n\n`))
          }
          init?.signal?.addEventListener("abort", () => { sinks.delete(path) }, { once: true })
        },
      })
      return Promise.resolve(new Response(body, {
        headers: { "Content-Type": "text/event-stream" },
        status: 200,
      }))
    }
    globalThis.fetch = patched

    window.__pushLiveRecord = (path, record, event): boolean => {
      const sink = sinks.get(path)
      if (sink === undefined) return false
      const prefix = event === undefined ? "" : `event: ${event}\n`
      sink.enqueue(encoder.encode(`${prefix}data: ${JSON.stringify(record)}\n\n`))
      return true
    }
    window.__liveStreamOpens = (path): number => opens.get(path) ?? 0

    window.__failLiveStream = (path, times): void => { failures.set(path, times) }

    window.__endLiveStream = (path): boolean => {
      const sink = sinks.get(path)
      if (sink === undefined) return false
      sinks.delete(path)
      sink.error(new Error("forced stream drop"))
      return true
    }
  }, topology)
}

interface SharedEventRecord {
  data: JsonValue | Message
  event?: string
  id?: string
}

interface SharedEventServer {
  readonly lastEventIds: string[]
  readonly sentIds: string[]
  readonly opens: number
  readonly url: string
  close: () => Promise<void>
  keepalive: () => number
  send: (record: SharedEventRecord) => void
}

/** Serves one held-open SSE connection so several pages can share one owner. */
async function startSharedEventServer(topology: JsonValue): Promise<SharedEventServer> {
  const responses = new Set<ServerResponse>()
  const lastEventIds: string[] = []
  const sentIds: string[] = []
  let opens = 0
  const write = (response: ServerResponse, record: SharedEventRecord): void => {
    if (record.id !== undefined) response.write(`id: ${record.id}\n`)
    if (record.event !== undefined) response.write(`event: ${record.event}\n`)
    response.write(`data: ${JSON.stringify(record.data)}\n\n`)
  }
  const server = createServer((request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Headers": "Accept, Last-Event-ID",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Origin": request.headers.origin ?? "*",
      })
      response.end()
      return
    }
    if (request.url !== "/events") {
      response.writeHead(404)
      response.end()
      return
    }
    opens += 1
    const originHeader = request.headers.origin
    const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader
    response.writeHead(200, {
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Allow-Origin": origin ?? "*",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream",
    })
    response.write(": ready\n\n")
    responses.add(response)
    request.on("close", () => responses.delete(response))
    const lastEventIdHeader = request.headers["last-event-id"]
    lastEventIds.push(Array.isArray(lastEventIdHeader) ? (lastEventIdHeader[0] ?? "") : (lastEventIdHeader ?? ""))
    if (opens === 1) {
      sentIds.push("100")
      write(response, { data: topology, event: "topology", id: "100" })
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (address === null) throw new Error("shared event server did not expose a port")
  const parsedAddress = v.safeParse(v.object({ port: v.number() }), address)
  if (!parsedAddress.success) throw new Error("shared event server did not expose a port")
  const send = (record: SharedEventRecord): void => {
    if (record.id !== undefined) sentIds.push(record.id)
    for (const response of responses) {
      if (!response.writableEnded) write(response, record)
    }
  }
  const keepalive = (): number => {
    let delivered = 0
    for (const response of responses) {
      if (response.writableEnded) continue
      response.write(": keepalive\n\n")
      delivered += 1
    }
    return delivered
  }
  return {
    get opens() { return opens },
    lastEventIds,
    sentIds,
    url: `http://127.0.0.1:${parsedAddress.output.port}/events`,
    close: async () => {
      for (const response of responses) response.end()
      responses.clear()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error))
      })
    },
    keepalive,
    send,
  }
}

/** Pushes one message into the held-open transcript stream. False if it is not open. */
async function pushLiveMessage(page: Page, record: Message): Promise<boolean> {
  return page.evaluate(
    (payload) => window.__pushLiveRecord?.("/api/events", payload) ?? false,
    record,
  )
}

/** Pushes one topology snapshot into the held-open event stream. False if not open. */
async function pushTopologySnapshot(page: Page, snapshot: JsonValue): Promise<boolean> {
  return page.evaluate(
    (payload) => window.__pushLiveRecord?.("/api/events", payload, "topology") ?? false,
    snapshot,
  )
}

/**
 * Counts React commits from the page's pre-boot DevTools hook. The counter is
 * read-only and cannot schedule a render; the guard must not measure itself.
 */
async function installReactCommitCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let commits = 0
    window.__herdrReactCommits = 0
    Object.defineProperty(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: true,
      value: {
        inject: () => 1,
        onCommitFiberRoot: () => {
          commits += 1
          window.__herdrReactCommits = commits
        },
        onCommitFiberUnmount: () => undefined,
        supportsFiber: true,
      },
    })
  })
}

async function reactCommitCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__herdrReactCommits ?? 0)
}

/** Waits for an observed browser paint instead of sleeping for a wall-clock period. */
async function waitForNextPaint(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function openApp(page: Page, options: MockOptions = {}): Promise<void> {
  if (options.liveStream === true) await installLiveStream(page, topologyForOptions(options))
  await installApiMocks(page, options)
  if (options.anonymous !== true) {
    await page.addInitScript((handle: string) => {
      window.localStorage.setItem("msgr.identity.v1", JSON.stringify({ version: 1, hub: window.location.origin, handle }))
    }, options.identityHandle ?? "operator")
  }
  await page.goto("/")
  await expect(page.locator("[data-sidebar-rail]")).toBeVisible()
  await expect(page.locator('[data-channel-row="ops"]')).toBeVisible()
  if (options.waitForMessages !== false && options.anonymous !== true) {
    await page.locator('[data-slot="message-scroller-item"]').first().waitFor()
  }
}

/** Opens the markdown viewer for the fixture's markdown attachment. */
async function clickViewAction(page: Page): Promise<void> {
  const markdownCard = page.locator('[data-slot="attachment"]').filter({ hasText: "release-notes.md" }).first()
  const view = markdownCard.locator('[data-attachment-action="view"]')
  await view.scrollIntoViewIfNeeded()
  await expect(view).toBeVisible()
  await view.click()
}

async function clickAttachmentAction(card: Locator, action: "close-viewer" | "view"): Promise<void> {
  const button = card.locator(`[data-attachment-action="${action}"]`)
  await button.scrollIntoViewIfNeeded()
  await expect(button).toBeVisible()
  await button.click()
}

async function openMarkdownViewer(page: Page): Promise<void> {
  await clickViewAction(page)
  await expect(page.locator(".prose")).toBeVisible()
}

/**
 * True when a global single-key action still reaches the action registry.
 *
 * The dialog must be absent before the key is pressed, otherwise a leftover
 * overlay reads as a success and the probe lies.
 */
async function globalKeyWorks(page: Page): Promise<boolean> {
  const dialog = page.locator('[role="dialog"]')
  await expect(dialog).toHaveCount(0)
  await blurActiveElement(page)
  await page.keyboard.press("m")
  const opened = await dialog.first().isVisible({ timeout: 1500 }).catch(() => false)
  if (opened) {
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
  }
  return opened
}

/**
 * Topology shaped to exercise every workspace row type at once: a workspace with
 * participants including one stale route, a workspace with none, an empty pane, a
 * pane carrying a label but no participant, and an unlabeled workspace.
 */
/** `extraPanes` are appended to Personal-Projects, for arrival checks. */
function topologyFixture(
  extraPanes: JsonValue[] = [],
  promotedPaneId?: string,
  reviewerRouteState: "active" | "stale" = "stale",
  leadRouteState: "active" | "stale" = "active",
): JsonValue {
  const quietPane: JsonValue = {
    paneId: "w1A:p1", label: null, agentKind: "codex", agentStatus: promotedPaneId === "w1A:p1" ? "working" : "idle", focused: false, participant: null, participantRouteState: null,
  }
  const personalPanes: JsonValue[] = [
    { paneId: "w1H:p1", label: null, agentKind: "claude", agentStatus: "working", focused: false, participant: "lead", participantRouteState: leadRouteState },
    { paneId: "w1H:p3", label: "reviewer-pane", agentKind: "codex", agentStatus: "working", focused: false, participant: "codex-reviewer", participantRouteState: reviewerRouteState },
    { paneId: "w1H:p9", label: null, agentKind: null, agentStatus: "unknown", focused: false, participant: null, participantRouteState: null },
    { paneId: "w1H:pB", label: "spare", agentKind: "codex", agentStatus: "idle", focused: false, participant: null, participantRouteState: null },
    ...extraPanes,
  ]
  return {
    workspaces: [
      {
        id: "w1A", label: "quiet-repo", panes: [quietPane],
        tabs: [{ id: "w1A:tab-main", label: "Main", panes: [quietPane] }],
      },
      { id: "w1N", label: null, panes: [], tabs: [] },
      {
        id: "w1H", label: "Personal-Projects", panes: personalPanes,
        tabs: [{ id: "w1H:tab-main", label: "Main", panes: personalPanes }],
      },
    ],
  }
}

function topologyForOptions(options: MockOptions): JsonValue {
  return options.topology ?? topologyFixture(options.topologyExtraPanes, options.promotedPaneId)
}

type DirectoryAgentStatus = "blocked" | "done" | "idle" | "working"

function directoryAgentPane(paneId: string, participant: string, agentStatus: DirectoryAgentStatus, participantRouteState: "active" | "stale" = "active", focused = false): JsonObject {
  return { agentKind: "codex", agentStatus, focused, label: null, paneId, participant, participantRouteState }
}

function directoryEmptyPane(paneId: string): JsonObject {
  return { agentKind: null, agentStatus: "unknown", focused: false, label: null, paneId, participant: null, participantRouteState: null }
}

function directoryWorkspace(id: string, label: string | null, panes: JsonObject[]): JsonObject {
  return { id, label, panes, tabs: [] }
}

function workspaceDirectoryScaleTopology(): JsonValue {
  const residuePanes = Array.from({ length: 10 }, (_unused, index) => directoryAgentPane(`residue-${index}`, `residue-${index}`, "working", "stale"))
  const capPanes = [
    directoryAgentPane("cap-idle-a", "cap-idle-a", "idle"),
    directoryAgentPane("cap-done-a", "cap-done-a", "done"),
    directoryAgentPane("cap-working-a", "cap-working-a", "working"),
    directoryAgentPane("cap-blocked", "cap-blocked", "blocked"),
    directoryAgentPane("cap-focused", "cap-focused", "idle", "active", true),
    directoryAgentPane("cap-idle-b", "cap-idle-b", "idle"),
    directoryAgentPane("cap-stale", "codex-reviewer", "working", "stale"),
    directoryAgentPane("cap-working-b", "cap-working-b", "working"),
    directoryAgentPane("cap-done-b", "cap-done-b", "done"),
    directoryAgentPane("cap-idle-c", "cap-idle-c", "idle"),
  ]
  const workspaces = [
    directoryWorkspace("ws-zero-c", "Zero C", []),
    directoryWorkspace("ws-five", "Five", Array.from({ length: 5 }, (_unused, index) => directoryAgentPane(`five-${index}`, `five-${index}`, "idle"))),
    directoryWorkspace("ws-cap", "Cap", capPanes),
    directoryWorkspace("ws-empty", "Empty", [directoryEmptyPane("empty-a"), directoryEmptyPane("empty-b"), directoryEmptyPane("empty-c")]),
    directoryWorkspace("ws-six-active", "Six active", Array.from({ length: 6 }, (_unused, index) => directoryAgentPane(`six-active-${index}`, `six-active-${index}`, "working"))),
    directoryWorkspace("ws-one", "One", [directoryAgentPane("one", "one", "done")]),
    directoryWorkspace("ws-residue", "Residue", residuePanes),
    directoryWorkspace("ws-zero-a", "Zero A", []),
    directoryWorkspace("ws-four", "Four", Array.from({ length: 4 }, (_unused, index) => directoryAgentPane(`four-${index}`, `four-${index}`, "idle"))),
    directoryWorkspace("ws-six-stale", "Six stale", Array.from({ length: 6 }, (_unused, index) => directoryAgentPane(`six-stale-${index}`, `six-stale-${index}`, "idle", "stale"))),
    directoryWorkspace("ws-two", "Two", Array.from({ length: 2 }, (_unused, index) => directoryAgentPane(`two-${index}`, `two-${index}`, "blocked"))),
    directoryWorkspace("ws-three", "Three", Array.from({ length: 3 }, (_unused, index) => directoryAgentPane(`three-${index}`, `three-${index}`, "done"))),
    directoryWorkspace("ws-zero-b", "Zero B", []),
  ]
  return { workspaces: workspaces.toReversed() }
}

/** An empty pane that carries a label, the only shape `Close pane` applies to. */
const EMPTY_LABELLED_PANE: JsonValue = {
  paneId: "w1H:pE", label: "scratch", agentKind: null, agentStatus: "unknown", focused: false, participant: null, participantRouteState: null,
}

/** The pane a spawn would add. Used to prove an arrival is distinguishable. */
const SPAWNED_PANE: JsonValue = {
  paneId: "w1H:pF", label: null, agentKind: "claude", agentStatus: "idle", focused: false, participant: "spawned-agent", participantRouteState: "active",
}

const REPORTER_PANE: JsonValue = {
  paneId: "w1H:pReporter", label: "reporter-personal-projects", agentKind: "claude", agentStatus: "working", focused: false, participant: "reporter-personal-projects", participantRouteState: "active",
}

/** A blocked participant used to prove that the paused orb keeps its alert color. */
const BLOCKED_PANE: JsonValue = {
  paneId: "w1H:pBlocked", label: null, agentKind: "codex", agentStatus: "blocked", focused: false, participant: "blocked-agent", participantRouteState: "active",
}

async function openWithTopology(page: Page, options: MockOptions = {}): Promise<void> {
  await page.route("**/api/herdr/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/herdr/events") {
      await route.fulfill({ body: `data: ${JSON.stringify(topologyForOptions(options))}\n\n`, contentType: "text/event-stream", status: 200 })
      return
    }
    const method = route.request().method()
    if (url.pathname === "/api/herdr/launchers") {
      // Deliberately NON-DERIVABLE from the name, per checklist 11.9 item 3: a client
      // that rebuilds the preview from the launcher name renders something different
      // and fails, where a `codex -> ["codex"]` fixture would match by coincidence.
      const configuredLaunchers = options.lifecycle?.launchers ?? [
        { name: "claude-personal", agentKind: "claude", argv: ["claude", "--profile", "personal"] },
        { name: "codex", agentKind: "codex", argv: ["codex"] },
      ]
      await fulfillJson(route, {
        launchers: configuredLaunchers.map((launcher) => ({ ...launcher, envKeys: launcher.envKeys ?? [], startTimeoutMs: launcher.startTimeoutMs ?? 35_000 })),
      })
      return
    }
    if (url.pathname === "/api/herdr/harnesses") {
      await fulfillJson(route, { harnesses: options.lifecycle?.harnesses ?? ["claude", "codex"] })
      return
    }
    if (url.pathname === "/api/herdr/launchers") {
      await fulfillJson(route, { launchers: mockLaunchers.map((launcher) => ({ ...launcher, argv: [...launcher.argv] })) })
      return
    }
    if (url.pathname === "/api/herdr/roles" && method === "GET") {
      await fulfillJson(route, { roles: options.lifecycle?.roles ?? [
        { agentKind: "codex", effort: null, launcher: "codex", model: null, name: "worker", summary: "General task worker." },
        { name: "reporter", summary: "Observes and posts progress." },
      ] })
      return
    }
    if (url.pathname.startsWith("/api/herdr/roles/") && method === "GET") {
      const name = decodeURIComponent(url.pathname.slice("/api/herdr/roles/".length))
      const configured = options.lifecycle?.roleDetails?.[name]
      const preset = options.lifecycle?.roles?.find((role) => role.name === name)
      await fulfillJson(route, { role: configured ?? { name, summary: preset?.summary ?? "Role briefing", briefing: "Role briefing." , agentKind: preset?.agentKind ?? null, launcher: preset?.launcher ?? null, model: preset?.model ?? null, effort: preset?.effort ?? null } })
      return
    }
    if (url.pathname === "/api/herdr/roles" && method === "POST") {
      const body = parseJsonObject(route.request().postData() ?? "{}")
      await fulfillJson(route, body)
      return
    }
    if (url.pathname === "/api/herdr/models" && method === "GET") {
      await fulfillJson(route, { models: options.lifecycle?.models ?? mockModels })
      return
    }
    if (url.pathname === "/api/herdr/models" && method === "POST") {
      const body = parseJsonObject(route.request().postData() ?? "{}")
      delete body.argvSuffix
      await fulfillJson(route, body)
      return
    }
    if (url.pathname === "/api/herdr/model-catalogue" && method === "GET") {
      await fulfillJson(route, options.lifecycle?.modelCatalogue ?? mockModelCatalogue)
      return
    }
    if (url.pathname === "/api/herdr/model-catalogue" && method === "POST") {
      const failure = options.lifecycle?.modelCatalogueRefreshFailure
      if (failure !== undefined) {
        await route.fulfill({ body: JSON.stringify(failure.body), contentType: "application/json", status: failure.status })
        return
      }
      await fulfillJson(route, options.lifecycle?.modelCatalogueRefresh ?? options.lifecycle?.modelCatalogue ?? mockModelCatalogue)
      return
    }
    if (url.pathname === "/api/herdr/agents" && method === "POST") {
      const failure = options.lifecycle?.spawnFailure
      if (failure !== undefined) {
        await route.fulfill({ body: JSON.stringify(failure.body), contentType: "application/json", status: failure.status })
        return
      }
      await fulfillJson(route, options.lifecycle?.spawn ?? { paneId: "w1H:pF", handle: "spawned-agent" })
      return
    }
    if (url.pathname.startsWith("/api/herdr/agents/") && method === "DELETE") {
      const failure = options.lifecycle?.stopFailure
      if (failure !== undefined) {
        await route.fulfill({ body: JSON.stringify(failure.body), contentType: "application/json", status: failure.status })
        return
      }
      await fulfillJson(route, {})
      return
    }
    await fulfillJson(route, topologyForOptions(options))
  })
  await openApp(page, options)
}

async function chooseComboboxOption(page: Page, id: string, value: string): Promise<void> {
  const input = page.locator(`#${id}`)
  await input.click()
  const option = page.locator(`[data-combobox-option="${value}"]`)
  await expect(option).toBeVisible()
  await option.click()
}

async function openWorkspacesDirectory(page: Page, options: MockOptions = {}): Promise<void> {
  await openWithTopology(page, options)
  await page.goto("/workspaces")
  await expect(page.locator('[data-directory="workspaces"]')).toBeVisible()
}

interface OrbRowSnapshot {
  animating: string | null
  state: string | null
  status: string | null
  trigger: string | null
}

async function readOrbRows(page: Page): Promise<OrbRowSnapshot[]> {
  return page.locator("[data-pane-id]").evaluateAll((nodes) => nodes.map((node) => {
    const orb = node.querySelector<HTMLElement>("[data-orb-state]")
    return {
      animating: orb?.getAttribute("data-orb-animating") ?? null,
      state: orb?.getAttribute("data-orb-state") ?? null,
      status: node.getAttribute("data-pane-status"),
      trigger: node.getAttribute("data-orb-trigger"),
    }
  }))
}

function expectedOrbState(row: OrbRowSnapshot): "connecting" | "static" | "working" {
  if (row.trigger === "spawn-awaiting-pane" || row.trigger === "reconnecting-stream") return "connecting"
  return row.status === "working" ? "working" : "static"
}

interface CanvasSample {
  height: number
  nonBlankPixels: number
  pixels: number[]
  width: number
}

async function readCanvasSamples(canvases: Locator): Promise<CanvasSample[]> {
  return canvases.evaluateAll((nodes) => nodes.map((node) => {
    if (!(node instanceof HTMLCanvasElement)) throw new Error("orb guard selected a non-canvas element")
    const context = node.getContext("2d")
    if (context === null) throw new Error("orb canvas has no 2D context")
    const pixels = Array.from(context.getImageData(0, 0, node.width, node.height).data)
    let nonBlankPixels = 0
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] !== 0) nonBlankPixels += 1
    }
    return { height: node.height, nonBlankPixels, pixels, width: node.width }
  }))
}

interface RectSnapshot {
  bottom: number
  left: number
  right: number
  top: number
}

interface OrbGeometrySnapshot {
  canvas: RectSnapshot
  identity: RectSnapshot
  slot: RectSnapshot
}

async function expectContainedOrbSlots(rows: Locator, description: string): Promise<void> {
  const geometry = await rows.evaluateAll((nodes) => nodes.map((node): OrbGeometrySnapshot | null => {
    const slot = node.querySelector<HTMLElement>("[data-orb-slot]")
    const canvas = node.querySelector<HTMLCanvasElement>("canvas[data-agent-orb]")
    const identity = node.querySelector<HTMLElement>("[data-agent-identity]")
    if (slot === null || canvas === null || identity === null) return null
    const rect = (element: Element): RectSnapshot => {
      const box = element.getBoundingClientRect()
      return { bottom: box.bottom, left: box.left, right: box.right, top: box.top }
    }
    return { canvas: rect(canvas), identity: rect(identity), slot: rect(slot) }
  }))
  expect(geometry.length, `${description} must expose at least one row`).toBeGreaterThan(0)
  expect(geometry.every((entry) => entry !== null), `${description} must expose one slot, canvas, and identity per row`).toBe(true)
  for (const [index, entry] of geometry.entries()) {
    if (entry === null) throw new Error(`${description} row ${index} has incomplete orb geometry`)
    const epsilon = 0.5
    expect(entry.slot.right - entry.slot.left, `${description} row ${index} slot must have width`).toBeGreaterThan(0)
    expect(entry.slot.bottom - entry.slot.top, `${description} row ${index} slot must have height`).toBeGreaterThan(0)
    expect(entry.canvas.right - entry.canvas.left, `${description} row ${index} canvas must have width`).toBeGreaterThan(0)
    expect(entry.canvas.bottom - entry.canvas.top, `${description} row ${index} canvas must have height`).toBeGreaterThan(0)
    expect(entry.canvas.left, `${description} row ${index} canvas must stay inside its slot`).toBeGreaterThanOrEqual(entry.slot.left - epsilon)
    expect(entry.canvas.right, `${description} row ${index} canvas must stay inside its slot`).toBeLessThanOrEqual(entry.slot.right + epsilon)
    expect(entry.canvas.top, `${description} row ${index} canvas must stay inside its slot`).toBeGreaterThanOrEqual(entry.slot.top - epsilon)
    expect(entry.canvas.bottom, `${description} row ${index} canvas must stay inside its slot`).toBeLessThanOrEqual(entry.slot.bottom + epsilon)
    const horizontalOverlap = Math.min(entry.canvas.right, entry.identity.right) - Math.max(entry.canvas.left, entry.identity.left)
    const verticalOverlap = Math.min(entry.canvas.bottom, entry.identity.bottom) - Math.max(entry.canvas.top, entry.identity.top)
    expect(horizontalOverlap > 0 && verticalOverlap > 0, `${description} row ${index} canvas must not overlap its identity`).toBe(false)
  }
}

async function expectVisibleOrbMapping(page: Page): Promise<void> {
  await expect.poll(async () => {
    const rows = await readOrbRows(page)
    return rows.length > 0 && rows.every((row) => {
      const expected = expectedOrbState(row)
      return row.state === expected && row.animating === (expected === "static" ? "false" : "true")
    })
  }, { message: "every pane row must expose its mapped orb state and animation state" }).toBe(true)

  const rows = await readOrbRows(page)
  expect(rows.length, "the mapping sweep must inspect at least one pane row").toBeGreaterThan(0)
  expect(rows.map((row) => row.state), "orb state must equal the row mapping in both directions").toEqual(rows.map(expectedOrbState))
  expect(
    rows.every((row) => row.animating === (expectedOrbState(row) === "static" ? "false" : "true")),
    "mapped states animate and static states do not",
  ).toBe(true)
}

/** Opens the workspace menu for Personal-Projects and picks one item. */
async function openWorkspaceMenuItem(page: Page, item: string): Promise<void> {
  await page.locator('[data-quick-nav-item="workspaces"]').click()
  const workspace = page.locator('aside [data-workspace-id="w1H"]')
  await expect(workspace).toBeVisible()
  await workspace.getByRole("button", { name: "More actions for Personal-Projects" }).click()
  await page.locator(`[data-menu-item="${item}"]`).click()
}

/** Opens one pane row's menu. `identity` is what the row calls itself. */
async function openPaneMenu(page: Page, paneId: string, identity: string): Promise<void> {
  await page.locator('[data-quick-nav-item="agents"]').click()
  const pane = page.locator(`[data-pane-id="${paneId}"]`)
  await expect(pane).toBeVisible()
  await pane.getByRole("button", { name: `More actions for ${identity}` }).click()
  await expect(page.getByRole("menu")).toBeVisible()
}

test.describe("UX merge contract", () => {
  test("@guard image attachments render through click and keyboard actions", async ({ page }) => {
    await openApp(page, { imagePreview: true })
    const card = page.locator('[data-message-id="2"] [data-slot="attachment"]')
    const thumbnail = card.locator('[data-attachment-preview="thumbnail"]')
    await expect(thumbnail).toBeVisible()
    await expect(thumbnail).toHaveJSProperty("naturalWidth", 1)

    await clickAttachmentAction(card, "view")
    const viewer = card.locator('[data-attachment-viewer-kind="image"] [data-attachment-preview="viewer"]')
    await expect(viewer).toBeVisible()
    await expect(viewer).toHaveJSProperty("naturalWidth", 1)
    await clickAttachmentAction(card, "close-viewer")

    await page.locator('[data-message-id="2"]').focus()
    await page.keyboard.press("v")
    await expect(viewer).toBeVisible()
    await expect(viewer).toHaveJSProperty("naturalWidth", 1)
  })

  test("@guard attachment previews read current content and state deletion plainly", async ({ page }) => {
    await openApp(page, { liveStream: true })
    await page.locator('[data-channel-row="ops"] > a').click()
    await expect(page.getByRole("heading", { name: "ops", exact: true })).toBeVisible()
    await expect(page.locator('[data-message-id="4"]')).toBeVisible()
    const sentAttachment = mockAttachments.find((attachment) => attachment.id === 103)
    if (sentAttachment === undefined) throw new Error("fixtures lost the markdown attachment")
    const sentAttachments: string[][] = []

    await page.route("**/api/channels/ops/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback()
        return
      }
      const request = v.parse(sendMessageRequestSchema, JSON.parse(route.request().postData() ?? "{}"))
      sentAttachments.push(request.attachments ?? [])
      await fulfillJson(route, {
        attachments: [sentAttachment],
        body: request.body,
        channel: "ops",
        createdAt: "2026-08-19T08:00:00.000Z",
        id: 20,
        sender: "operator",
        senderAgentKind: null,
        senderKind: "human",
      })
    })

    await page.keyboard.press("Control+Shift+a")
    await page.locator("#attachment-path").fill(sentAttachment.path)
    await page.locator("#attachment-path").press("Enter")
    await expect(page.getByText(sentAttachment.path, { exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await page.locator("#message-composer").fill("Sent before the file changed")
    await page.locator("#message-composer").press("Enter")
    await expect.poll(() => sentAttachments.length, { message: "the guard must send the file before changing it" }).toBe(1)
    expect(sentAttachments[0], "the sent request must carry the attachment path").toEqual([sentAttachment.path])

    let fileState: "current" | "latest" | "deleted" = "current"
    await page.route("**/api/attachments/103/content", async (route) => {
      if (fileState === "deleted") {
        await route.fulfill({
          body: JSON.stringify({ code: "NotFound", error: "Attachment not found" }),
          contentType: "application/json",
          status: 404,
        })
        return
      }
      await route.fulfill({
        body: fileState === "current" ? CURRENT_MARKDOWN_BODY : LATEST_MARKDOWN_BODY,
        contentType: "text/markdown",
        status: 200,
      })
    })

    const card = page.locator('[data-message-id="20"] [data-slot="attachment"]')
    await clickAttachmentAction(card, "view")
    await expect(card.locator(".prose")).toContainText("This is the content after the file changed on disk.")
    await clickAttachmentAction(card, "close-viewer")

    fileState = "latest"
    await clickAttachmentAction(card, "view")
    await expect(card.locator(".prose")).toContainText("This is the latest content on disk.")
    await clickAttachmentAction(card, "close-viewer")

    fileState = "deleted"
    await clickAttachmentAction(card, "view")
    const unavailable = card.locator('p[role="alert"]')
    await expect(unavailable).toHaveText("This file is no longer available.")
    expect(await page.locator("body").innerText()).not.toMatch(/ask the sender|send it again|preview is pinned|changed after it was sent/i)
  })

  test("@guard global keys keep working while the markdown viewer is open", async ({ page }) => {
    await openApp(page)
    expect(await globalKeyWorks(page)).toBe(true)
    await openMarkdownViewer(page)
    expect(
      await globalKeyWorks(page),
      "an inline viewer must not modalize the app: a layer that handles no keys must block no keys",
    ).toBe(true)
  })

  test("@guard global keys keep working when the preview fails", async ({ page }) => {
    await openApp(page, { previewStatus: 404 })
    await clickViewAction(page)
    await expect(page.locator('[data-slot="attachment"] p[role="alert"]')).toBeVisible()
    expect(
      await globalKeyWorks(page),
      "handleView cannot return to idle from the error state, so a blocking layer here is a trap",
    ).toBe(true)
  })

  test("@guard escape closes the markdown viewer", async ({ page }) => {
    await openApp(page)
    await openMarkdownViewer(page)
    await blurActiveElement(page)
    await page.keyboard.press("Escape")
    await expect(page.locator(".prose")).toBeHidden()
  })

  test("@guard closing an overlay returns focus to its opener", async ({ page }) => {
    await openApp(page)
    await blurActiveElement(page)
    const opener = page.getByRole("button", { name: /channel members/i }).first()
    await opener.click()
    await expect(page.locator('[role="dialog"]')).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.locator('[role="dialog"]')).toBeHidden()
    const returned = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "")
    expect(returned).toMatch(/members/i)
  })

  test("@guard a duplicate binding blocks the save", async ({ page }) => {
    await openApp(page)
    await blurActiveElement(page)
    await page.keyboard.press("Control+,")
    await page.getByRole("button", { name: "Rebind Next channel" }).click()
    await page.getByRole("button", { name: "Rebind Next channel" }).press("[")
    await expect(page.getByRole("button", { name: "Save bindings" })).toBeDisabled()
  })

  test("@guard unread badges and orbs stay visible in both theme palettes", async ({ page }) => {
    // The invariant is separation, not a fixed colour: --sidebar-primary must not
    // collapse into --sidebar, which is what a neutral badge would do in dark.
    await page.emulateMedia({ colorScheme: "light" })
    await openWithTopology(page)
    await page.keyboard.press("Control+,")
    await page.getByRole("combobox", { name: "Theme mode" }).selectOption("system")
    await page.keyboard.press("Escape")
    const measurements: { body: string; sidebar: string; badge: string; badgeRendered: string | null }[] = []
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme })
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme)
      await page.locator('[data-quick-nav-item="channels"]').click()
      await expect(page.locator('aside [data-channel-row="ops"] span.rounded-full')).toBeVisible()
      const measurement = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement)
        const badge = document.querySelector('aside [data-channel-row="ops"] span.rounded-full')
        return {
          body: getComputedStyle(document.body).backgroundColor,
          sidebar: root.getPropertyValue("--sidebar").trim(),
          badge: root.getPropertyValue("--sidebar-primary").trim(),
          badgeRendered: badge === null ? null : getComputedStyle(badge).backgroundColor,
        }
      })
      await page.locator('[data-quick-nav-item="agents"]').click()
      await expect(page.locator('canvas[data-agent-orb]').first(), `${colorScheme} mode must render the status orb`).toBeVisible()
      measurements.push(measurement)
    }
    expect(measurements[0]?.body, "system light mode must use a different palette").not.toBe(measurements[1]?.body)
    for (const theme of measurements) {
      expect(theme.badge, "the unread badge must not collapse into the sidebar it sits on")
        .not.toBe(theme.sidebar)
      expect(theme.badgeRendered, "an unread badge must be rendering to check").not.toBeNull()
    }
  })

  test("@guard every visible themed surface changes palette or names its exception", async ({ page }) => {
    const allowlist = [
      { kind: "text", minimumContrast: 4.5, selector: ".text-emerald-700, .text-emerald-600", reason: "emerald ink communicates an active route state" },
      { kind: "text", minimumContrast: 4.5, selector: ".text-amber-700, .text-amber-600", reason: "amber ink communicates a stale or blocked state" },
    ]
    await page.emulateMedia({ colorScheme: "light" })
    await openWithTopology(page, { identityHandle: "suleyman", liveStream: true, previewStatus: 500 })
    const streamRadio = page.locator("svg.text-emerald-600")
    await expect(streamRadio, "the theme fixture must keep the live stream indicator rendered").toHaveCount(1)
    const lightStreamRadioColor = await streamRadio.evaluate((node) => getComputedStyle(node).color)
    const paletteBackground = async (): Promise<string> => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    const waitForThemePaint = async (): Promise<void> => {
      await expect.poll(
        () => page.evaluate(() => document.getAnimations().every((animation) => {
          const timing = animation.effect?.getComputedTiming()
          return timing === null
            || timing.iterations === Infinity
            || timing.progress === null
            || animation.playState === "finished"
            || animation.playState === "idle"
        })),
        { message: "theme transitions must settle before the palette sweep" },
      ).toBe(true)
    }
    const initialPaletteBackground = await paletteBackground()
    await page.keyboard.press("Control+,")
    await page.getByRole("combobox", { name: "Theme mode" }).selectOption("system")
    await page.keyboard.press("Escape")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await expect.poll(paletteBackground, { message: "light theme must apply its palette before the sweep" }).not.toBe(initialPaletteBackground)
    await waitForThemePaint()
    const readSurfaces = async (): Promise<Array<{ background: string; border: string; color: string; key: string; kind: string | undefined; reason: string | undefined; selector: string | undefined; contrast: number | undefined }>> =>
      page.evaluate((entries) => {
        type Rgb = [number, number, number]
        const colorOf = (value: string): Rgb | null => {
          const rgbMatch = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/)
          if (rgbMatch !== null) return [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])]
          const linearToSrgb = (channel: number): number => {
            const encoded = channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055
            return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
          }
          const oklchMatch = value.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?(?:\s*\/\s*[\d.]+)?\s*\)$/)
          const oklabMatch = value.match(/^oklab\(\s*([\d.]+%?)\s+(-?[\d.]+)\s+(-?[\d.]+)(?:\s*\/\s*[\d.]+)?\s*\)$/)
          if (oklchMatch === null && oklabMatch === null) return null
          const lightness = (oklchMatch ?? oklabMatch)?.[1]?.endsWith("%") === true
            ? Number.parseFloat((oklchMatch ?? oklabMatch)?.[1] ?? "0") / 100
            : Number((oklchMatch ?? oklabMatch)?.[1] ?? "0")
          const a = oklabMatch === null
            ? Number(oklchMatch?.[2] ?? "0") * Math.cos(Number(oklchMatch?.[3] ?? "0") * Math.PI / 180)
            : Number(oklabMatch[2])
          const b = oklabMatch === null
            ? Number(oklchMatch?.[2] ?? "0") * Math.sin(Number(oklchMatch?.[3] ?? "0") * Math.PI / 180)
            : Number(oklabMatch[3])
          const light = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3
          const middle = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3
          const dark = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3
          return [
            linearToSrgb(4.0767416621 * light - 3.3077115913 * middle + 0.2309699292 * dark),
            linearToSrgb(-1.2684380046 * light + 2.6097574011 * middle - 0.3413193965 * dark),
            linearToSrgb(-0.0041960863 * light - 0.7034186147 * middle + 1.707614701 * dark),
          ]
        }
        const luminanceOf = ([red, green, blue]: Rgb): number => {
          const channel = (value: number): number => {
            const normalized = value / 255
            return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
        }
        const contrastOf = (foreground: Rgb, background: Rgb): number => {
          const lighter = Math.max(luminanceOf(foreground), luminanceOf(background))
          const darker = Math.min(luminanceOf(foreground), luminanceOf(background))
          return (lighter + 0.05) / (darker + 0.05)
        }
        const transparent = (value: string): boolean => value === "transparent" || value === "rgba(0, 0, 0, 0)"
        const backgroundOf = (node: Element): Rgb | null => {
          let current: Element | null = node
          while (current !== null) {
            const value = getComputedStyle(current).backgroundColor
            const background = colorOf(value)
            if (background !== null && !transparent(value)) return background
            current = current.parentElement
          }
          return colorOf(getComputedStyle(document.body).backgroundColor)
        }
        const canvasContrastOf = (node: HTMLCanvasElement, background: Rgb): number | undefined => {
          const context = node.getContext("2d")
          if (context === null || node.width === 0 || node.height === 0) return undefined
          const pixels = context.getImageData(0, 0, node.width, node.height).data
          let strongest: number | undefined
          for (let index = 0; index < pixels.length; index += 4) {
            const alpha = (pixels[index + 3] ?? 0) / 255
            if (alpha < 0.2) continue
            const ink: Rgb = [pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0]
            const composite: Rgb = [
              Math.round(ink[0] * alpha + background[0] * (1 - alpha)),
              Math.round(ink[1] * alpha + background[1] * (1 - alpha)),
              Math.round(ink[2] * alpha + background[2] * (1 - alpha)),
            ]
            const ratio = contrastOf(composite, background)
            strongest = strongest === undefined ? ratio : Math.max(strongest, ratio)
          }
          return strongest
        }
        const identityOf = (node: Element): string => [
          node.id,
          node.getAttribute("data-shell-page"),
          node.getAttribute("data-dialog"),
          node.getAttribute("data-menu"),
          node.getAttribute("data-message-id"),
          node.getAttribute("data-pane-id"),
          node.getAttribute("data-slot"),
          node.getAttribute("data-surface-kind"),
          node.getAttribute("aria-label"),
          node.getAttribute("role"),
          node.getAttribute("class"),
        ].find((value) => value !== null && value.length > 0) ?? node.tagName.toLowerCase()
        const pathOf = (node: Element): string => {
          const path: string[] = []
          let current: Element | null = node
          while (current !== null) {
            const identity = identityOf(current)
            let index = 0
            let sibling = current.previousElementSibling
            while (sibling !== null) {
              if (identityOf(sibling) === identity) index += 1
              sibling = sibling.previousElementSibling
            }
            path.push(`${current.tagName.toLowerCase()}:${index}`)
            current = current.parentElement
          }
          return path.reverse().join("/")
        }
        const surfaces: Array<{ background: string; border: string; color: string; key: string; kind: string | undefined; reason: string | undefined; selector: string | undefined; contrast: number | undefined }> = []
        for (const node of document.querySelectorAll<HTMLElement>("body, body *")) {
          if (node.matches("input[data-combobox-input]")) continue
          if (node.getAttribute("aria-hidden") === "true") continue
          const box = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          if (box.width === 0 || box.height === 0 || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue
          const parentColor = node.parentElement === null ? undefined : getComputedStyle(node.parentElement).color
          const hasBackground = !transparent(style.backgroundColor)
          const hasBorder = style.borderTopStyle !== "none" && Number.parseFloat(style.borderTopWidth) > 0 && !transparent(style.borderTopColor)
          const hasOwnColor = parentColor !== undefined && style.color !== parentColor
          const exception = entries.find((entry) => node.matches(entry.selector))
          if (!hasBackground && !hasBorder && !hasOwnColor && exception === undefined) continue
          const background = backgroundOf(node)
          const foreground = colorOf(style.color)
          const surfaceKind = node.getAttribute("data-surface-kind") ?? undefined
          const contrastEligible = surfaceKind !== undefined
            || (exception !== undefined && (exception.kind === "graphic" || (node.getAttribute("aria-hidden") !== "true" && node.textContent?.trim() !== "")))
          const contrast = !contrastEligible || background === null
            ? undefined
            : node instanceof HTMLCanvasElement
              ? canvasContrastOf(node, background)
              : foreground === null
                ? undefined
                : contrastOf(foreground, background)
          const identity = identityOf(node)
          surfaces.push({
            background: style.backgroundColor,
            border: hasBorder ? style.borderTopColor : "",
            color: hasOwnColor ? style.color : "",
            key: `${pathOf(node)}:${identity}`,
            kind: surfaceKind,
            reason: exception?.reason,
            selector: contrastEligible ? exception?.selector : undefined,
            contrast,
          })
        }
        return surfaces
      }, allowlist)

    const captureSurfaceFixtures = async (): Promise<Array<{ background: string; border: string; color: string; key: string; kind: string | undefined; reason: string | undefined; selector: string | undefined; contrast: number | undefined }>> => {
      await page.locator('[data-menu-trigger="channel"]').first().click()
      await expect(page.locator('[data-menu="channel"]')).toBeVisible()
      const menu = await readSurfaces()
      await page.keyboard.press("Escape")
      await expect(page.locator('[data-menu="channel"]')).toHaveCount(0)
      await page.getByRole("button", { name: /channel members/ }).click()
      await expect(page.locator('[data-dialog="members"]')).toBeVisible()
      await expect(
        page.locator('[data-dialog="members"] [data-agent-runtime="no-herdr-pane"]').first(),
        "the members fixture must render an agent without a Herdr pane before the palette sweep",
      ).toBeVisible()
      const dialog = await readSurfaces()
      await page.keyboard.press("Escape")
      await expect(page.locator('[data-dialog="members"]')).toHaveCount(0)
      return [...menu, ...dialog]
    }

    await expect(page.locator('[data-surface-kind="error-text"]')).toBeVisible()
    await page.locator('[data-menu-trigger="channel"]').first().click()
    await page.locator('[data-menu-item="copy-name"]').click()
    await expect(page.locator('[data-surface-kind="notice"]')).toBeVisible()

    const lightPaletteBackground = await paletteBackground()
    const light = await captureSurfaceFixtures()
    for (const kind of REQUIRED_SURFACE_KINDS) {
      const surfaces = light.filter((surface) => surface.kind === kind)
      expect(surfaces, `the palette fixture must render a ${kind} surface`).not.toHaveLength(0)
      for (const surface of surfaces) {
        expect(surface.contrast, `the light ${kind} text must expose measurable contrast`).toBeDefined()
        expect(surface.contrast, `the light ${kind} text must meet 4.5:1 contrast`).toBeGreaterThanOrEqual(4.5)
      }
    }
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await expect.poll(paletteBackground, { message: "dark theme must replace the light palette before the sweep" }).not.toBe(lightPaletteBackground)
    await waitForThemePaint()
    await expect(streamRadio, "the live stream indicator must remain rendered in dark mode").toHaveCount(1)
    const darkStreamRadioColor = await streamRadio.evaluate((node) => getComputedStyle(node).color)
    expect(darkStreamRadioColor, "the live stream indicator must change ink in dark mode").not.toBe(lightStreamRadioColor)
    const dark = await captureSurfaceFixtures()
    for (const kind of REQUIRED_SURFACE_KINDS) {
      const surfaces = dark.filter((surface) => surface.kind === kind)
      expect(surfaces, `the palette fixture must render the ${kind} surface in dark mode`).not.toHaveLength(0)
      for (const surface of surfaces) {
        expect(surface.contrast, `the dark ${kind} text must expose measurable contrast`).toBeDefined()
        expect(surface.contrast, `the dark ${kind} text must meet 4.5:1 contrast`).toBeGreaterThanOrEqual(4.5)
      }
    }
    const darkByKey = new Map(dark.map((surface) => [surface.key, surface]))
    const comparable = light.flatMap((surface) => {
      const counterpart = darkByKey.get(surface.key)
      return counterpart === undefined ? [] : [{ light: surface, dark: counterpart }]
    })
    const unchanged = comparable.flatMap(({ light: surface, dark: counterpart }) => {
      if (surface.reason !== undefined) return []
      return surface.background === counterpart.background && surface.border === counterpart.border && surface.color === counterpart.color
        ? [`${surface.key} (${surface.background || surface.color || surface.border})`]
        : []
    })
    expect(light.length, "the palette sweep must capture visible themed surfaces").toBeGreaterThan(10)
    expect(comparable.length, "the palette sweep must compare a stable intersection of themed surfaces").toBeGreaterThan(10)
    expect(unchanged, "every captured surface must change or have a documented exception").toEqual([])
    for (const entry of allowlist) {
      const matches = comparable.filter(({ light: lightSurface, dark: darkSurface }) => lightSurface.selector === entry.selector && darkSurface.selector === entry.selector)
      expect(matches.length, `${entry.selector} must have a comparable light and dark surface`).toBeGreaterThan(0)
      for (const { light: lightSurface, dark: darkSurface } of matches) {
        expect(lightSurface.contrast, `${entry.selector} must expose measurable light-theme contrast`).toBeDefined()
        expect(lightSurface.contrast, `${entry.selector} must meet ${entry.minimumContrast}:1 contrast in light theme`).toBeGreaterThanOrEqual(entry.minimumContrast)
        expect(darkSurface.contrast, `${entry.selector} must expose measurable dark-theme contrast`).toBeDefined()
        expect(darkSurface.contrast, `${entry.selector} must meet ${entry.minimumContrast}:1 contrast in dark theme`).toBeGreaterThanOrEqual(entry.minimumContrast)
      }
    }
  })

  test("@guard theme modes persist, follow system changes, and stay reachable", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" })
    await openApp(page)
    await page.keyboard.press("Control+,")
    const switcher = page.getByRole("combobox", { name: "Theme mode" })
    await expect(switcher).toHaveValue("dark")
    await switcher.selectOption("light")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    const lightBody = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await switcher.selectOption("system")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await page.emulateMedia({ colorScheme: "dark" })
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    const darkBody = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(darkBody, "system mode must follow the operating-system preference").not.toBe(lightBody)
    await page.keyboard.press("Escape")
    await page.keyboard.press("Control+Shift+T")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
    await page.keyboard.press("?")
    await expect(page.getByText("Cycle theme mode", { exact: true })).toBeVisible()
    await page.keyboard.press("Escape")
    await page.keyboard.press("Control+,")
    await switcher.selectOption("light")
    await page.keyboard.press("Escape")
    await page.reload()
    await expect(page.locator('nav[aria-label="Channels"] button').first()).toBeVisible()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await page.keyboard.press("Control+,")
    await expect(page.getByRole("combobox", { name: "Theme mode" })).toHaveValue("light")
  })

  test("@guard a persisted non-default theme is applied before app scripts", async ({ page }) => {
    await page.addInitScript(() => {
      window.__themeWrites = []
      const setAttribute = Element.prototype.setAttribute
      Element.prototype.setAttribute = function(name, value) {
        if (this === document.documentElement && name === "data-theme") window.__themeWrites?.push(value)
        return setAttribute.call(this, name, value)
      }
      window.localStorage.setItem("msgr.theme.v1", JSON.stringify({ version: 1, mode: "light" }))
    })
    await page.emulateMedia({ colorScheme: "dark" })
    await openApp(page)
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    const writes = await page.evaluate(() => window.__themeWrites ?? [])
    expect(writes[0], "the persisted non-default theme must be written before hydration").toBe("light")
  })

  test("@finding 24 a control that states a missing precondition is disabled", async ({ page }) => {
    // Decision 18: disable, with a stated reason, when the operator can obtain what the
    // control needs. A control carrying "not connected" in its title has
    // already decided the precondition is missing, so leaving it enabled is the
    // present-and-inert state that let three regressions ship behind red-by-construction
    // cases. This asserts the pairing directly rather than through a click, so it cannot
    // pass because some other dialog happened to open.
    await openWithTopology(page, { anonymous: true })
    const offenders = await page.evaluate(() =>
      [...document.querySelectorAll("aside button, main button")]
        .filter((node) => /not connected/i.test(node.getAttribute("title") ?? ""))
        .filter((node) => !(node instanceof HTMLButtonElement && node.disabled))
        .filter((node) => node.getAttribute("aria-disabled") !== "true")
        .map((node) => node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 40) ?? ""),
    )
    expect(
      offenders,
      "a control whose own title says the precondition is missing must not stay clickable",
    ).toEqual([])
  })

  test("@guard lifecycle menus and close controls are not inert", async ({ page }) => {
    await openWithTopology(page)
    await page.locator('[data-quick-nav-item="workspaces"]').click()
    const workspace = page.locator('aside [data-workspace-id="w1H"]')
    await expect(workspace).toBeVisible()
    await workspace.getByRole("button", { name: "More actions for Personal-Projects" }).click()
    await page.locator('[data-menu-item="close-workspace"]').click()
    await expect(page.getByRole("dialog")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("dialog")).toHaveCount(0)

    await page.locator('[data-quick-nav-item="agents"]').click()
    const pane = page.locator('[data-pane-id="w1H:p1"]')
    await expect(pane).toBeVisible()
    await pane.getByRole("button", { name: "More actions for lead" }).click()
    await expect(page.getByRole("menu")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).toHaveCount(0)

    await pane.getByRole("button", { name: "More actions for lead" }).click()
    await expect(page.getByRole("menu")).toBeVisible()
    await page.locator("main").click({ position: { x: 20, y: 20 } })
    await expect(page.getByRole("menu")).toHaveCount(0)
  })

  test("@guard anonymous workspace write controls expose their disabled precondition", async ({ page }) => {
    await openWithTopology(page, { anonymous: true })
    await page.goto("/workspaces")
    await expect(page.getByRole("button", { name: "Create workspace" })).toBeDisabled()
    await expect(page.getByRole("button", { name: "Create workspace" })).toHaveAttribute("title", "Not connected to the hub.")
    await page.locator('[data-quick-nav-item="workspaces"]').click()
    const workspace = page.locator('aside [data-workspace-id="w1H"]')
    await workspace.getByRole("button", { name: "More actions for Personal-Projects" }).click()
    await expect(page.locator('[data-menu-item="broadcast"]')).toBeDisabled()
    await expect(page.locator('[data-menu-item="close-workspace"]')).toBeDisabled()
    await expect(page.locator('[data-menu-item="broadcast"]')).toHaveAttribute("title", "Not connected to the hub.")
    await expect(page.locator('[data-menu-item="close-workspace"]')).toHaveAttribute("title", "Not connected to the hub.")
  })

  test("@guard no chrome asks the operator to choose or establish an identity", async ({ page }) => {
    // Identification is automatic, so the ONLY unidentified state is a failed claim.
    // Staging it is what makes the sweep mean anything: identified chrome renders
    // none of this copy, so a run without `anonymous` passes on nothing.
    await openWithTopology(page, { anonymous: true })

    const offenders = await page.evaluate(() => {
      const forbidden = /choose (a |an )?(human )?identity|send a message first|tied to your identity|introduce yourself|choose a name|pick a name/i
      const found: Array<{ sample: string; where: string }> = []
      const roots = document.querySelectorAll<HTMLElement>('aside, main, [role="status"], [role="alert"], [data-dialog]')
      const inspect = (node: HTMLElement): void => {
        // Chrome only: an agent may legitimately WRITE these words into a message,
        // and authored content is not the app speaking. The exclusion is for TEXT,
        // never for styling.
        if (node.closest("[data-agent-message-row]") !== null) return
        const title = node.getAttribute("title")
        if (title !== null && forbidden.test(title)) found.push({ sample: title, where: "title" })
        for (const child of node.childNodes) {
          if (child.nodeType !== Node.TEXT_NODE) continue
          const value = child.textContent ?? ""
          if (forbidden.test(value)) found.push({ sample: value.trim().slice(0, 60), where: "text" })
        }
      }
      for (const root of roots) {
        // The root ITSELF carries text — a notice is a <p> with a text child and no
        // element children, so scanning only descendants misses it entirely.
        inspect(root)
        for (const child of root.querySelectorAll<HTMLElement>("*")) inspect(child)
      }
      return found
    })

    const scanned = await page.locator("aside *, main *").count()
    expect(scanned, "the identity sweep must have chrome to scan").toBeGreaterThan(20)
    expect(offenders, "identification is automatic: no chrome may ask for an identity").toEqual([])
  })

  test("@guard an expired session makes one recovery attempt and settles to read-only", async ({ page }) => {
    const requests: string[] = []
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname === "/api/inbox" || pathname === "/api/direct" || pathname.endsWith("/members") || pathname.endsWith("/messages")) {
        requests.push(pathname)
      }
    })
    await openApp(page, { expiredSession: true, waitForMessages: false })
    await expect(page.getByText("Read only", { exact: true })).toBeVisible()
    await expect.poll(() => requests.filter((path) => path === "/api/inbox").length).toBe(2)
    await expect.poll(() => requests.filter((path) => path === "/api/direct").length).toBe(2)
    const initialCount = requests.length
    await page.waitForTimeout(500)
    expect(requests.length, "a second 401 must not trigger another identity-scoped sweep").toBe(initialCount)
    expect(requests.filter((path) => path === "/api/inbox")).toHaveLength(2)
    expect(requests.filter((path) => path === "/api/direct")).toHaveLength(2)
  })

  test("@guard identity removal failures reach the storage notice", async ({ page }) => {
    await page.addInitScript(() => {
      const removeItem = Storage.prototype.removeItem
      Storage.prototype.removeItem = function (key: string): void {
        if (key === "msgr.identity.v1") throw new DOMException("blocked", "QuotaExceededError")
        removeItem.call(this, key)
      }
    })
    await openApp(page, { expiredSession: true, waitForMessages: false })
    const notice = page.locator('[data-surface-kind="notice"]')
    await expect(notice).toContainText("The stored identity could not be removed")
    await expect(notice).toHaveAttribute("data-notice-placement", "below-header")
    await notice.getByRole("button", { name: "Dismiss notice" }).click()
    await expect(notice).toHaveCount(0)
  })

  test("@guard the focused-message warning stays outside the composer and is dismissible", async ({ page }) => {
    await openApp(page, { identityHandle: "suleyman" })
    const composer = page.locator("#message-composer")
    await expect(page.locator("[data-focus-hint]")).toHaveCount(0)
    const selectedChannel = await page.locator('aside [data-channel-row] [aria-current="page"]').evaluate((current) => {
      const row = current.closest<HTMLElement>("[data-channel-row]")
      const channel = row?.dataset.channelRow
      if (channel === undefined) throw new Error("could not read the selected channel")
      return channel
    })
    await expect(composer).toHaveAttribute("placeholder", `Message #${selectedChannel}`)

    const selfMessage = page.locator('[data-message-id="2"]')
    await selfMessage.focus()
    await expect(selfMessage).toHaveAttribute("tabindex", "0")
    await page.keyboard.press("d")
    const notice = page.locator('[data-surface-kind="notice"]')
    await expect(notice).toContainText("Focus a message from another participant first.")
    await expect(notice).toHaveAttribute("data-notice-placement", "below-header")
    await expect(page.locator("[data-focus-hint]")).toHaveCount(0)
    await notice.getByRole("button", { name: "Dismiss notice" }).click()
    await expect(notice).toHaveCount(0)

    await page.locator('aside [data-channel-row="research"] > a').click()
    await expect(composer).toHaveAttribute("placeholder", "Message #research")
  })

  test("@guard a non-member channel explains the join action in the context bar", async ({ page }) => {
    const acknowledgementRequests: string[] = []
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.endsWith("/ack")) acknowledgementRequests.push(pathname)
    })
    await openApp(page, { identityHandle: "suleyman", nonMemberChannel: "handoff" })
    const membership = page.locator('[data-membership="non-member"]')
    await expect(membership).toBeVisible()
    await expect(membership).toContainText("You have not joined this channel. Join it to track unread and post.")
    const joinRequests: string[] = []
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (request.method() === "POST" && pathname === "/api/channels/handoff/join") joinRequests.push(pathname)
    })
    await expect(membership.getByRole("button", { name: "Join channel" })).toBeVisible()
    await page.waitForTimeout(300)
    expect(acknowledgementRequests, "a non-member channel must not acknowledge visible messages").toEqual([])
    await membership.getByRole("button", { name: "Join channel" }).click()
    await expect.poll(() => joinRequests.length).toBe(1)
    await expect(page.locator('[data-membership="non-member"]')).toHaveCount(0)
  })

  test("@guard an arriving message does not re-sweep the member rosters", async ({ page }) => {
    // The member effect used to depend on object identities that an arriving message
    // rebuilt, so every arrival re-fetched every roster. A sweep requests one roster
    // per channel, so a second sweep repeats a path it has already requested. This
    // asserts that no path repeats. It cannot pass by the messages failing to arrive,
    // because the probe bodies must be on screen before the count is judged.
    const rosterRequests: string[] = []
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname.endsWith("/members")) rosterRequests.push(pathname)
    })
    await openApp(page, { liveStream: true })
    const settled = rosterRequests.length
    expect(settled, "the first load must sweep the rosters once").toBeGreaterThan(0)

    const seed = mockMessages[0]
    if (seed === undefined) throw new Error("fixtures lost the seed message")
    // The arrival has to land in the channel on screen, or it is buffered for a
    // channel nobody is looking at and the visibility check below cannot pass.
    const selected = await page.evaluate(() => {
      const current = document.querySelector('nav[aria-label="Channels"] [aria-current]')
      return current?.closest("[data-channel-row]")?.getAttribute("data-channel-row")
        ?? current?.querySelector("[data-channel-row]")?.getAttribute("data-channel-row")
        ?? current?.getAttribute("data-channel-row")
        ?? null
    })
    if (selected === null) throw new Error("could not read the selected channel")
    for (let index = 0; index < 3; index += 1) {
      const delivered = await pushLiveMessage(page, {
        ...seed,
        attachments: [],
        body: `live probe ${String(index)}`,
        channel: selected,
        id: 90_000 + index,
      })
      expect(delivered, "the live stream must be open").toBe(true)
    }

    // Non-vacuity: the arrivals must be on screen before the count is judged.
    await expect(page.getByText("live probe 2")).toBeVisible()
    expect(
      rosterRequests.length,
      "an arriving message must not re-fetch any roster",
    ).toBe(settled)
  })

  test("@guard launcher metadata loads when the spawn flow opens", async ({ page }) => {
    const requests: string[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.pathname === "/api/herdr/launchers" && request.method() === "GET") requests.push(url.pathname)
    })
    await openWithTopology(page)
    expect(requests, "launcher metadata must not block the initial app render").toHaveLength(0)
    await openWorkspaceMenuItem(page, "spawn-agent")
    await expect.poll(() => requests.length).toBe(1)
    await chooseComboboxOption(page, "spawn-agent-role", "__no_role__")
    await chooseComboboxOption(page, "spawn-agent-harness", "claude")
    const launcher = page.locator("#spawn-agent-launcher")
    await launcher.click()
    await expect(page.locator('[data-combobox-option="claude-personal"]')).toBeVisible()
    await page.locator('[data-combobox-option="claude-personal"]').click()
    await expect(page.locator('[data-combobox="spawn-agent-launcher"] [data-combobox-value]')).toContainText("claude-personal")
  })

  test("@guard the spawn request names a launcher, never a harness", async ({ page }) => {
    const bodies: string[] = []
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/herdr/agents" && request.method() === "POST") {
        bodies.push(request.postData() ?? "")
      }
    })
    await openWithTopology(page, { liveStream: true })
    await openWorkspaceMenuItem(page, "spawn-agent")
    await expect(page.locator('[data-dialog="spawn-agent"]')).toBeVisible()
    await page.locator("#spawn-agent-handle").fill("builder")
    await page.getByRole("button", { name: "Spawn agent", exact: true }).click()

    await expect.poll(() => bodies.length).toBe(1)
    const body = parseJsonObject(bodies[0] ?? "{}")
    expect(body).toEqual({ effort: "medium", handle: "builder", launcher: "codex", model: "gpt-5.6-sol", role: "worker", workspaceId: "w1H" })
    for (const forbiddenKey of ["harness", "argv", "argvSuffix", "executable", "command", "token"] as const) {
      expect(body).not.toHaveProperty(forbiddenKey)
    }
    expect(bodies[0]).not.toContain("/usr/")
    expect(bodies[0]).not.toContain("/bin/")
    expect(bodies[0]).not.toContain("--profile")
  })

  test("@guard launcher management keeps command bytes at definition time", async ({ page }) => {
    const definitionBodies: JsonObject[] = []
    const updateBodies: JsonObject[] = []
    const spawnBodies: JsonObject[] = []
    const listToken = "tok-launcher-list-must-never-appear"
    const createToken = "tok-launcher-create-must-never-appear"
    const spawnToken = "tok-launcher-spawn-must-never-appear"
    const launchers = mockLaunchers.map((launcher) => ({ ...launcher, argv: [...launcher.argv] }))

    await openWithTopology(page)
    await page.route("**/api/herdr/**", async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const method = request.method()
      if (url.pathname === "/api/herdr/launchers" && method === "GET") {
        await fulfillJson(route, { launchers, token: listToken })
        return
      }
      if (url.pathname === "/api/herdr/launchers" && method === "POST") {
        const body = v.parse(createLauncherRequestSchema, JSON.parse(request.postData() ?? "{}"))
        definitionBodies.push(parseJsonObject(request.postData() ?? "{}"))
        const { agentKind, argv, name, startTimeoutMs } = body
        const created = { agentKind, argv, envKeys: [], name, startTimeoutMs: startTimeoutMs ?? 35_000 }
        launchers.push(created)
        await fulfillJson(route, { ...created, token: createToken })
        return
      }
      if (url.pathname.startsWith("/api/herdr/launchers/") && method === "PUT") {
        const body = v.parse(updateLauncherRequestSchema, JSON.parse(request.postData() ?? "{}"))
        updateBodies.push(parseJsonObject(request.postData() ?? "{}"))
        const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
        const launcher = launchers.find((candidate) => candidate.name === name)
        if (launcher === undefined) {
          await route.fulfill({ body: JSON.stringify({ code: "NotFound", error: "launcher not found" }), contentType: "application/json", status: 404 })
          return
        }
        launcher.agentKind = body.agentKind
        launcher.argv = body.argv
        if (body.startTimeoutMs !== undefined) launcher.startTimeoutMs = body.startTimeoutMs
        if (launcher.argv[0] !== launcher.agentKind) {
          await route.fulfill({ body: JSON.stringify({ code: "ValidationFailed", error: "argv[0] must equal agentKind" }), contentType: "application/json", status: 400 })
          return
        }
        await fulfillJson(route, { ...launcher, token: "tok-launcher-update-must-never-appear" })
        return
      }
      if (url.pathname.startsWith("/api/herdr/launchers/") && method === "DELETE") {
        const name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
        const index = launchers.findIndex((launcher) => launcher.name === name)
        if (index < 0) {
          await route.fulfill({ body: JSON.stringify({ code: "NotFound", error: "launcher not found" }), contentType: "application/json", status: 404 })
          return
        }
        launchers.splice(index, 1)
        await fulfillJson(route, { name })
        return
      }
      if (url.pathname === "/api/herdr/agents" && method === "POST") {
        spawnBodies.push(parseJsonObject(request.postData() ?? "{}"))
        await fulfillJson(route, { handle: "spawned-launcher", paneId: "w1H:pF", token: spawnToken })
        return
      }
      await route.fallback()
    })

    await page.goto("/launchers")
    await expect(page.locator('[data-shell-page="launchers"]')).toBeVisible()
    const seededRow = page.locator('[data-launcher-row="claude-personal"]')
    await expect(seededRow).toBeVisible()
    await expect(seededRow.locator("[data-launcher-executable] code")).toHaveText("claude")
    await expect(seededRow.locator("[data-launcher-argv-summary] code")).toHaveText(JSON.stringify(["--profile", "personal"]))

    const assertNoToken = async (token: string): Promise<void> => {
      const leaked = await page.evaluate((candidate) => {
        const inAttributes = Array.from(document.querySelectorAll("*"))
          .some((node) => Array.from(node.attributes).some((attribute) => attribute.value.includes(candidate)))
        return document.body.innerText.includes(candidate)
          || inAttributes
          || Object.values(localStorage).some((value) => value.includes(candidate))
      }, token)
      expect(leaked, `token ${token} must not reach the page`).toBe(false)
    }
    await assertNoToken(listToken)

    await page.getByRole("button", { name: "Create launcher", exact: true }).click()
    await expect(page.locator('[data-shell-page="create-launcher"]')).toBeVisible()
    await expect(page.locator("[data-dialog]")).toHaveCount(0)
    await page.locator("#launcher-name").fill("claude-custom")
    await chooseComboboxOption(page, "launcher-agent-kind", "claude")
    await page.locator("#launcher-executable").fill("claude")
    await page.getByRole("button", { name: "Add argument" }).click()
    await page.locator("#launcher-argv").fill("--profile")
    await page.getByRole("button", { name: "Add argument" }).click()
    await page.locator("#launcher-argv-1").fill("custom")
    await page.getByRole("button", { name: "Create alias", exact: true }).click()
    await expect.poll(() => definitionBodies.length).toBe(1)
    expect(Object.keys(definitionBodies[0] ?? {}).sort()).toEqual(["agentKind", "argv", "name", "startTimeoutMs"])
    expect(definitionBodies[0]?.argv).toEqual(["claude", "--profile", "custom"])
    expect(definitionBodies[0]?.startTimeoutMs).toBe(35_000)
    await expect(page.locator('[data-launcher-row="claude-custom"]')).toBeVisible()
    await assertNoToken(createToken)

    await page.getByRole("button", { name: "Edit launcher alias claude-custom", exact: true }).click()
    await expect(page.locator('[data-shell-page="edit-launcher"]')).toBeVisible()
    const nameField = page.locator("#launcher-name")
    await expect(nameField).toHaveValue("claude-custom")
    await expect(nameField).toHaveAttribute("readonly", "")
    await chooseComboboxOption(page, "launcher-agent-kind", "codex")
    await page.locator("#launcher-executable").fill("codex")
    await page.locator("#launcher-argv").fill("--profile")
    await page.locator("#launcher-argv-1").fill("custom")
    await page.getByRole("button", { name: "Save alias", exact: true }).click()
    await expect.poll(() => updateBodies.length).toBe(1)
    expect(Object.keys(updateBodies[0] ?? {}).sort()).toEqual(["agentKind", "argv", "startTimeoutMs"])
    await assertNoToken("tok-launcher-update-must-never-appear")

    await page.goto("/launchers")
    const deletedRow = page.locator('[data-launcher-row="pi"]')
    await expect(deletedRow).toBeVisible()
    await deletedRow.getByRole("button", { name: "Delete launcher alias pi", exact: true }).click()
    await expect(page.locator('[data-dialog="delete-launcher"]')).toBeVisible()
    await expect(page.locator("[data-confirm-input]")).toHaveAttribute("data-confirm-input", "pi")
    await page.locator("[data-confirm-input]").fill("pi")
    await page.getByRole("button", { name: "Delete alias", exact: true }).click()
    await expect(page.locator('[data-launcher-row="pi"]')).toHaveCount(0)
    await page.reload()
    await expect(page.locator('[data-shell-page="launchers"]')).toBeVisible()
    await expect(page.locator('[data-launcher-row="pi"]')).toHaveCount(0)

    await page.goto("/")
    await openWorkspaceMenuItem(page, "spawn-agent")
    await expect(page.locator('[data-dialog="spawn-agent"]')).toBeVisible()
    await chooseComboboxOption(page, "spawn-agent-role", "__no_role__")
    await chooseComboboxOption(page, "spawn-agent-harness", "claude")
    await expect(page.locator('[data-combobox-option="pi"]')).toHaveCount(0)
    await chooseComboboxOption(page, "spawn-agent-launcher", "claude-personal")
    await expect(page.locator('[data-spawn-review]')).toContainText("claude-personal")
    await page.locator("#spawn-agent-handle").fill("builder")
    await page.getByRole("button", { name: "Spawn agent", exact: true }).click()
    await expect.poll(() => spawnBodies.length).toBe(1)
    const spawnKeys = Object.keys(spawnBodies[0] ?? {}).sort()
    expect(spawnKeys).toEqual(["handle", "launcher", "model", "workspaceId"])
    expect(spawnBodies[0]?.launcher).toBe("claude-personal")
    await expect(page.locator('[data-assigned-handle="spawned-launcher"]')).toBeVisible()
    await assertNoToken(spawnToken)
  })

  test("@guard the spawn dialog closes on the topology event, not the response", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    await openWorkspaceMenuItem(page, "spawn-agent")
    await page.locator("#spawn-agent-handle").fill("builder")
    await page.getByRole("button", { name: "Spawn agent", exact: true }).click()

    // The HTTP call has already resolved: its assigned handle is on screen. If the
    // dialog closed on the response it would be gone by now, so the open assertion
    // below is what separates the two events.
    await expect(page.locator('[data-assigned-handle]')).toBeVisible()
    await expect(page.locator('[data-dialog="spawn-agent"]')).toBeVisible()

    expect(await pushTopologySnapshot(page, topologyFixture([SPAWNED_PANE]))).toBe(true)
    await expect(page.locator('[data-dialog="spawn-agent"]')).toHaveCount(0)
  })

  test("@guard the reporter preset stays on w1H and retires through Stop agent", async ({ page }) => {
    const spawnBodies: JsonObject[] = []
    const stopBodies: JsonObject[] = []
    let spawnCount = 0

    await openWithTopology(page, {
      lifecycle: {
        modelCatalogue: mockModelCatalogue,
        roleDetails: {
          reporter: {
            agentKind: "claude",
            briefing: "Reporter briefing.",
            effort: null,
            launcher: "claude-personal",
            model: null,
            name: "reporter",
            summary: "Observes and posts progress.",
          },
        },
        roles: [{ agentKind: "claude", effort: null, launcher: "claude-personal", model: null, name: "reporter", summary: "Observes and posts progress." }],
      },
      liveStream: true,
    })
    await page.route("**/api/herdr/agents", async (route) => {
      const request = route.request()
      if (request.method() !== "POST") {
        await route.fallback()
        return
      }
      spawnBodies.push(parseJsonObject(request.postData() ?? "{}"))
      spawnCount += 1
      if (spawnCount === 1) {
        await fulfillJson(route, { paneId: "w1H:pReporter", handle: "reporter-personal-projects" })
        return
      }
      await route.fulfill({
        body: JSON.stringify({ code: "ValidationFailed", error: "role already has a reporter" }),
        contentType: "application/json",
        status: 400,
      })
    })
    await page.route("**/api/herdr/agents/**", async (route) => {
      const request = route.request()
      if (request.method() !== "DELETE") {
        await route.fallback()
        return
      }
      stopBodies.push(parseJsonObject(request.postData() ?? "{}"))
      await fulfillJson(route, { paneId: "w1H:pReporter" })
    })

    await openWorkspaceMenuItem(page, "add-reporter")
    const dialog = page.locator('[data-dialog="add-reporter"]')
    await expect(dialog).toBeVisible()
    await expect(page.locator('[data-spawn-review]')).toContainText("Personal-Projects")
    await expect(page.locator('[data-combobox="spawn-agent-role"] [data-combobox-value]')).toContainText("reporter")
    await expect(page.locator("#spawn-agent-role")).toBeDisabled()
    await expect(page.locator("#spawn-agent-handle")).toHaveValue("reporter-personal-projects")
    await expect(page.locator("#spawn-agent-handle")).toHaveAttribute("readonly", "")
    await expect(page.getByRole("button", { name: "Add reporter", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Add reporter", exact: true }).click()

    await expect.poll(() => spawnBodies.length).toBe(1)
    expect(spawnBodies[0]).toEqual({
      handle: "reporter-personal-projects",
      launcher: "claude-personal",
      model: "default",
      role: "reporter",
      workspaceId: "w1H",
    })
    await expect(page.locator('[data-assigned-handle="reporter-personal-projects"]')).toBeVisible()

    expect(await pushTopologySnapshot(page, topologyFixture([REPORTER_PANE]))).toBe(true)
    await expect(dialog).toHaveCount(0)
    await page.locator('[data-quick-nav-item="agents"]').click()
    await expect(page.locator('[data-pane-id="w1H:pReporter"]')).toBeVisible()

    await openWorkspaceMenuItem(page, "add-reporter")
    await page.getByRole("button", { name: "Add reporter", exact: true }).click()
    await expect.poll(() => spawnBodies.length).toBe(2)
    await expect(page.getByText(/already has a reporter/i)).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    await openPaneMenu(page, "w1H:pReporter", "reporter-personal-projects")
    await page.locator('[data-menu-item="stop-agent"]').click()
    const stopDialog = page.locator('[data-dialog="stop-agent"]')
    await expect(stopDialog).toBeVisible()
    await expect(page.locator("[data-confirm-input]")).toHaveAttribute("data-confirm-input", "reporter-personal-projects")
    await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toBeDisabled()
    await page.locator("[data-confirm-input]").fill("reporter-personal-projects")
    await page.getByRole("button", { name: "Stop agent", exact: true }).click()
    await expect.poll(() => stopBodies.length).toBe(1)
    expect(stopBodies[0]).toEqual({ confirm: "reporter-personal-projects" })
    await expect(stopDialog).toHaveCount(0)
    await expect(page.locator('[data-pane-id="w1H:pReporter"]')).toHaveCount(0)
  })

  test("@guard the dialog names the handle the hub assigned, not the one typed", async ({ page }) => {
    await openWithTopology(page, {
      liveStream: true,
      lifecycle: { spawn: { paneId: "w1H:pF", handle: "builder-2" } },
    })
    await openWorkspaceMenuItem(page, "spawn-agent")
    await page.locator("#spawn-agent-handle").fill("builder")
    await page.getByRole("button", { name: "Spawn agent", exact: true }).click()

    // Asserting the typed handle would match in the common case and hide the
    // auto-suffix entirely, so the fixture makes them differ on purpose.
    await expect(page.locator('[data-assigned-handle="builder-2"]')).toBeVisible()
    await expect(page.getByText("builder-2", { exact: false })).toBeVisible()
  })

  test("@guard stop and close are separate controls with exact confirmations", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    // The fixture has no empty pane carrying a label, and that is the only shape
    // Close pane applies to, so it is delivered rather than assumed.
    expect(await pushTopologySnapshot(page, topologyFixture([EMPTY_LABELLED_PANE]))).toBe(true)

    // A matched agent pane confirms with the participant handle.
    await openPaneMenu(page, "w1H:p1", "lead")
    await expect(page.locator('[data-menu-item="stop-agent"]')).toBeVisible()
    await expect(page.locator('[data-menu-item="close-pane"]')).toHaveCount(0)
    await page.locator('[data-menu-item="stop-agent"]').click()
    await expect(page.locator('[data-dialog="stop-agent"]')).toBeVisible()
    await expect(page.locator("[data-confirm-input]")).toHaveAttribute("data-confirm-input", "lead")
    await page.keyboard.press("Escape")

    // An agent pane with no participant still stops, confirmed by its label.
    await openPaneMenu(page, "w1H:pB", "spare")
    await expect(page.locator('[data-menu-item="stop-agent"]')).toBeVisible()
    await expect(page.locator('[data-menu-item="close-pane"]')).toHaveCount(0)
    await page.locator('[data-menu-item="stop-agent"]').click()
    await expect(page.locator("[data-confirm-input]")).toHaveAttribute("data-confirm-input", "spare")
    await page.keyboard.press("Escape")

    // An empty pane with a label closes from the workspace detail.
    await page.locator('[data-quick-nav-item="workspaces"]').click()
    await page.locator('aside [data-workspace-id="w1H"] > a').click()
    const emptyPane = page.locator('[data-pane-id="w1H:pE"]')
    await expect(emptyPane).toBeVisible()
    await expect(emptyPane.getByRole("button", { name: "Close" })).toBeVisible()
    await emptyPane.getByRole("button", { name: "Close" }).click()
    await expect(page.locator('[data-dialog="close-pane"]')).toBeVisible()
    await expect(page.locator("[data-confirm-input]")).toHaveAttribute("data-confirm-input", "scratch")
    await page.keyboard.press("Escape")

    // AUDIT M-9: no participant and no label leaves nothing to confirm against, so
    // the pane offers neither control rather than one that cannot work.
    const unnamedEmptyPane = page.locator('[data-pane-id="w1H:p9"]')
    await expect(unnamedEmptyPane.getByRole("button", { name: "Stop" })).toHaveCount(0)
    await expect(unnamedEmptyPane.getByRole("button", { name: "Close" })).toHaveCount(0)
  })

  test("@guard a changed pane identity does not read as a mistyped name", async ({ page }) => {
    await openWithTopology(page, {
      lifecycle: { stopFailure: { status: 400, body: { code: "ValidationFailed", error: "confirm: pane identity changed" } } },
    })
    await openPaneMenu(page, "w1H:p1", "lead")
    await page.locator('[data-menu-item="stop-agent"]').click()
    await page.locator("[data-confirm-input]").fill("lead")
    await page.getByRole("button", { name: "Stop agent", exact: true }).click()

    // The safety check firing is not the operator mistyping. Asserting that "an
    // error appeared" would pass for either, so this asserts which string.
    await expect(page.getByText("That pane changed while the dialog was open.", { exact: false })).toBeVisible()
    await expect(page.getByText("The name you typed does not match.", { exact: false })).toHaveCount(0)
  })

  test("@guard a stream reconnect settles without blanking populated lists", async ({ page }) => {
    const sweepRequests: string[] = []
    const channelRequests: string[] = []
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname === "/api/channels") channelRequests.push(pathname)
      if (pathname.endsWith("/members") || pathname === "/api/inbox" || pathname === "/api/direct" || pathname === "/api/participants") {
        sweepRequests.push(pathname)
      }
    })
    await openApp(page, { liveStream: true })
    const initialSweepCount = sweepRequests.length
    const initialChannelCount = channelRequests.length

    const dropped = await page.evaluate(() => window.__endLiveStream?.("/api/events") ?? false)
    expect(dropped).toBe(true)
    await expect.poll(() => page.evaluate(() => [
      window.__liveStreamOpens?.("/api/events") ?? 0,
      window.__liveStreamOpens?.("/api/herdr/events") ?? 0,
    ])).toEqual([2, 0])
    await page.waitForTimeout(1_500)
    const afterSweepCount = sweepRequests.length
    await page.waitForTimeout(1_000)
    const settledSweepCount = sweepRequests.length
    const streams = await page.evaluate(() => [
      window.__liveStreamOpens?.("/api/events") ?? 0,
      window.__liveStreamOpens?.("/api/herdr/events") ?? 0,
    ])
    expect(streams).toEqual([2, 0])
    expect(afterSweepCount).toBe(initialSweepCount)
    expect(channelRequests.length).toBeGreaterThan(initialChannelCount)
    expect(settledSweepCount, "recovery must settle after one bounded sweep").toBe(afterSweepCount)
  })

  test("@guard a caught-up visible transcript stops acknowledgement traffic", async ({ page }) => {
    const requests: string[] = []
    page.on("request", (request) => requests.push(new URL(request.url()).pathname))
    await forceVisibleMessages(page)
    await openApp(page, { identityHandle: "suleyman", liveStream: true })
    await expect(page.locator('[data-slot="message-scroller-item"]').first()).toBeVisible()
    await expect.poll(() => requests.filter((path) => path.endsWith("/ack")).length).toBeGreaterThan(0)

    const settledRequestCount = requests.length
    await page.waitForTimeout(1_000)
    expect(requests.length, "a caught-up visible transcript must not re-enqueue acknowledgements").toBe(settledRequestCount)
  })

  test("@guard acknowledgement coalescing keeps one POST per channel window", async ({ page }) => {
    const throughIds: number[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (request.method() !== "POST" || url.pathname !== "/api/channels/ops/ack") return
      const body = v.parse(acknowledgementRequestSchema, JSON.parse(request.postData() ?? "{}"))
      throughIds.push(body.throughId)
    })

    await forceVisibleMessages(page)
    await openApp(page, {
      ackTimingFixture: true,
      identityHandle: "suleyman",
      liveStream: true,
      waitForMessages: false,
    })
    await page.locator('[data-channel-row="ops"] > a').click()
    await expect(page.getByRole("heading", { name: "ops", exact: true })).toBeVisible()
    expect(await pushLiveMessage(page, acknowledgementTimingMessage(1))).toBe(true)
    await expect(page.locator('[data-message-id="1"]')).toBeVisible()

    await page.waitForTimeout(120)
    expect(await pushLiveMessage(page, acknowledgementTimingMessage(2))).toBe(true)
    await expect(page.locator('[data-message-id="2"]')).toBeVisible()
    await expect.poll(() => throughIds.length, { timeout: 1_000, message: "the first acknowledgement window must flush" }).toBe(1)
    expect(throughIds, "the first request must carry the latest id in its window").toEqual([2])

    expect(await pushLiveMessage(page, acknowledgementTimingMessage(3))).toBe(true)
    await expect(page.locator('[data-message-id="3"]')).toBeVisible()
    await page.waitForTimeout(150)
    expect(throughIds, "a follow-up acknowledgement must not fire during the observation interval").toEqual([2])
  })

  test("@guard a token in a spawn response never reaches the page", async ({ page }) => {
    await openWithTopology(page, {
      liveStream: true,
      lifecycle: { spawn: { paneId: "w1H:pF", handle: "spawned-agent", token: "tok-must-never-appear" } },
    })
    await openWorkspaceMenuItem(page, "spawn-agent")
    await page.locator("#spawn-agent-handle").fill("builder")
    await page.getByRole("button", { name: "Spawn agent", exact: true }).click()
    await expect(page.locator('[data-assigned-handle]')).toBeVisible()

    const leaked = await page.evaluate(() =>
      document.body.innerText.includes("tok-must-never-appear")
      || JSON.stringify(globalThis.localStorage).includes("tok-must-never-appear"),
    )
    expect(leaked, "a token in the response must not reach the DOM or storage").toBe(false)
  })

  test("@guard one stream drop settles instead of sweeping forever", async ({ page }) => {
    // The operator symptom is repeating FULL sweeps. One drop must cost exactly one
    // recovery sweep. Counting only "did requests happen" would pass while looping,
    // so this asserts that a later window adds nothing.
    const hits: string[] = []
    page.on("request", (request) => hits.push(new URL(request.url()).pathname))
    await openWithTopology(page, { liveStream: true })
    await page.locator('[data-quick-nav-item="workspaces"]').click()
    await expect(page.locator('[data-workspace-id="w1H"]')).toBeVisible()
    await page.waitForTimeout(1000)

    expect(await page.evaluate(() => window.__endLiveStream?.("/api/events")), "the stream must be open to drop it").toBe(true)
    await page.waitForTimeout(3000)
    const afterRecovery = hits.length
    expect(afterRecovery, "one drop must cost one recovery sweep").toBeGreaterThan(0)

    await page.waitForTimeout(3000)
    expect(hits.length, "a settled app must issue nothing further after its recovery sweep").toBe(afterRecovery)
  })

  test("@guard a reconnect reopens each stream once, never accumulating", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    await page.locator('[data-quick-nav-item="workspaces"]').click()
    await expect(page.locator('[data-workspace-id="w1H"]')).toBeVisible()
    await page.waitForTimeout(1000)
    const before = await page.evaluate(() => ({
      messages: window.__liveStreamOpens?.("/api/events") ?? 0,
      topology: window.__liveStreamOpens?.("/api/herdr/events") ?? 0,
    }))
    expect(before.messages, "the transcript stream must be open before it is dropped").toBe(1)

    await page.evaluate(() => window.__endLiveStream?.("/api/events"))
    await page.waitForTimeout(3000)

    const after = await page.evaluate(() => ({
      messages: window.__liveStreamOpens?.("/api/events") ?? 0,
      topology: window.__liveStreamOpens?.("/api/herdr/events") ?? 0,
    }))
    expect(after.messages, "one drop must reopen the transcript stream exactly once").toBe(2)
    expect(after.topology, "the legacy topology endpoint must not open").toBe(0)
  })

  test("@guard the stream counter sees an additive legacy connection", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    await expect(page.locator("[data-sidebar-rail]")).toBeVisible()

    const observed = await page.evaluate(async () => {
      const controller = new AbortController()
      void fetch("/api/herdr/events", { signal: controller.signal }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 50))
      const opens = window.__liveStreamOpens?.("/api/herdr/events") ?? 0
      controller.abort()
      return opens
    })

    expect(observed, "the harness must count a second endpoint before zero proves absence").toBe(1)
  })

  test("@guard the live app stays render-stable through an SSE keepalive", async ({ page }) => {
    const server = await startSharedEventServer(topologyFixture())
    await page.context().route("**/api/events", (route) => route.continue({ url: server.url }))
    try {
      await installReactCommitCounter(page)
      await openWithTopology(page, { sharedLiveStream: true })
      await expect(page.locator("[data-sidebar-rail]")).toBeVisible()
      await expect(page.locator('[data-stream-state="live"]')).toHaveCount(1)

      // The counter is read-only and cannot schedule a render. A topology change
      // must move it before its later zero-delta observations mean anything.
      await waitForNextPaint(page)
      const beforeTopology = await reactCommitCount(page)
      expect(beforeTopology, "the live app must have committed before it can be measured").toBeGreaterThan(0)

      server.send({ data: topologyFixture([SPAWNED_PANE]), event: "topology", id: "101" })
      await expect.poll(
        () => reactCommitCount(page),
        { message: "a topology event must move the render counter" },
      ).toBeGreaterThan(beforeTopology)
      const afterTopology = await reactCommitCount(page)

      // These are observed browser paints, not a fixed wall-clock window.
      await waitForNextPaint(page)
      const afterIdlePaint = await reactCommitCount(page)
      expect(afterIdlePaint, "the idle app must add no render between observed paints").toBe(afterTopology)

      expect(server.keepalive(), "the live SSE must deliver a keepalive").toBe(1)
      await waitForNextPaint(page)
      const afterKeepalive = await reactCommitCount(page)
      expect(afterKeepalive, "an SSE keepalive must not cause a render").toBe(afterIdlePaint)
    } finally {
      await page.context().unroute("**/api/events")
      await server.close()
    }
  })

  test("@finding 26 a reconnect never replaces populated lists with a skeleton", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    await expect(page.locator('[data-workspace-id="w1H"]')).toBeVisible()
    await expect(page.locator('nav[aria-label="Channels"] button').first()).toBeVisible()

    await page.evaluate(() => {
      const seen = { channels: 0, workspaces: 0 }
      window.__seen = seen
      const check = (): void => {
        if (document.querySelector('[aria-label="Loading channels"]') !== null) seen.channels += 1
        if (document.querySelector('[aria-label="Loading workspaces"]') !== null) seen.workspaces += 1
      }
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true })
      setInterval(check, 5)
    })

    const opensBefore = await page.evaluate(() => ({
      messages: window.__liveStreamOpens?.("/api/events") ?? 0,
      topology: window.__liveStreamOpens?.("/api/herdr/events") ?? 0,
    }))
    await page.evaluate(() => window.__endLiveStream?.("/api/events"))

    // Non-vacuity: this check asserts an ABSENCE, so it passes for free if the
    // reconnect never happens. Wait for the merged stream to reopen before judging.
    await expect
      .poll(async () => page.evaluate(() => ({
        messages: window.__liveStreamOpens?.("/api/events") ?? 0,
        topology: window.__liveStreamOpens?.("/api/herdr/events") ?? 0,
      })), { timeout: 10_000 })
      .toEqual({ messages: opensBefore.messages + 1, topology: 0 })
    await page.waitForTimeout(500)

    const seen = await page.evaluate(() => window.__seen)
    expect(seen, "a revalidation must refresh underneath the operator, not blank the list").toEqual({ channels: 0, workspaces: 0 })
  })

  test("@guard one shared stream serves tabs and takes over in order", async ({ page, browser }) => {
    const context = page.context()
    const tabs = [page, await context.newPage(), await context.newPage()]
    const server = await startSharedEventServer(topologyFixture())
    await context.route("**/api/events", (route) => route.continue({ url: server.url }))
    try {
      for (const tab of tabs) {
        await openWithTopology(tab, { sharedLiveStream: true })
        await expect(tab.locator("[data-sidebar-rail]")).toBeVisible()
      }
      await expect.poll(() => server.opens).toBe(1)

      // A follower reload must remain a follower while the current owner is live.
      await tabs[2]?.reload()
      await expect(tabs[2]?.locator("[data-sidebar-rail]")).toBeVisible()
      await expect.poll(() => server.opens).toBe(1)

      const seed = mockMessages[0]
      if (seed === undefined) throw new Error("fixtures lost the stream seed")
      const liveMessages = [1, 2, 3, 4].map((index) => ({
        ...seed,
        attachments: [],
        body: `shared relay ${String(index)}`,
        channel: "handoff",
        id: 5_000 + index,
      }))
      const observed: string[][] = tabs.map(() => [])
      for (const [index, message] of liveMessages.slice(0, 3).entries()) {
        server.send({ data: message, id: String(101 + index) })
        for (const [tabIndex, tab] of tabs.entries()) {
          await expect(tab.getByText(message.body, { exact: true })).toBeVisible()
          const item = tab.locator(`[data-message-id="${String(message.id)}"]`)
          await expect(item).toBeVisible()
          observed[tabIndex]?.push(message.id.toString())
        }
      }

      await tabs[0]?.close()
      await expect.poll(() => server.opens, { timeout: 5_000 }).toBe(2)
      expect(server.lastEventIds).toEqual(["", "103"])
      const takeoverMessage = liveMessages[3]
      if (takeoverMessage === undefined) throw new Error("fixtures lost the takeover message")
      server.send({ data: takeoverMessage, id: "104" })
      for (const [tabIndex, tab] of tabs.slice(1).entries()) {
        await expect(tab.getByText("shared relay 4", { exact: true })).toBeVisible()
        const item = tab.locator(`[data-message-id="${String(takeoverMessage.id)}"]`)
        await expect(item).toBeVisible()
        observed[tabIndex + 1]?.push(takeoverMessage.id.toString())
      }
      expect(observed[1]).toEqual(["5001", "5002", "5003", "5004"])
      expect(observed[2]).toEqual(["5001", "5002", "5003", "5004"])
      expect(new Set(server.sentIds).size).toBe(server.sentIds.length)

      const noLocksContext = await browser.newContext({ baseURL: new URL(tabs[1]?.url() ?? "http://127.0.0.1").origin })
      const noLocksPage = await noLocksContext.newPage()
      await noLocksPage.addInitScript(() => {
        try {
          Object.defineProperty(Navigator.prototype, "locks", { configurable: true, get: () => undefined })
        } catch {
          Object.defineProperty(navigator, "locks", { configurable: true, value: undefined })
        }
      })
      await openWithTopology(noLocksPage, { sharedLiveStream: true })
      await expect(noLocksPage.locator("[data-sidebar-rail]")).toBeVisible()
      await expect(noLocksPage.locator('[data-stream-state="offline"]')).toHaveCount(1)
      expect(server.opens, "the no-Web-Locks path must not open a fallback stream").toBe(2)
      await noLocksContext.close()
    } finally {
      await context.unroute("**/api/events")
      await Promise.all(tabs.map((tab) => tab.close().catch(() => undefined)))
      await server.close()
    }
  })

  test("@guard a starved stream stops hammering and degrades", async ({ page }) => {
    // What bounds recovery is the degrade cap, not the delay curve. After
    // `degradedAfterFailures` consecutive failures the client sets degraded and the
    // wait jumps to `degradedRetryDelayMs`, so attempts stop within a small count.
    //
    // This guard replaces one that asserted a DECREASING attempt profile. That bound
    // went stale the moment bounded recovery landed: the cap fires before exponential
    // growth is ever exercised, so the profile reads [2,0,0] whether the delay doubles
    // or not, and removing the doubling left the old guard green.
    //
    // Retries are counted inside the page because the patched fetch answers these
    // paths before the network.
    await openWithTopology(page, { liveStream: true })
    await expect(page.locator("[data-sidebar-rail]")).toBeVisible()
    await page.waitForTimeout(1000)

    const opensNow = async (): Promise<number> =>
      page.evaluate(() => window.__liveStreamOpens?.("/api/events") ?? 0)
    const start = await opensNow()

    await page.evaluate(() => window.__failLiveStream?.("/api/events", 60))
    await page.evaluate(() => window.__endLiveStream?.("/api/events"))
    await page.waitForTimeout(8000)

    const attempts = (await opensNow()) - start
    expect(attempts, "the client must actually retry, or this check proves nothing").toBeGreaterThan(0)
    // Bound set from measurement, not arithmetic. In this window the shipped client
    // makes 2 attempts; with the degrade cap disabled it makes 4; with the cap and the
    // exponential growth both disabled it makes 22. Three catches either regression
    // while leaving one attempt of headroom for jitter.
    expect(
      attempts,
      `a starved stream must stop hammering, saw ${String(attempts)} attempts in 8s`,
    ).toBeLessThanOrEqual(3)
  })

  test("@guard a starved topology stream flips its state hook", async ({ page }) => {
    // This asserts the machine-readable hook only. What the operator READS is a
    // separate property and a separate check, because the two disagree today.
    await openWithTopology(page, { liveStream: true })
    await expect(page.locator("[data-sidebar-rail]")).toBeVisible()
    await page.waitForTimeout(1000)

    await page.evaluate(() => window.__failLiveStream?.("/api/events", 20))
    await page.evaluate(() => window.__endLiveStream?.("/api/events"))
    await page.waitForTimeout(4000)

    const state = await page.locator("[data-stream-state]").first().getAttribute("data-stream-state")
    expect(["reconnecting", "degraded", "offline"], `a starved event stream must flip its hook, got ${String(state)}`).toContain(state)
  })

  test("@guard the transcript stream reports reconnection in words", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    await expect(page.locator('nav[aria-label="Channels"] button').first()).toBeVisible()
    await page.waitForTimeout(1000)

    await page.evaluate(() => window.__failLiveStream?.("/api/events", 20))
    await page.evaluate(() => window.__endLiveStream?.("/api/events"))

    await expect(page.getByText(/^reconnecting/).first()).toBeVisible({ timeout: 5000 })
  })

  test("@finding 27 a starved topology stream says so in words, not as freshness", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    await expect(page.locator('[data-workspace-id="w1H"]')).toBeVisible()
    await page.waitForTimeout(1000)

    await page.evaluate(() => window.__failLiveStream?.("/api/events", 40))
    await page.evaluate(() => window.__endLiveStream?.("/api/events"))
    await page.waitForTimeout(5000)

    // The hook flips in about half a second, but the label the operator reads swaps
    // "topology live" for an age string. Reading "last updated just now" while the
    // stream is dead is worse than silence: it asserts freshness that is not true.
    const text = await page.locator("[data-topology-state]").first().textContent()
    expect(
      text ?? "",
      `a dead topology stream must not read as fresh, got ${String(text)}`,
    ).toMatch(/reconnect|degraded|unavailable|offline|stale/i)
  })

  test("@guard each primary navigation icon opens its page", async ({ page }) => {
    await openWithTopology(page)
    const pageOf = async (): Promise<string | null> =>
      page.locator("[data-shell-page]").first().getAttribute("data-shell-page")

    for (const route of ["workspaces", "agents", "channels", "direct", "staffing"] as const) {
      await page.locator(`[data-quick-nav-item="${route}"]`).click()
      await expect
        .poll(pageOf, { message: `${route} icon must navigate the content area` })
        .toBe(route)
    }
  })

  test("@guard quick navigation routes, marks one page, and stays outside the row budget", async ({ page }) => {
    await openWithTopology(page)
    const quickNav = page.locator("[data-quick-nav]")
    const items = quickNav.locator("[data-quick-nav-item]")
    await expect(quickNav).toBeVisible()
    await expect(items).toHaveCount(5)
    expect(await items.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-quick-nav-item")))).toEqual(["workspaces", "agents", "channels", "direct", "staffing"])
    const quickNavNames = await items.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))
    expect(quickNavNames).toEqual(["Open Workspaces", "Open Agents", "Open Channels", "Open Direct", "Open Role presets"])
    expect(await quickNav.locator("[data-sidebar-row-height]").count(), "quick navigation is chrome, not a family row").toBe(0)

    const geometry = await page.evaluate(() => {
      const head = document.querySelector("[data-sidebar-head]")
      const quick = document.querySelector("[data-quick-nav]")?.getBoundingClientRect()
      const body = document.querySelector("[data-sidebar-body]")?.getBoundingClientRect()
      const families = [...document.querySelectorAll("[data-sidebar-family]")].map((node) => node.getBoundingClientRect())
      return {
        familyOverlap: quick === undefined
          ? true
          : families.some((family) => quick.top < family.bottom && family.top < quick.bottom),
        renderedHeadHeight: head?.getBoundingClientRect().height ?? 0,
        quickHeight: quick?.height ?? 0,
        quickBeforeBody: quick !== undefined && body !== undefined && quick.bottom <= body.top,
      }
    })
    expect(geometry.renderedHeadHeight, "the sidebar head must occupy layout space").toBeGreaterThan(0)
    expect(geometry.quickHeight, "quick navigation must occupy a measured chrome row").toBeGreaterThan(0)
    expect(geometry.quickBeforeBody, "quick navigation must sit above the active panel").toBe(true)
    expect(geometry.familyOverlap, "quick navigation must not overlap a family section").toBe(false)

    for (const route of ["workspaces", "agents", "channels", "direct", "staffing"] as const) {
      await quickNav.locator(`[data-quick-nav-item="${route}"]`).click()
      await expect(page.locator("[data-shell-page]")).toHaveAttribute("data-shell-page", route)
      await expect(quickNav.locator(`[data-quick-nav-item="${route}"]`)).toHaveAttribute("aria-current", "page")
      await expect(quickNav.locator('[aria-current="page"]')).toHaveCount(1)
      await expect(quickNav.locator('[data-quick-nav-item]:not([aria-current="page"])')).toHaveCount(4)
    }
  })

  test("@guard context menus reposition fully inside the viewport near the bottom edge", async ({ page }) => {
    await page.setViewportSize({ height: 720, width: 1280 })
    await openWithTopology(page, { extraChannels: 32 })
    const trigger = page.locator('[data-menu-trigger="channel"]').last()
    await expect(trigger).toBeVisible()
    await trigger.evaluate((node) => {
      if (!(node instanceof HTMLElement)) throw new Error("channel menu trigger is not an HTMLElement")
      node.style.left = `${globalThis.innerWidth - 2}px`
      node.style.opacity = "1"
      node.style.position = "fixed"
      node.style.top = `${globalThis.innerHeight - 2}px`
      node.click()
    })
    const menu = page.getByRole("menu")
    await expect(menu).toBeVisible()
    const menuBox = await menu.boundingBox()
    const triggerBox = await trigger.boundingBox()
    expect(menuBox).not.toBeNull()
    expect(triggerBox).not.toBeNull()
    expect(menuBox?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect(menuBox === null ? 1281 : menuBox.x + menuBox.width).toBeLessThanOrEqual(1280)
    expect(menuBox?.y ?? -1).toBeGreaterThanOrEqual(0)
    expect(menuBox === null ? 721 : menuBox.y + menuBox.height).toBeLessThanOrEqual(720)
    expect(menuBox !== null && triggerBox !== null && menuBox.y < triggerBox.y, "a bottom-edge menu must flip above its trigger").toBe(true)
  })

  test("@guard primary navigation uses distinct stable icon identities", async ({ page }) => {
    await openWithTopology(page)
    const icons = await page.locator("[data-quick-nav-item] svg").evaluateAll((nodes) => nodes.map((node) => node.innerHTML.trim()))
    expect(icons).toHaveLength(5)
    expect(icons.every((identity) => identity.length > 0), "primary navigation icons need stable rendered identities").toBe(true)
    expect(new Set(icons).size, "primary navigation items must use unique icons").toBe(icons.length)
  })

  test("@guard the event stream names its current connection state", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    await expect(page.locator("[data-sidebar-rail]")).toBeVisible()
    await expect(page.locator('[data-stream-state="live"]')).toHaveCount(1)
    await page.waitForTimeout(1000)

    await page.evaluate(() => window.__failLiveStream?.("/api/events", 20))
    await page.evaluate(() => window.__endLiveStream?.("/api/events"))
    await expect(page.locator('[data-stream-state]:not([data-stream-state="live"])')).toHaveCount(1, { timeout: 5_000 })
    await expect(page.locator('[data-stream-state]:not([data-stream-state="live"])')).toHaveText(/reconnect|degraded|unavailable|offline/i)
  })

  test("@finding 28 a workspace view still reports its transcript stream state", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    const workspace = page.locator('[data-workspace-id="w1H"]')
    await expect(workspace).toBeVisible()
    await workspace.locator("button").first().click()

    // The workspace branch renders WorkspacePanel with no header of its own, so the
    // stream indicator that the channel and direct branches carry is absent here.
    // Asserting an addressable hook covers both halves: it must exist, and it must be
    // reachable by something other than matching rendered words.
    await expect(page.locator("[data-stream-state]")).toHaveCount(1)
  })

  test("@guard a deactivated participant leaves active surfaces but keeps readable history", async ({ page }) => {
    await openApp(page, {
      deactivatedHandle: "planner",
      identityHandle: "suleyman",
      withDirect: true,
    })

    const historicalMessage = page.locator('[data-message-id="1"]')
    await expect(historicalMessage).toContainText("planner")
    await expect(historicalMessage.locator('[data-slot="message-avatar"] svg')).toHaveCount(1)
    await expect(historicalMessage.getByRole("button", { name: "Message planner directly" })).toHaveCount(0)

    await page.getByRole("button", { name: /Show \d+ channel members/ }).click()
    const membersDialog = page.getByRole("dialog")
    await expect(membersDialog.locator('[data-member-handle="planner"]')).toHaveCount(0)
    await expect(membersDialog.locator('[data-picker-group="participants"]', { hasText: "planner" })).toHaveCount(0)
    await membersDialog.getByRole("button", { name: "Close channel members" }).click()

    await page.locator('[data-message-id="3"]').getByRole("button", { name: "Message runner directly" }).click()
    const directPage = page.locator('[data-shell-page="compose-direct"]')
    await expect(directPage.locator('[data-picker-group]', { hasText: "planner" })).toHaveCount(0)
    await directPage.getByRole("link", { name: "Back to Direct" }).click()

    await page.goto("/")
    await page.getByRole("button", { name: "Open inbox" }).click()
    const inboxDialog = page.getByRole("dialog")
    await expect(inboxDialog.getByText("planner", { exact: true })).toHaveCount(0)
    await inboxDialog.getByRole("button", { name: "Close inbox" }).click()

    await page.locator('[data-quick-nav-item="direct"]').click()
    await page.locator('aside [data-channel-row="dm-abc123def456"] > a').click()
    const composer = page.locator("#message-composer")
    await expect(composer).toHaveAttribute("readonly", "")
    await expect(composer).toHaveAttribute("placeholder", /deactivated participant.*History remains readable/)
    await expect(page.locator('[data-message-id="1"]')).toContainText("planner")
  })

  test("@guard a pane arriving on the topology stream is applied without a reload", async ({ page }) => {
    // The primitive the lifecycle work needs: a pane that appears because a snapshot
    // arrived, not because the stream reconnected and the app reloaded. Holding the
    // stream open is what separates those, so this also proves the harness itself.
    await openWithTopology(page, { liveStream: true })
    await page.locator('[data-quick-nav-item="agents"]').click()
    await expect(page.locator('[data-pane-id="w1H:p1"]')).toBeVisible()
    await expect(page.locator('[data-pane-id="w1H:pF"]')).toHaveCount(0)
    const connectionsBefore = await page.evaluate(() => window.__liveStreamOpens?.("/api/events") ?? 0)

    const delivered = await pushTopologySnapshot(page, topologyFixture([SPAWNED_PANE]))
    expect(delivered, "the topology stream must be open").toBe(true)

    await expect(page.locator('[data-pane-id="w1H:pF"]')).toBeVisible()
    expect(
      await page.evaluate(() => window.__liveStreamOpens?.("/api/events") ?? 0),
      "the pane must arrive on the open stream, not through a reconnect",
    ).toBe(connectionsBefore)
  })

  test("@finding 12 the markdown viewer gives headings a visible hierarchy", async ({ page }) => {
    await openApp(page)
    await openMarkdownViewer(page)
    const heading = await page.evaluate(() => {
      const h1 = document.querySelector(".prose h1, .md-view h1")
      const body = document.querySelector('[data-slot="bubble-content"] p')
      if (h1 === null || body === null) return null
      return {
        headingSize: Number.parseFloat(getComputedStyle(h1).fontSize),
        bodySize: Number.parseFloat(getComputedStyle(body).fontSize),
        weight: Number.parseInt(getComputedStyle(h1).fontWeight, 10),
      }
    })
    expect(heading).not.toBeNull()
    expect(heading?.headingSize ?? 0).toBeGreaterThan(heading?.bodySize ?? 0)
    expect(heading?.weight ?? 0).toBeGreaterThan(400)
  })

  test("@finding 12 a markdown attachment does not use the image glyph", async ({ page }) => {
    await openApp(page)
    const glyph = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-slot="attachment"]')]
      const card = cards.find((candidate) => candidate.textContent?.includes(".md"))
      return card?.querySelector('[data-slot="attachment-media"] svg')?.getAttribute("class") ?? ""
    })
    expect(glyph).not.toMatch(/image/i)
  })

  test("@finding 16 a direct conversation is reachable from the quick switcher", async ({ page }) => {
    await openApp(page, { withDirect: true })
    await blurActiveElement(page)
    await page.keyboard.press("Control+k")
    const options = await page.locator('[role="option"]').allInnerTexts()
    expect(options.join(" ")).toMatch(/lead/)
  })

  test("@finding 18 a rejected channel name states the rule, not the status code", async ({ page }) => {
    await openApp(page)
    await blurActiveElement(page)
    await page.keyboard.press("n")
    await page.fill("#channel-name", "UX Lab Two")
    const createPage = page.locator('[data-shell-page="create-channel"]')
    await createPage.locator("button[type=submit]").click()
    const text = await createPage.locator('p[role="alert"]').innerText()
    expect(text).not.toMatch(/HTTP \d{3}|POST |GET /)
    expect(text).toMatch(/lowercase|letter/i)
  })

  test("@finding 1 the newest message sits near the bottom of the transcript", async ({ page }) => {
    await openApp(page)
    const gap = await page.evaluate(() => {
      const viewport = document.querySelector('[data-slot="message-scroller-viewport"]')
      const items = [...document.querySelectorAll('[data-slot="message-scroller-item"]')]
      const last = items[items.length - 1]
      if (viewport === null || last === undefined) return null
      return Math.round(viewport.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom)
    })
    expect(gap).not.toBeNull()
    expect(gap ?? 0).toBeLessThanOrEqual(24)
  })

  test("@finding 6 selecting a channel does not change membership", async ({ page }) => {
    await openApp(page)
    const writes: string[] = []
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/")) {
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
      }
    })
    const rows = page.locator('nav[aria-label="Channels"] button')
    await rows.nth(1).click()
    await page.waitForTimeout(1200)
    expect(writes, "browsing a channel must not write membership").toEqual([])
  })

  test("@finding 5 the inbox lists only unread channels, by their operator names", async ({ page }) => {
    await openApp(page, { withDirect: true })
    await blurActiveElement(page)
    await page.keyboard.press("b")
    await expect(page.locator('[role="dialog"] h2')).toHaveText(/inbox/i)
    const rows = await page.locator('[role="dialog"] li').allInnerTexts()
    expect(rows.join(" "), "a dm- storage name is not triageable").not.toMatch(/dm-[0-9a-f]{6}/)
    expect(rows.filter((row) => /\b0 unread\b/.test(row)), "zero-unread rows are noise").toEqual([])
  })

  test("@finding 16 the DIRECT header offers the same affordance as CHANNELS", async ({ page }) => {
    await openApp(page, { withDirect: true })
    // Selector repair, not an assertion change: the section title used to be a <p>
    // and the shell frame made it a <button>, so the old `aside p` lookup could no
    // longer find it against any implementation, correct or not.
    //
    // "Has a button" would now pass for free — every section carries a navigate and a
    // collapse control. The finding is about SYMMETRY, so this asserts that DIRECT
    // offers as many controls as CHANNELS and that both carry more than those two.
    const affordances = await page.evaluate(() => {
      const controls = (section: string): string[] => {
        const node = document.querySelector(`[data-sidebar-section="${section}"]`)
        return node === null
          ? []
          : [...node.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? "")
      }
      return { channels: controls("channels"), direct: controls("direct") }
    })
    expect(
      affordances.direct.length,
      "the obvious place to start a DM must be actionable",
    ).toBe(affordances.channels.length)
    expect(
      affordances.direct.length,
      "navigate and collapse alone are not an affordance",
    ).toBeGreaterThan(2)
  })

  test("@finding 21 a saved binding survives a new action being added", async ({ page }) => {
    // A binding set saved before the action list grew: every current action except
    // one, with a custom combo on the first. parseBindings rejects it on entry count
    // and loadBindings silently returns defaults, so the custom combo disappears.
    await page.addInitScript(() => {
      const bindings = [
        { action: "channel.next", combo: "0" },
        { action: "channel.prev", combo: "[" },
        { action: "channel.picker", combo: "Ctrl+K" },
        { action: "channel.members", combo: "m" },
        { action: "channel.create", combo: "n" },
        { action: "search.focus", combo: "/" },
        { action: "search.scopeToggle", combo: "s" },
        { action: "composer.focus", combo: "c" },
        { action: "composer.attach", combo: "Ctrl+Shift+A" },
        { action: "composer.send", combo: "Enter" },
        { action: "composer.newline", combo: "Shift+Enter" },
        { action: "message.focusNext", combo: "j" },
        { action: "message.focusPrev", combo: "k" },
        { action: "message.dmAuthor", combo: "d" },
        { action: "message.jumpUnread", combo: "u" },
        { action: "message.jumpLatest", combo: "Shift+G" },
        { action: "attachment.view", combo: "v" },
        { action: "attachment.copyPath", combo: "y" },
        { action: "overlay.close", combo: "Escape" },
        { action: "help.show", combo: "?" },
        { action: "identity.introduce", combo: "i" },
        { action: "settings.open", combo: "Ctrl+," },
      ]
      window.localStorage.setItem("msgr.keyboard.v1", JSON.stringify({ version: 1, bindings }))
    })
    await openApp(page)
    await blurActiveElement(page)
    await page.keyboard.press("?")
    await expect(page.locator('[role="dialog"] h2')).toHaveText(/keyboard/i)
    const nextChannelRow = await page.locator('[aria-label="Current keyboard shortcuts"] li')
      .filter({ hasText: "Next channel" }).innerText()
    expect(
      nextChannelRow,
      "a stored binding must survive an action being added, not be silently reset",
    ).toContain("0")
  })

  test("@finding 21 an unbound action does not destroy the saved binding set", async ({ page }) => {
    // serializeBindings writes combo "" for an action with no binding, and
    // parseBindings rejects the whole config on any empty combo, so a deliberate
    // non-binding makes every save unreadable on the next load.
    await page.addInitScript(() => {
      const bindings = [
        { action: "channel.next", combo: "0" },
        { action: "channel.prev", combo: "[" },
        { action: "channel.picker", combo: "Ctrl+K" },
        { action: "channel.members", combo: "m" },
        { action: "channel.create", combo: "n" },
        { action: "search.focus", combo: "/" },
        { action: "search.scopeToggle", combo: "s" },
        { action: "composer.focus", combo: "c" },
        { action: "composer.attach", combo: "Ctrl+Shift+A" },
        { action: "composer.send", combo: "Enter" },
        { action: "composer.newline", combo: "Shift+Enter" },
        { action: "message.focusNext", combo: "j" },
        { action: "message.focusPrev", combo: "k" },
        { action: "message.dmAuthor", combo: "d" },
        { action: "message.jumpUnread", combo: "u" },
        { action: "message.jumpLatest", combo: "Shift+G" },
        { action: "attachment.view", combo: "v" },
        { action: "attachment.copyPath", combo: "" },
        { action: "overlay.close", combo: "Escape" },
        { action: "help.show", combo: "?" },
        { action: "identity.introduce", combo: "i" },
        { action: "settings.open", combo: "Ctrl+," },
        { action: "inbox.open", combo: "b" },
      ]
      window.localStorage.setItem("msgr.keyboard.v1", JSON.stringify({ version: 1, bindings }))
    })
    await openApp(page)
    await blurActiveElement(page)
    await page.keyboard.press("?")
    await expect(page.locator('[role="dialog"] h2')).toHaveText(/keyboard/i)
    const row = await page.locator('[aria-label="Current keyboard shortcuts"] li')
      .filter({ hasText: "Next channel" }).innerText()
    expect(
      row,
      "one unbound action must not discard every other binding in the set",
    ).toContain("0")
  })

  test("@finding 5.2 a pane row names the handle, the label, or the pane id in that order", async ({ page }) => {
    await openWithTopology(page)
    await page.locator('[data-workspace-id="w1A"] > div > button[aria-expanded]').click()
    const withParticipant = page.locator('[data-pane-id="w1H:p1"]')
    await expect(withParticipant).toHaveAttribute("data-identity-source", "participant")
    await expect(withParticipant).toContainText("lead")
    await expect(page.locator('[data-pane-id="w1H:p3"]')).toHaveAttribute("data-identity-source", "label")
    await expect(page.locator('[data-pane-id="w1H:p3"]')).toContainText("reviewer-pane")
    await expect(page.locator('[data-pane-id="w1H:pB"]')).toHaveAttribute("data-identity-source", "label")
    await expect(page.locator('[data-pane-id="w1A:p1"]')).toHaveAttribute("data-identity-source", "pane-id")
  })

  test("@finding 5.2 a pane with no agent reads as an empty pane", async ({ page }) => {
    await openWithTopology(page)
    const empty = page.locator('[data-pane-id="w1H:p9"]')
    await expect(empty).toHaveAttribute("data-pane-status", "empty")
    await expect(empty).toContainText(/empty pane/i)
  })

  test("@finding 5.2 an old route does not label a current pane", async ({ page }) => {
    await openWithTopology(page)
    const pane = page.locator('[data-pane-id="w1H:p3"]')
    await expect(pane).toHaveAttribute("data-identity-source", "label")
    await expect(pane).toContainText(/reviewer-pane/i)
    await expect(pane).toContainText(/unmanaged/i)
    await expect(pane).not.toContainText(/codex-reviewer|stale/i)
  })

  test("@guard a direct delivery warning arrives, explains the consequence, and clears after healing", async ({ page }) => {
    await openApp(page, { liveStream: true, withDirect: true })
    await page.locator('[data-quick-nav-item="direct"]').click()
    await page.locator('aside [data-channel-row="dm-abc123def456"] > a').click()

    const surface = page.locator('[data-conversation-surface="true"]')
    const transcript = surface.getByRole("list", { name: "Messages" })
    await expect(transcript).toBeVisible()
    const warning = surface.locator("[data-direct-delivery-warning]")
    await expect(warning).toHaveCount(0)

    expect(await pushTopologySnapshot(page, topologyFixture([], undefined, "active", "stale"))).toBe(true)
    await expect(warning).toBeVisible({ timeout: 2_000 })
    await expect(warning.locator("[data-direct-delivery-consequence]")).toHaveText("lead has no active chat route.")
    await expect(warning, "the direct warning must state the delivery consequence, not only the route state").not.toContainText(/stale route/i)
    await expect(surface.locator("[data-direct-delivery-warning]")).toHaveCount(1)

    const compose = warning.locator('[data-direct-delivery-action="compose"]')
    await expect(compose).toHaveAccessibleName("Write a new message")
    await expect(compose).toBeEnabled()
    await compose.click()
    await expect(page.locator("#message-composer")).toBeFocused()

    expect(await pushTopologySnapshot(page, topologyFixture([], undefined, "active", "active"))).toBe(true)
    await expect(warning).toHaveCount(0, { timeout: 2_000 })
    await expect(transcript).toBeVisible()
  })

  test("@finding 25 route state settles before a visible transition", async ({ page }) => {
    await openApp(page, { liveStream: true })
    const pane = page.locator('[data-pane-id="w1H:p3"]')
    await expect(pane).not.toHaveAttribute("data-agent-row", "codex-reviewer")

    expect(await pushTopologySnapshot(page, topologyFixture([], undefined, "active"))).toBe(true)
    await page.waitForTimeout(100)
    await expect(pane).not.toHaveAttribute("data-agent-row", "codex-reviewer")

    expect(await pushTopologySnapshot(page, topologyFixture())).toBe(true)
    await page.waitForTimeout(900)
    await expect(pane).not.toHaveAttribute("data-agent-row", "codex-reviewer")

    expect(await pushTopologySnapshot(page, topologyFixture([], undefined, "active"))).toBe(true)
    await expect(pane).toHaveAttribute("data-agent-row", "codex-reviewer", { timeout: 1_500 })
  })

  test("@guard a route transition survives faster unrelated observations", async ({ page }) => {
    await openWithTopology(page, { liveStream: true })
    await page.locator('[data-quick-nav-item="agents"]').click()
    const pane = page.locator('[data-pane-id="w1H:p3"]')
    await expect(pane).toContainText("reviewer-pane")

    // p3 leaves stale here. Its settle must survive every unrelated change below.
    expect(await pushTopologySnapshot(page, topologyFixture([], undefined, "active"))).toBe(true)

    // Keep an unrelated key changing faster than the settle delay, and keep it
    // changing PAST the point where p3 must already have settled. Flapping that
    // stops before the assertion proves nothing: starvation ends with the last
    // change, so a retrying assertion simply waits it out and passes either way.
    for (let index = 0; index < 8; index += 1) {
      await page.waitForTimeout(150)
      const leadState = index % 2 === 0 ? "stale" : "active"
      expect(await pushTopologySnapshot(page, topologyFixture([], undefined, "active", leadState))).toBe(true)
    }

    // One read, taken while the unrelated key is still flapping, more than
    // ROUTE_SETTLE_DELAY_MS after p3's own change. Not a retrying assertion.
    expect(await pane.textContent(), "the transition must settle while another key flaps").toContain("codex-reviewer")
  })

  test("@guard workspace summary segments have non-overlapping client rects", async ({ page }) => {
    await openWithTopology(page)
    await page.locator('[data-quick-nav-item="workspaces"]').click()
    const row = page.locator('aside [data-workspace-id="w1H"]')
    const segments = await row.locator("a > span > span").evaluateAll((nodes) => nodes.map((node, index) => {
      const rect = node.getBoundingClientRect()
      return {
        name: index === 0 ? "label" : "summary",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    }))
    expect(segments, "the row must expose its label and summary segments").toHaveLength(2)
    expect(segments.map((segment) => segment.name), "the rect guard must target each intended row segment").toEqual(["label", "summary"])
    for (const segment of segments) {
      expect(segment.width, `${segment.name ?? "unknown"} segment must occupy layout space`).toBeGreaterThan(0)
      expect(segment.height, `${segment.name ?? "unknown"} segment must occupy layout space`).toBeGreaterThan(0)
    }
    for (let leftIndex = 0; leftIndex < segments.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < segments.length; rightIndex += 1) {
        const left = segments[leftIndex]
        const right = segments[rightIndex]
        if (left === undefined || right === undefined) continue
        const horizontalOverlap = Math.min(left.right, right.right) - Math.max(left.left, right.left)
        const verticalOverlap = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
        expect(
          horizontalOverlap > 0 && verticalOverlap > 0,
          `${left.name ?? "unknown"} and ${right.name ?? "unknown"} segments must not overlap`,
        ).toBe(false)
      }
    }
  })

  test("@guard an unlabeled workspace row displays its id", async ({ page }) => {
    await openWithTopology(page)
    await page.locator('[data-quick-nav-item="workspaces"]').click()
    const row = page.locator('aside [data-workspace-id="w1N"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText("w1N")
  })

  test("@guard sidebar status orbs animate mapped states at size 20", async ({ page }) => {
    await openWithTopology(page, { liveStream: true, topologyExtraPanes: [BLOCKED_PANE] })
    await expect.poll(() => page.evaluate(() => window.__liveStreamOpens?.("/api/events") ?? 0)).toBeGreaterThan(0)
    await page.locator('[data-quick-nav-item="agents"]').click()
    const workingPanes = page.locator('[data-pane-status="working"]')
    await expect(workingPanes).toHaveCount(2)
    const workingCanvases = workingPanes.locator('canvas[data-agent-orb][data-orb-state="working"]')
    await expect(workingCanvases).toHaveCount(2)
    const canvasSizes = await workingCanvases.evaluateAll((nodes) => nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return { height: Math.round(rect.height), width: Math.round(rect.width) }
    }))
    expect(canvasSizes, "sidebar status canvases must use the 20px preset").toEqual([{ height: 20, width: 20 }, { height: 20, width: 20 }])

    const allPanes = page.locator("[data-pane-id]")
    await expect(allPanes.locator("canvas[data-agent-orb]")).toHaveCount(await allPanes.count())
    const staticPanes = page.locator('[data-pane-status="idle"], [data-pane-status="blocked"]')
    await expect(staticPanes).toHaveCount(3)
    const staticCanvases = staticPanes.locator('canvas[data-agent-orb][data-orb-state="static"][data-orb-animating="false"]')
    await expect(staticCanvases).toHaveCount(3)
    await expect.poll(async () => {
      const samples = await readCanvasSamples(staticCanvases)
      return samples.length === 3 && samples.every((sample) => sample.nonBlankPixels > 0)
    }, { message: "every static orb must paint a non-blank paused frame" }).toBe(true)
    const staticBefore = await readCanvasSamples(staticCanvases)
    await page.waitForTimeout(350)
    expect(await readCanvasSamples(staticCanvases), "paused static orb pixels must stay identical after 350ms").toEqual(staticBefore)

    const blocked = page.locator('[data-pane-status="blocked"]')
    await expect(blocked).toHaveCount(1)
    await expect(blocked.locator('canvas[data-agent-orb][data-orb-state="static"][data-orb-alert="amber"]')).toHaveCount(1)
    await expect(blocked.locator('canvas[data-agent-orb]')).toHaveClass(/amber/)

    await expectVisibleOrbMapping(page)
    await expect.poll(async () => {
      const samples = await readCanvasSamples(workingCanvases)
      return samples.length === 2 && samples.every((sample) => sample.nonBlankPixels > 0)
    }, { message: "every working orb must paint a non-blank frame" }).toBe(true)
    const animatedSamplesBefore = await readCanvasSamples(workingCanvases)
    await page.waitForTimeout(350)
    expect(await readCanvasSamples(workingCanvases), "working orb pixels must change after 350ms").not.toEqual(animatedSamplesBefore)

    const animatedCountBefore = await page.locator('[data-pane-id] [data-orb-animating="true"]').count()
    const workingBefore = await workingPanes.count()
    expect(animatedCountBefore, "the animated count must equal mapped working rows").toBe(workingBefore)
    expect(animatedCountBefore, "animated sidebar orbs must not exceed working agents").toBeLessThanOrEqual(workingBefore)

    expect(await pushTopologySnapshot(page, topologyFixture([], "w1A:p1"))).toBe(true)
    const unmanagedWorking = page.locator('[data-pane-id="w1A:p1"]')
    await expect(unmanagedWorking).toHaveAttribute("data-pane-status", "working")
    await expect(page.locator('[data-pane-status="working"]')).toHaveCount(workingBefore + 1)
    await expect(unmanagedWorking.locator('[data-orb-state="working"][data-orb-animating="true"]')).toHaveCount(1)
    await expect.poll(() => page.locator('[data-pane-id] [data-orb-animating="true"]').count()).toBe(animatedCountBefore + 1)
  })

  test("@guard orb slots contain their canvas across control-plane rows, directory rows, and detail headers", async ({ page }) => {
    await openWithTopology(page)
    await page.locator('[data-quick-nav-item="agents"]').click()
    await expectContainedOrbSlots(page.locator("aside [data-pane-id]"), "control-plane rows")

    await page.route("**/api/agents/lead", async (route) => {
      await fulfillJson(route, {
        participant: { handle: "lead", kind: "agent", agentKind: "claude", lastSeenAt: null, routeState: "active" },
        pane: { paneId: "w1H:p1", label: "lead", agentKind: "claude", agentStatus: "working", focused: true, participant: "lead", participantRouteState: "active" },
        recentMessageIds: [],
        routeState: "active",
      })
    })
    await page.goto("/agents")
    await expect(page.locator('[data-directory="agents"]')).toBeVisible()
    const directoryRows = page.locator('[data-directory="agents"] [data-agent-row]')
    await expect(directoryRows).not.toHaveCount(0)
    await expectContainedOrbSlots(directoryRows, "directory rows")

    await page.getByRole("button", { name: "Open agent lead" }).click()
    await expect(page.locator('[data-agent-view="lead"]')).toBeVisible()
    await expectContainedOrbSlots(page.locator('[data-agent-view="lead"]'), "detail header")
  })

  test("@guard an agent recent message opens its channel with the message focused", async ({ page }) => {
    await openWithTopology(page)
    let messageListRequests = 0
    await page.route("**/api/agents/lead", async (route) => {
      await fulfillJson(route, {
        participant: { handle: "lead", kind: "agent", agentKind: "claude", lastSeenAt: null, routeState: "active" },
        pane: { paneId: "w1H:p1", label: "lead", agentKind: "claude", agentStatus: "working", focused: true, participant: "lead", participantRouteState: "active" },
        recentMessageIds: [{ channel: "ops", messageIds: [3] }],
        routeState: "active",
      })
    })
    await page.route("**/api/channels/ops/messages**", async (route) => {
      messageListRequests += 1
      await fulfillJson(route, { messages: mockMessages.filter((message) => message.channel === "ops") })
    })
    await page.route("**/api/channels/ops/context**", async (route) => {
      await fulfillJson(route, { messages: mockMessages.filter((message) => message.channel === "ops") })
    })

    await page.goto("/agents")
    await page.getByRole("button", { name: "Open agent lead" }).click()
    const recentMessage = page.locator('[data-agent-message-row="3"]')
    await expect(recentMessage).toContainText("Smoke checks passed in staging")
    expect(messageListRequests, "the detail page must load the channel containing the recent message").toBeGreaterThan(0)

    await recentMessage.click()
    await expect(page).toHaveURL(/\/channels\/ops\?messageId=3$/)
    await expect(page.locator('[data-agent-view="lead"]')).toHaveCount(0)
    await expect(page.locator('nav[aria-label="Channels"] a[aria-current="page"]')).toContainText("ops")
    await expect(page.locator('[data-message-id="1"]')).toBeVisible()
    await expect(page.locator('[data-message-id="3"]')).toHaveAttribute("tabindex", "0")
    await expect(page.locator('[data-message-id="3"]')).toContainText("Smoke checks passed in staging")
  })

  test("@finding 5.2 workspaces order by matched participants, and empty ones start collapsed", async ({ page }) => {
    await openWithTopology(page)
    const ids = await page.locator("[data-workspace-id]").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-workspace-id")))
    expect(ids[0], "the workspace with agents comes first").toBe("w1H")
    await expect(page.locator('[data-workspace-id="w1H"]')).toHaveAttribute("data-collapsed", "false")
    await expect(page.locator('[data-workspace-id="w1A"]')).toHaveAttribute("data-collapsed", "true")
  })

  test("@finding 5.2 viewing the workspace section writes nothing", async ({ page }) => {
    await openWithTopology(page)
    const writes: string[] = []
    page.on("request", (request) => {
      if (request.method() !== "GET" && request.url().includes("/api/")) {
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`)
      }
    })
    await page.locator('[data-workspace-id="w1A"]').click()
    await page.waitForTimeout(800)
    expect(writes, "expanding a workspace must not mutate anything").toEqual([])
  })

  test("@guard the workspaces directory keeps priority rows inside its eight-row cap", async ({ page }) => {
    await openWorkspacesDirectory(page, { topology: workspaceDirectoryScaleTopology() })

    const cap = page.locator('[data-directory="workspaces"] [data-workspace-card="ws-cap"]')
    await expect(cap.locator("[data-agent-row]")).toHaveCount(6)
    await expect(cap.locator('[data-agent-row="codex-reviewer"]')).toHaveCount(0)
    await expect(cap).not.toContainText("codex-reviewer")
    await expect(cap.locator('[data-agent-row="cap-focused"]')).toHaveCount(1)
    await expect(cap.locator('[data-overflow-panes="4"]')).toContainText("4 more")

    const residue = page.locator('[data-directory="workspaces"] [data-workspace-card="ws-residue"]')
    await expect(residue.locator("[data-agent-row]")).toHaveCount(6)
    await expect(residue.locator('[data-overflow-panes="4"]')).toContainText("4 more")
    await expect(residue).not.toContainText(/stale/i)
  })

  test("@guard workspace ordering is stable and empty panes aggregate on the directory", async ({ page }) => {
    await openWorkspacesDirectory(page, { topology: workspaceDirectoryScaleTopology() })
    const cards = page.locator('[data-directory="workspaces"] [data-workspace-card]')
    const ids = await cards.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-workspace-id")))
    expect(ids).toEqual([
      "ws-cap",
      "ws-six-active",
      "ws-five",
      "ws-four",
      "ws-three",
      "ws-two",
      "ws-one",
      "ws-empty",
      "ws-residue",
      "ws-six-stale",
      "ws-zero-a",
      "ws-zero-b",
      "ws-zero-c",
    ])

    const empty = page.locator('[data-directory="workspaces"] [data-workspace-card="ws-empty"]')
    await expect(empty).toContainText("Empty")
    await expect(empty).toContainText("3")
    await expect(empty.locator('[data-agent-row][data-pane-status="empty pane"]')).toHaveCount(0)
  })

  test("@guard workspace and agent rows open their detail altitudes", async ({ page }) => {
    await openWorkspacesDirectory(page, { topology: workspaceDirectoryScaleTopology() })
    await page.route("**/api/agents/cap-working-a", async (route) => {
      await fulfillJson(route, {
        participant: { handle: "cap-working-a", kind: "agent", agentKind: "codex", lastSeenAt: null, routeState: "active" },
        pane: { paneId: "cap-working-a", label: null, agentKind: "codex", agentStatus: "working", focused: false, participant: "cap-working-a", participantRouteState: "active" },
        recentMessageIds: [],
        routeState: "active",
      })
    })

    await page.locator('[data-workspace-card="ws-cap"] [data-workspace-open]').click()
    await expect(page).toHaveURL(/\/workspaces\/ws-cap$/)
    await expect(page.locator('[data-workspace-view="ws-cap"]')).toBeVisible()

    await page.goto("/workspaces")
    await page.locator('[data-workspace-card="ws-cap"] [data-agent-row="cap-working-a"] [data-agent-open]').click()
    await expect(page).toHaveURL(/\/agents\/cap-working-a$/)
    await expect(page.locator('[data-agent-view="cap-working-a"]')).toBeVisible()
  })

  test("@guard the rendered workspaces page omits retired directory furniture", async ({ page }) => {
    await openWorkspacesDirectory(page, { topology: workspaceDirectoryScaleTopology() })
    const directory = page.locator('[data-directory="workspaces"]')
    await expect(directory).toBeVisible()
    await expect(directory.locator("h2")).toHaveCount(0)
    await expect(directory.locator('[data-workspace-stats]')).toHaveCount(0)
    await expect(directory.locator('[data-workspace-tabs]')).toHaveCount(0)
    await expect(directory.getByText("Workspace control plane", { exact: true })).toHaveCount(0)
    await expect(directory.getByText("See every pane, route, and agent status.", { exact: false })).toHaveCount(0)
  })

  test("@guard the workspaces page does not present old routes as current agents", async ({ page }) => {
    await page.setViewportSize({ height: 360, width: 1280 })
    await openWorkspacesDirectory(page, { topology: workspaceDirectoryScaleTopology() })
    await expect(page.locator('[data-page-alarm^="stale-routes:"]')).toHaveCount(0)

    const pastBudget = page.locator('[data-workspace-card="ws-six-stale"]')
    await expect(pastBudget.locator('[data-workspace-open="ws-six-stale"]')).toContainText("Six stale")
    await expect(pastBudget).toContainText("6")
    await expect(pastBudget.locator('[data-workspace-segment="stale"]')).toHaveCount(0)
    await expect(pastBudget.getByRole("button", { name: "Broadcast to Six stale" })).toBeVisible()
    await expect(pastBudget.getByRole("button", { name: "Spawn agent in Six stale" })).toBeVisible()

  })

  test("@guard workspace headers keep broadcast and spawn inline while close stays in the menu", async ({ page }) => {
    await openWorkspacesDirectory(page, { topology: workspaceDirectoryScaleTopology() })
    const card = page.locator('[data-directory="workspaces"] [data-workspace-card="ws-cap"]')
    await expect(card.locator('[data-workspace-actions]').getByRole("button", { name: "Broadcast to Cap" })).toBeVisible()
    await expect(card.locator('[data-workspace-actions]').getByRole("button", { name: "Spawn agent in Cap" })).toBeVisible()
    await expect(card.getByRole("button", { name: "Close Cap", exact: true })).toHaveCount(0)
    await card.getByRole("button", { name: "More actions for Cap", exact: true }).click()
    await expect(card.locator('[data-workspace-menu] [data-menu-item="close-workspace"]')).toBeVisible()
  })

  test("@guard workspace headers and agent rows stay compact", async ({ page }) => {
    await openWorkspacesDirectory(page, { topology: workspaceDirectoryScaleTopology() })
    const card = page.locator('[data-directory="workspaces"] [data-workspace-card="ws-cap"]')
    const headerHeight = await card.locator("[data-workspace-header]").evaluate((node) => node.getBoundingClientRect().height)
    expect(headerHeight).toBeLessThanOrEqual(64)
    const rowHeights = await card.locator("[data-agent-row]").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height))
    expect(rowHeights).toEqual(Array.from({ length: 6 }, () => 36))
  })

  test("@finding 22 search results never print a channel storage name", async ({ page }) => {
    await page.route("**/api/search**", async (route) => {
      await fulfillJson(route, {
        results: [
          { attachmentCount: 0, messageId: 9101, channel: "dm-725e0a4e783821d4", sender: "lead", snippet: "the handoff is ready", createdAt: "2026-08-17T15:00:00.000Z" },
          { attachmentCount: 0, messageId: 9102, channel: "ws-3f2a9b8c1d4e5f60718293a4b5c6d7e8", sender: "lead", snippet: "workspace broadcast", createdAt: "2026-08-17T15:01:00.000Z" },
          { attachmentCount: 0, messageId: 9103, channel: "dev", sender: "lead", snippet: "a normal channel", createdAt: "2026-08-17T15:02:00.000Z" },
        ],
        truncated: false,
      })
    })
    await openApp(page)
    await page.fill("#message-search", "handoff")
    await page.press("#message-search", "Enter")
    await expect(page.locator('ol[aria-label="Search results"]')).toBeVisible()
    const text = await page.locator('ol[aria-label="Search results"]').innerText()
    expect(text, "a dm- storage name is not a place an operator can recognise")
      .not.toMatch(/dm-[0-9a-f]{8}/)
    expect(text, "a ws- storage name is not a place an operator can recognise")
      .not.toMatch(/ws-[0-9a-f]{8}/)
    expect(text, "the readable channel still names itself").toContain("dev")
  })

  test("@guard a search result navigates to its message with neighbouring context", async ({ page }) => {
    let historyRequests = 0
    await openApp(page)
    await page.route("**/api/search**", async (route) => {
      await fulfillJson(route, {
        results: [
          { attachmentCount: 0, messageId: 6, channel: "research", sender: "reviewer-2", snippet: "The result snippet should link to context", createdAt: "2026-08-16T15:02:00.000Z" },
        ],
        truncated: false,
      })
    })
    await page.route("**/api/channels/research/context**", async (route) => {
      const url = new URL(route.request().url())
      expect(url.searchParams.get("around"), "the destination must request the result message").toBe("6")
      await fulfillJson(route, {
        messages: mockMessages.filter((message) => [5, 6, 7].includes(message.id)),
      })
    })
    await page.route("**/api/channels/research/messages**", async (route) => {
      historyRequests += 1
      await fulfillJson(route, { messages: [] })
    })

    await page.fill("#message-search", "context")
    await page.press("#message-search", "Enter")
    await expect(page.locator('ol[aria-label="Search results"]')).toBeVisible()
    await page.locator('ol[aria-label="Search results"] button').first().click()

    await expect(page).toHaveURL(/\/channels\/research\?messageId=6$/)
    expect(historyRequests, "a message-target route must use context as its only initial load").toBe(0)
    await expect(page.locator('ol[aria-label="Search results"]')).toHaveCount(0)
    await expect(page.locator('[data-message-id="5"]')).toBeVisible()
    await expect(page.locator('[data-message-id="6"]')).toHaveAttribute("tabindex", "0")
    await expect(page.locator('[data-message-id="7"]')).toBeVisible()
  })

  test("@guard search reports ignored terms in the result header", async ({ page }) => {
    const queries: string[] = []
    await page.route("**/api/search**", async (route) => {
      const url = new URL(route.request().url())
      queries.push(url.searchParams.get("q") ?? "")
      await fulfillJson(route, { results: [], truncated: false })
    })
    await openApp(page)
    await page.fill("#message-search", "one two three four five six seven eight nine ten")
    await page.press("#message-search", "Enter")
    await expect(page.locator("[data-search-cap-notice]")).toHaveText("Searched the first 8 words. 2 more were ignored.")
    expect(queries, "the API request must use the same eight terms shown in the notice").toEqual([
      "one two three four five six seven eight",
    ])
  })

  test("@finding 23 with no channel to send to, the composer does not offer a send", async ({ page }) => {
    await installApiMocks(page)
    await page.route("**/api/channels", async (route) => { await fulfillJson(route, { channels: [] }) })
    await page.addInitScript(() => {
      window.localStorage.setItem("msgr.identity.v1", JSON.stringify({ version: 1, hub: window.location.origin, handle: "operator" }))
    })
    await page.goto("/")
    await expect(page.locator("main section")).toContainText(/no channels/i)
    const send = page.locator("main form button").filter({ hasText: "Send" })
    await expect(send, "a send with nowhere to send is a control that cannot work").toBeDisabled()
    await expect(page.locator("main section"), "the empty state offers the action that resolves it")
      .toContainText(/create a channel/i)
  })

  test("@guard a deleted preview states the fact without a resend instruction", async ({ page }) => {
    await openApp(page, { previewStatus: 404 })
    const failed = page.locator('[data-slot="attachment"]').filter({ hasText: "rollout.png" })
    const neverPreviewable = page.locator('[data-slot="attachment"]').filter({ hasText: "runbook.pdf" })
    await expect(failed).toBeVisible()
    await expect(neverPreviewable).toBeVisible()
    await expect(failed).toContainText("This file is no longer available.")
    const failedText = await failed.innerText()
    const factText = await neverPreviewable.innerText()
    expect(
      failedText.replace(/rollout\.png/g, ""),
      "a failure and a plain fact must not render identically",
    ).not.toBe(factText.replace(/runbook\.pdf/g, ""))
    expect(failedText).not.toMatch(/ask the sender|send it again|changed after it was sent|preview is pinned/i)
  })

  test("@finding 20 the sidebar stays usable at twenty channels", async ({ page }) => {
    await openApp(page, { extraChannels: 16, waitForMessages: false })
    await expect.poll(
      () => page.locator('nav[aria-label="Channels"]').innerText(),
      { message: "the settled channel rows must expose activity" },
    ).toMatch(/\b\d+[smhd]\b/)
    const usable = await page.evaluate(() => ({
      hasFilter: document.querySelector("aside input") !== null,
      hasActivity: /\b\d+[smhd]\b/.test(document.querySelector<HTMLElement>('nav[aria-label="Channels"]')?.innerText ?? ""),
    }))
    expect(usable.hasFilter || usable.hasActivity).toBe(true)
  })

  test("@guard the composer returns to one row the moment a message is sent", async ({ page }) => {
    await openApp(page)
    await page.locator('nav[aria-label="Channels"]').getByRole("link", { name: /^ops\b/ }).click()
    await expect(page.getByRole("heading", { name: "ops", exact: true })).toBeVisible()
    await page.route("**/api/channels/ops/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback()
        return
      }
      const request = v.parse(sendMessageRequestSchema, JSON.parse(route.request().postData() ?? "{}"))
      await fulfillJson(route, {
        attachments: [],
        body: request.body,
        channel: "ops",
        createdAt: "2026-08-19T08:00:00.000Z",
        id: 40,
        sender: "operator",
        senderAgentKind: null,
        senderKind: "human",
      })
    })

    const composer = page.locator("#message-composer")
    await composer.click()
    // The committed target height, not the painted one: the shrink is animated, so
    // a rectangle read right after the send would report a frame of the animation
    // rather than the height the clear computed.
    const oneRow = await composer.evaluate((node: HTMLTextAreaElement) => node.style.height)
    const oneRowRect = await composer.evaluate((node: HTMLTextAreaElement) => node.getBoundingClientRect().height)

    await composer.fill("a draft that runs\nacross several\nlines so the box\nactually grows\nbefore the send")
    const grown = await composer.evaluate((node: HTMLTextAreaElement) => node.style.height)
    expect(
      Number.parseFloat(grown),
      "the draft must grow the box, or the reset below asserts nothing",
    ).toBeGreaterThan(Number.parseFloat(oneRow))

    await composer.press("Enter")
    await expect(composer, "the send must clear the draft before the height is read").toHaveValue("")

    // Read once, at this instant. A retrying matcher would wait out the defect,
    // where the box holds its old height until later keystrokes shrink it.
    const afterSend = await composer.evaluate((node: HTMLTextAreaElement) => node.style.height)
    expect(afterSend, "clearing the draft must recompute the height, not leave the old one").toBe(oneRow)

    await expect
      .poll(() => composer.evaluate((node: HTMLTextAreaElement) => node.getBoundingClientRect().height), {
        message: "the animated shrink must land on the one-row height",
      })
      .toBe(oneRowRect)
  })
})

/**
 * The shared fixture covers unread, read, and missing-topic channel rows.
 */
async function openChannelsDirectory(page: Page, options: MockOptions = {}): Promise<void> {
  await openWithTopology(page, options)
  await page.goto("/channels")
  await expect(page.locator('[data-directory="channels"]')).toBeVisible()
  await expect(page.locator('[data-directory="channels"] [data-channel-row="ops"]')).toBeVisible()
}

function channelRowOrder(page: Page): Promise<Array<string | null>> {
  return page.locator('[data-directory="channels"] [data-channel-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-channel-row")))
}

test.describe("channels directory", () => {
  test("@guard the unread badge and the activity stamp are exclusive", async ({ page }) => {
    await openChannelsDirectory(page)
    // Both states in one fixture: a build that renders both satisfies any check that
    // looks for either, and gives the operator two answers to one question.
    const unreadRow = page.locator('[data-directory="channels"] [data-channel-row="ops"]')
    const quietRow = page.locator('[data-directory="channels"] [data-channel-row="research"]')
    await expect(unreadRow.locator("[data-channel-unread]")).toHaveCount(1)
    await expect(unreadRow.locator("[data-channel-activity]")).toHaveCount(0)
    await expect(quietRow.locator("[data-channel-activity]")).toHaveCount(1)
    await expect(quietRow.locator("[data-channel-unread]")).toHaveCount(0)
  })

  test("@guard the deleted row facts are gone from a directory proven alive", async ({ page }) => {
    await openChannelsDirectory(page)
    // Anchor first: an empty directory deletes all four perfectly.
    await expect(page.locator('[data-directory="channels"] [data-channel-row="ops"]')).toContainText("ops")
    await expect(page.locator('[data-directory="channels"] [data-channel-row="ops"]')).toContainText("4 members")
    const directory = await page.locator('[data-directory="channels"]').innerText()
    expect(directory, "a message count changes no action").not.toMatch(/\d+ messages?\b/)
    expect(directory, "the viewer's state is not the channel's").not.toMatch(/read only/i)
    expect(directory, "the disabled button carries that state, not a word").not.toMatch(/checking membership/i)
    expect(directory, "absence needs no label").not.toMatch(/no topic/i)
  })

  test("@guard an unset topic renders nothing in the topic position", async ({ page }) => {
    await openChannelsDirectory(page)
    // handoff is the topic-less channel; without one in the fixture this asserts nothing.
    const topicless = page.locator('[data-directory="channels"] [data-channel-row="handoff"]')
    await expect(topicless).toContainText("handoff")
    const remainder = (await topicless.innerText())
      .replace(/handoff|\d+ members?|\d+ unread|Active[^\n]*|Join|Leave/g, "")
      .trim()
    expect(remainder, "no placeholder, no em dash, nothing").toBe("")
  })

  test("@guard the failed-identify fallback renders once at page level", async ({ page }) => {
    await openChannelsDirectory(page, { anonymous: true })
    const body = await page.locator('[data-page-content="channels"]').innerText()
    const renderings = body.split("Not connected to the hub.").length - 1
    expect(renderings, "one fact renders once, never once per row").toBe(1)
    expect(body, "3b deletes every identity-choice surface").not.toMatch(/choose (a|an|your) (name|identity)|pick a name|send as\b/i)
  })

  test("@guard rows follow the ordering law on a deliberately unsorted fixture", async ({ page }) => {
    await openChannelsDirectory(page)
    await expect.poll(
      () => channelRowOrder(page),
      { message: "unread descending, then activity, then name" },
    ).toEqual(["ops", "handoff", "research"])
  })

  test("@guard a live unread change moves the badge without moving the row", async ({ page }) => {
    // planner is not a member of research, so the row offers Join — and joining is a
    // real product action that refreshes the inbox underneath the open page.
    await openChannelsDirectory(page, { identityHandle: "planner", nonMemberChannel: "research" })
    await expect.poll(() => channelRowOrder(page)).toEqual(["ops", "handoff", "research"])

    // research sits last with no unread; an applied re-sort would lift it to the top.
    await page.route("**/api/inbox", async (route) => {
      await route.fulfill({
        body: JSON.stringify({ entries: [{ channel: "research", unread: 9, senders: ["runner"], routeState: "active", pushEnabled: false }] }),
        contentType: "application/json",
        status: 200,
      })
    })
    await page.locator('[data-directory="channels"] [data-channel-row="research"] [data-channel-membership]').click()

    await expect(page.locator('[data-directory="channels"] [data-channel-row="research"] [data-channel-unread]')).toHaveText("9 unread")
    expect(await channelRowOrder(page), "rows re-sort on open only").toEqual(["ops", "handoff", "research"])
  })

  test("@guard channel search and membership filters use the URL", async ({ page }) => {
    await openChannelsDirectory(page)
    const search = page.locator("#channel-directory-search")
    await search.fill("research")
    await expect(page).toHaveURL(/\/channels\?q=research$/)
    await expect(page.locator('[data-directory="channels"] [data-channel-row]')).toHaveCount(1)
    await expect(page.locator('[data-directory="channels"] [data-channel-row="research"]')).toBeVisible()

    await page.locator("[data-channel-membership-filter]").getByRole("button", { name: "Joined" }).click()
    await expect(page).toHaveURL(/\/channels\?q=research&membership=joined$/)
    await page.getByRole("button", { name: "Clear channel search" }).click()
    await page.locator("[data-channel-membership-filter]").getByRole("button", { name: "All" }).click()
    await expect(page).toHaveURL(/\/channels$/)
  })

  test("@guard channel management is visible from the directory", async ({ page }) => {
    await openChannelsDirectory(page)
    const row = page.locator('[data-directory="channels"] [data-channel-row="ops"]')
    await row.getByRole("button", { name: "View members of ops" }).click()
    await expect(page.locator('[data-dialog="members"]')).toBeVisible()
    await expect(page.locator('[data-dialog="members"] [data-member-handle="old-runner"]')).toContainText("No Herdr Pane")
    await expect(page.locator('[data-dialog="members"]')).not.toContainText(/\bstale\b/i)
    await page.getByRole("button", { name: "Close channel members" }).click()

    await row.getByRole("button", { name: "Delete ops" }).click()
    await expect(page.getByRole("dialog", { name: "Delete channel" })).toBeVisible()
  })

  test("@guard membership renders both directions on one fixture", async ({ page }) => {
    await openChannelsDirectory(page, { identityHandle: "planner", nonMemberChannel: "handoff" })
    // A build that always renders Join passes a one-direction assertion.
    await expect(page.locator('[data-directory="channels"] [data-channel-row="ops"] [data-channel-membership]')).toHaveAttribute("data-channel-membership", "leave")
    await expect(page.locator('[data-directory="channels"] [data-channel-row="handoff"] [data-channel-membership]')).toHaveAttribute("data-channel-membership", "join")
  })

  test("@guard opening a channel is a navigation, not a state change", async ({ page }) => {
    await openChannelsDirectory(page)
    await page.locator('[data-directory="channels"] [data-channel-row="ops"] [data-channel-open]').click()
    await expect(page).toHaveURL(/\/channels\/ops$/)
    // The directory is GONE rather than covered, and the destination renders its subject.
    await expect(page.locator('[data-directory="channels"]')).toHaveCount(0)
    await expect(page.locator('[data-shell-page="current"]')).toBeVisible()

    await page.getByRole("link", { name: "Back to Channels" }).click()
    await expect(page).toHaveURL(/\/channels$/)
    await expect(page.locator('[data-directory="channels"] [data-channel-row="ops"]')).toBeVisible()
  })

  test("@guard agent detail keeps identity facts, agent activity, memberships, and tab focus distinct", async ({ page }) => {
    const mainPane: JsonObject = {
      agentKind: "codex",
      agentStatus: "idle",
      focused: false,
      label: "main-pane",
      paneId: "w1H:pMain",
      participant: null,
      participantRouteState: null,
    }
    const agentPane: JsonObject = {
      agentKind: "claude",
      agentStatus: "working",
      focused: false,
      label: "lead-pane",
      paneId: "w1H:p1",
      participant: "lead",
      participantRouteState: "active",
      title: "verify item 7 gate",
    }
    const topology: JsonValue = {
      workspaces: [{
        id: "w1H",
        label: "Personal-Projects",
        panes: [mainPane, agentPane],
        tabs: [
          { id: "w1H:tab-main", label: "Main", panes: [mainPane] },
          { id: "w1H:tab-agent", label: "Agent", panes: [agentPane] },
        ],
      }],
    }
    const directChannel = "dm-abc123def456"
    const messageTemplate = mockMessages.find((message) => message.channel === "ops")
    if (messageTemplate === undefined) throw new Error("fixtures lost an ops message")
    const directMessage: Message = {
      ...messageTemplate,
      id: 401,
      channel: directChannel,
      sender: "lead",
      body: "The embedded detail thread is readable.",
      createdAt: new Date(Date.now() - 90_000).toISOString(),
    }
    let focusMethod = ""
    let focusPath = ""

    await openWithTopology(page, { topology, withDirect: true })
    await page.route("**/api/direct", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback()
        return
      }
      await fulfillJson(route, {
        conversations: [{ channel: directChannel, lastMessageAt: new Date(Date.now() - 90_000).toISOString(), participants: ["lead"], unread: 0 }],
      })
    })
    await page.route(`**/api/channels/${encodeURIComponent(directChannel)}/messages`, async (route) => {
      await fulfillJson(route, { messages: [directMessage] })
    })
    await page.route("**/api/agents/lead", async (route) => {
      await fulfillJson(route, {
        channels: [{ channel: "ops", unread: 37 }, { channel: "handoff", unread: 1 }],
        pane: agentPane,
        participant: { agentKind: "claude", handle: "lead", kind: "agent", lastSeenAt: new Date(Date.now() - 3_600_000).toISOString(), routeState: "active" },
        recentMessageIds: [{ channel: "ops", messageIds: [3] }],
        routeState: "active",
      })
    })
    await page.route("**/api/herdr/tabs/**/focus", async (route) => {
      focusMethod = route.request().method()
      focusPath = new URL(route.request().url()).pathname
      await fulfillJson(route, { tabId: "w1H:tab-agent" })
    })
    await page.reload()
    await expect(page.locator('nav[aria-label="Channels"] button').first()).toBeVisible()
    await page.goto("/agents/lead")

    const detail = page.locator('[data-agent-view="lead"]')
    await expect(detail).toBeVisible()
    await expect(detail.locator("[data-agent-identity] > h2")).toHaveText("lead")
    await expect(detail.locator("[data-agent-identity-facts]").getByText("claude", { exact: true })).toHaveCount(1)
    await expect(detail.locator("[data-agent-identity-facts]").getByText("Herdr: working", { exact: true })).toHaveCount(1)
    await expect(detail.locator("[data-agent-identity-facts]").getByText("Personal-Projects", { exact: true })).toHaveCount(1)
    await expect(detail.locator("[data-agent-identity-facts]").getByText("pane w1H:p1", { exact: true })).toHaveCount(1)
    await expect(detail.locator("[data-agent-identity-facts]").getByText("Chat route active", { exact: true })).toHaveCount(1)
    await expect(detail.locator("[data-agent-identity-facts]").getByText("seen 1h ago", { exact: true })).toHaveCount(1)
    await expect(detail.locator("[data-agent-identity-facts]")).toHaveCount(1)
    await expect(detail.locator("[data-pane-title]")).toHaveAttribute("data-pane-title", "verify item 7 gate")
    await expect(detail.locator(`[data-agent-conversation="${directChannel}"]`)).toContainText("The embedded detail thread is readable.")
    await expect(detail.locator('[data-agent-channel="ops"] [data-agent-unread="37"]')).toHaveText("37 unread")
    await expect(detail.locator('[data-agent-activity="3"]')).toContainText("Smoke checks passed in staging")
    await expect(detail.getByText("Agent details", { exact: true })).toHaveCount(0)
    await expect(detail.getByRole("button", { name: "Message", exact: true })).toHaveCount(0)

    await detail.getByRole("button", { name: "Focus pane", exact: true }).click()
    await expect.poll(() => focusPath).not.toBe("")
    expect(focusMethod).toBe("POST")
    expect(decodeURIComponent(focusPath)).toBe("/api/herdr/tabs/w1H:tab-agent/focus")
  })

  test("@guard agent detail falls back to the pane label when no terminal title is reported", async ({ page }) => {
    await openWithTopology(page)
    await page.route("**/api/agents/codex-reviewer", async (route) => {
      await fulfillJson(route, {
        participant: { handle: "codex-reviewer", kind: "agent", agentKind: "codex", lastSeenAt: null, routeState: "active" },
        pane: { paneId: "w1H:p3", label: "reviewer-pane", agentKind: "codex", agentStatus: "working", focused: false, participant: "codex-reviewer", participantRouteState: "active" },
        recentMessageIds: [],
        routeState: "active",
      })
    })
    await page.goto("/agents/codex-reviewer")
    const detail = page.locator('[data-agent-view="codex-reviewer"]')
    await expect(detail).toBeVisible()
    await expect(detail.locator("[data-pane-title]")).toHaveAttribute("data-pane-title", "reviewer-pane")
    await expect(detail.locator("[data-pane-title]")).not.toContainText("No terminal title reported")
  })

  /**
   * Prompt and Message are the confusable pair on this page: one types into a
   * terminal, the other arrives as unread. Each guard counts the OTHER path at
   * zero, so a build that wires both controls to one endpoint fails whichever
   * way it was wired.
   */
  async function openAgentDetailForActions(page: Page): Promise<{ messagePosts: string[]; promptPosts: string[] }> {
    const agentPane: JsonObject = {
      agentKind: "claude",
      agentStatus: "working",
      focused: false,
      label: "lead-pane",
      paneId: "w1H:p1",
      participant: "lead",
      participantRouteState: "active",
      title: "verify item 7 gate",
    }
    const topology: JsonValue = {
      workspaces: [{
        id: "w1H",
        label: "Personal-Projects",
        panes: [agentPane],
        tabs: [{ id: "w1H:tab-agent", label: "Agent", panes: [agentPane] }],
      }],
    }
    const directChannel = "dm-abc123def456"
    const messageTemplate = mockMessages.find((message) => message.channel === "ops")
    if (messageTemplate === undefined) throw new Error("fixtures lost an ops message")
    const directMessage: Message = {
      ...messageTemplate,
      id: 401,
      channel: directChannel,
      sender: "lead",
      body: "The embedded detail thread is readable.",
    }
    const messagePosts: string[] = []
    const promptPosts: string[] = []

    await openWithTopology(page, { topology, withDirect: true })
    await page.route("**/api/direct", async (route) => {
      if (route.request().method() !== "GET") {
        await route.fallback()
        return
      }
      await fulfillJson(route, { conversations: [{ channel: directChannel, lastMessageAt: null, participants: ["lead"], unread: 0 }] })
    })
    await page.route(`**/api/channels/${encodeURIComponent(directChannel)}/messages`, async (route) => {
      if (route.request().method() === "POST") {
        messagePosts.push(route.request().postData() ?? "")
        await fulfillJson(route, { ...directMessage, id: 402, body: "typed into the thread", sender: "human" })
        return
      }
      await fulfillJson(route, { messages: [directMessage] })
    })
    await page.route("**/api/herdr/agents/*/prompt", async (route) => {
      promptPosts.push(route.request().postData() ?? "")
      await fulfillJson(route, { delivered: true })
    })
    await page.route("**/api/agents/lead", async (route) => {
      await fulfillJson(route, {
        channels: [{ channel: "ops", unread: 37 }],
        pane: agentPane,
        participant: { agentKind: "claude", handle: "lead", kind: "agent", lastSeenAt: null, routeState: "active" },
        recentMessageIds: [],
        routeState: "active",
      })
    })
    await page.goto("/agents/lead")
    await expect(page.locator('[data-agent-view="lead"]')).toBeVisible()
    return { messagePosts, promptPosts }
  }

  test("@guard sending a message from agent detail never types into the pane", async ({ page }) => {
    const { messagePosts, promptPosts } = await openAgentDetailForActions(page)

    const composer = page.locator("#agent-composer")
    await expect(composer, "the embedded composer must render, or the counts below prove nothing").toBeVisible()
    await composer.fill("read the checklist before the gate")
    await page.getByRole("button", { name: "Send", exact: true }).click()

    await expect.poll(() => messagePosts.length, { message: "the message must reach the messages endpoint" }).toBe(1)
    expect(JSON.parse(messagePosts[0] ?? "{}")).toMatchObject({ body: "read the checklist before the gate" })
    expect(promptPosts, "a message must never reach the pane-prompt endpoint").toHaveLength(0)
  })

  test("@guard prompting the pane from agent detail never sends a message", async ({ page }) => {
    const { messagePosts, promptPosts } = await openAgentDetailForActions(page)
    const messagesBefore = messagePosts.length

    await page.getByRole("button", { name: "Prompt pane" }).click()
    const notice = page.locator("[data-agent-prompt-notice]")
    await expect(notice, "the panel must state the difference before the operator acts").toHaveText(
      "Types directly into pane w1H:p1. The agent sees it as terminal input, not as a message.",
    )
    await page.locator("#agent-prompt-input").fill("git status")
    await page.getByRole("button", { name: "Send to pane" }).click()

    await expect.poll(() => promptPosts.length, { message: "the prompt must reach the pane endpoint" }).toBe(1)
    expect(JSON.parse(promptPosts[0] ?? "{}")).toEqual({ text: "git status" })
    expect(messagePosts.length - messagesBefore, "a prompt must never post a message").toBe(0)
  })

  /**
   * The focus action is one binding over two composers. Both directions are
   * asserted: a target that resolves to the page composer everywhere is the same
   * defect as one that never resolves to it.
   */
  test("@guard c focuses the embedded composer on agent detail", async ({ page }) => {
    await openAgentDetailForActions(page)

    const embedded = page.locator("#agent-composer")
    await expect(embedded, "the embedded composer must render, or the focus below proves nothing").toBeVisible()
    await expect(page.locator("#message-composer"), "a shell page does not mount the transcript composer").toHaveCount(0)

    await page.keyboard.press("c")
    await expect(embedded).toBeFocused()
  })

  test("@guard c still focuses the transcript composer on a channel", async ({ page }) => {
    await openWithTopology(page)
    await page.goto("/")

    const transcript = page.locator("#message-composer")
    await expect(transcript, "the transcript composer must render, or the focus below proves nothing").toBeVisible()
    await expect(page.locator("#agent-composer"), "a channel does not mount the page composer").toHaveCount(0)

    await page.keyboard.press("c")
    await expect(transcript).toBeFocused()
  })
})

test.describe("staffing", () => {
  test("@guard staffing open role rows contain summaries and no private briefings", async ({ page }) => {
    const roles = [
      { agentKind: "claude", effort: "high", launcher: "claude-personal", model: "opus", name: "lead", summary: "Coordinates the workspace." },
      { agentKind: null, effort: null, launcher: null, model: null, name: "native", summary: "Uses the native binding." },
    ]
    await openWithTopology(page, {
      lifecycle: {
        roleDetails: {
          lead: { ...roles[0], briefing: "PRIVATE LEAD BRIEFING" },
          native: { ...roles[1], briefing: "PRIVATE NATIVE BRIEFING" },
        },
        roles,
      },
      waitForMessages: false,
    })
    await page.goto("/staffing")
    await expect(page.locator('[data-shell-page="staffing"]')).toBeVisible()
    await expect(page.locator('[data-role-row="lead"]')).toContainText("Coordinates the workspace.")
    await expect(page.locator('[data-role-row="native"]')).toContainText("Uses the native binding.")
    await expect(page.locator('[data-role-row="lead"] [data-role-chip]')).toHaveCount(4)
    await expect(page.locator('[data-role-row="native"] [data-role-chip]')).toHaveCount(0)
    const openText = await page.locator('[data-staffing-roles]').innerText()
    expect(openText).not.toContain("PRIVATE LEAD BRIEFING")
    expect(openText).not.toContain("PRIVATE NATIVE BRIEFING")
    expect(openText).not.toContain("null")
  })

  test("@guard role runtime defaults use registered catalogues and preserve a neutral request", async ({ page }) => {
    const roleBodies: JsonObject[] = []
    const launchers = [
      { agentKind: "claude", argv: ["claude"], name: "claude-main" },
      { agentKind: "codex", argv: ["codex"], name: "codex-main" },
      { agentKind: "codex", argv: ["codex", "--work"], name: "codex-work" },
    ]
    const modelCatalogue: ModelCatalogueSnapshot = {
      catalogues: [
        { checkedAt: null, executableAvailable: true, fetchedAt: null, freshUntil: null, launcher: "claude-main", harness: "claude", error: null, revision: 1, models: [{ default: true, description: "Claude device model.", efforts: [{ default: true, description: "Balanced.", name: "medium" }], label: "Claude model", name: "sonnet", resolvedModel: null }], status: "ready" },
        { checkedAt: null, executableAvailable: true, fetchedAt: null, freshUntil: null, launcher: "codex-work", harness: "codex", error: null, revision: 1, models: [{ default: true, description: "Codex device model.", efforts: [{ default: true, description: "Fast.", name: "low" }, { default: false, description: "Balanced.", name: "medium" }], label: "Codex model", name: "gpt-5", resolvedModel: null }], status: "ready" },
      ],
    }
    await openWithTopology(page, { lifecycle: { launchers, modelCatalogue, roles: [] }, waitForMessages: false })
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/herdr/roles" && request.method() === "POST") roleBodies.push(parseJsonObject(request.postData() ?? "{}"))
    })

    await page.goto("/staffing/roles/new")
    await expect(page.locator('[data-role-runtime]')).toBeVisible()
    await expect(page.locator('[data-role-runtime] input:not([id$="-hidden-input"]):not([data-combobox-input])')).toHaveCount(0)
    await expect(page.locator('[data-role-runtime] select')).toHaveCount(0)
    await page.locator("#role-name").fill("neutral")
    await page.locator("#role-summary").fill("Neutral runtime")
    await page.locator("#role-briefing").fill("Neutral briefing")
    await page.locator('[data-shell-page-form="create-role"] button[type="submit"]').click()
    await expect.poll(() => roleBodies.length).toBe(1)
    expect(roleBodies[0]).toMatchObject({ agentKind: null, effort: null, launcher: null, model: null })

    await page.goto("/staffing/roles/new")
    await chooseComboboxOption(page, "role-agent-kind", "codex")
    await chooseComboboxOption(page, "role-launcher", "codex-work")
    await page.locator("#role-model").click()
    await expect(page.locator('[data-combobox-option="gpt-5"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="custom-model"]')).toHaveCount(0)
    await page.locator('[data-combobox-option="gpt-5"]').click()
    await page.locator("#role-effort").click()
    await expect(page.locator('[data-combobox-option="low"]')).toBeVisible()
    await expect(page.locator('[data-combobox-option="custom-effort"]')).toHaveCount(0)
    await page.locator('[data-combobox-option="low"]').click()
    await chooseComboboxOption(page, "role-agent-kind", "claude")
    await expect(page.locator('[data-combobox="role-launcher"] [data-combobox-value]')).toHaveCount(0)
    await expect(page.locator('[data-combobox="role-model"] [data-combobox-value]')).toHaveCount(0)
    await expect(page.locator('[data-combobox="role-effort"] [data-combobox-value]')).toHaveCount(0)
  })

  test("@guard stale role runtime values block save and auto-refresh the selected launcher catalogue", async ({ page }) => {
    const refreshBodies: JsonObject[] = []
    const roles = [{ agentKind: "codex", effort: "old-effort", launcher: "codex-main", model: "old-model", name: "stale", summary: "Stale runtime" }]
    await openWithTopology(page, {
      lifecycle: {
        launchers: [{ agentKind: "codex", argv: ["codex"], name: "codex-main" }],
        modelCatalogue: { catalogues: [{ checkedAt: null, executableAvailable: true, fetchedAt: null, freshUntil: null, launcher: "codex-main", harness: "codex", error: "The launcher catalogue is stale.", revision: 1, models: [{ default: true, description: "Current model.", efforts: [{ default: true, description: "Current effort.", name: "medium" }], label: "Current", name: "gpt-5", resolvedModel: null }], status: "stale" }] },
        modelCatalogueRefresh: { catalogues: [{ checkedAt: null, executableAvailable: true, fetchedAt: null, freshUntil: null, launcher: "codex-main", harness: "codex", error: null, revision: 2, models: [{ default: true, description: "Current model.", efforts: [{ default: true, description: "Current effort.", name: "medium" }], label: "Current", name: "gpt-5", resolvedModel: null }], status: "ready" }] },
        roleDetails: { stale: { ...roles[0], briefing: "Stale briefing" } },
        roles,
      },
      waitForMessages: false,
    })
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/herdr/model-catalogue" && request.method() === "POST") refreshBodies.push(parseJsonObject(request.postData() ?? "{}"))
    })
    await page.goto("/staffing/roles/stale/edit")
    await expect(page.locator('[data-role-runtime-stale="model"]')).toBeVisible()
    await expect(page.locator('[data-role-runtime-stale="effort"]')).toBeVisible()
    await expect(page.locator('[data-shell-page-form="edit-role"] button[type="submit"]')).toBeDisabled()
    await expect.poll(() => refreshBodies.length).toBe(1)
    expect(refreshBodies[0]).toEqual({ launcher: "codex-main" })
  })

  test("@guard role-first spawn fills editable defaults, binds launcher kind, and sends names without argv", async ({ page }) => {
    const spawnBodies: JsonObject[] = []
    const roles = [
      { agentKind: "claude", effort: "high", launcher: "claude-personal", model: "opus", name: "lead", summary: "Coordinates the workspace." },
      { agentKind: "codex", effort: "low", launcher: "codex-work", model: "sol", name: "reviewer", summary: "Reviews changes." },
    ]
    await openWithTopology(page, {
      lifecycle: {
        launchers: [
          { agentKind: "claude", argv: ["claude", "--profile", "personal"], name: "claude-personal" },
          { agentKind: "codex", argv: ["codex"], name: "codex-work" },
        ],
        modelCatalogue: {
          catalogues: [
            { launcher: "claude-personal", harness: "claude", status: "ready", error: null, revision: 1, models: [{ default: true, description: "Opus model.", efforts: [{ default: false, description: "Balanced execution.", name: "medium" }, { default: true, description: "More planning.", name: "high" }], label: "Opus", name: "opus", resolvedModel: null }], executableAvailable: true, checkedAt: null, fetchedAt: null, freshUntil: null },
            { launcher: "codex-work", harness: "codex", status: "ready", error: null, revision: 1, models: [{ default: true, description: "Sol model.", efforts: [{ default: true, description: "Fast execution.", name: "low" }], label: "Sol", name: "sol", resolvedModel: null }], executableAvailable: true, checkedAt: null, fetchedAt: null, freshUntil: null },
          ],
        },
        roleDetails: { lead: { ...roles[0], briefing: "Lead briefing." }, reviewer: { ...roles[1], briefing: "Review briefing." } },
        roles,
        spawn: { handle: "lead-2", paneId: "w1H:pF" },
      },
      waitForMessages: false,
    })
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/herdr/agents" && request.method() === "POST") spawnBodies.push(parseJsonObject(request.postData() ?? "{}"))
    })
    await page.goto("/agents/new")
    await expect(page.locator('[data-shell-page="spawn-agent"]')).toBeVisible()
    await chooseComboboxOption(page, "spawn-agent-role", "lead")
    await expect(page.locator('[data-combobox="spawn-agent-launcher"] [data-combobox-value]')).toContainText("claude-personal")
    await expect(page.locator('[data-combobox="spawn-agent-model"] [data-combobox-value]')).toContainText("Opus")
    await expect(page.locator('[data-combobox="spawn-agent-effort"] [data-combobox-value]')).toContainText("high")
    await expect(page.locator('[data-combobox-option="codex-work"]')).toHaveCount(0)
    await page.locator("#spawn-agent-handle").fill("lead")
    await page.locator('[data-shell-page-form="spawn-agent"]').getByRole("button", { name: "Spawn agent", exact: true }).click()
    await expect.poll(() => spawnBodies.length).toBe(1)
    expect(spawnBodies[0]).toEqual({ effort: "high", handle: "lead", launcher: "claude-personal", model: "opus", role: "lead", workspaceId: "w1A" })
    expect(spawnBodies[0]).not.toHaveProperty("argv")
    expect(spawnBodies[0]).not.toHaveProperty("argvSuffix")
  })

  test("@guard goal is conditional on a role briefing and is carried in the spawn request", async ({ page }) => {
    const spawnBodies: JsonObject[] = []
    const roles = [
      { agentKind: "claude", effort: "medium", launcher: "claude-personal", model: "sonnet", name: "briefed", summary: "Has a briefing." },
      { agentKind: "claude", effort: "medium", launcher: "claude-personal", model: "sonnet", name: "plain", summary: "Has no briefing." },
    ]
    await openWithTopology(page, {
      lifecycle: {
        modelCatalogue: {
          catalogues: [{ launcher: "claude-personal", harness: "claude", status: "ready", error: null, revision: 1, models: [{ default: true, description: "Sonnet model.", efforts: [{ default: true, description: "Balanced execution.", name: "medium" }], label: "Sonnet", name: "sonnet", resolvedModel: null }], executableAvailable: true, checkedAt: null, fetchedAt: null, freshUntil: null }],
        },
        roleDetails: { briefed: { ...roles[0], briefing: "A role briefing." }, plain: { ...roles[1], briefing: "" } },
        roles,
      },
      waitForMessages: false,
    })
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/herdr/agents" && request.method() === "POST") spawnBodies.push(parseJsonObject(request.postData() ?? "{}"))
    })
    await page.goto("/agents/new?role=briefed")
    await expect(page.locator("#spawn-agent-goal")).toBeVisible()
    await page.locator("#spawn-agent-handle").fill("briefed")
    await page.locator("#spawn-agent-goal").fill("Inspect the release path.")
    await page.locator('[data-shell-page-form="spawn-agent"]').getByRole("button", { name: "Spawn agent", exact: true }).click()
    await expect.poll(() => spawnBodies.length).toBe(1)
    expect(spawnBodies[0]?.goal).toBe("Inspect the release path.")

    await page.goto("/agents/new?role=plain")
    await expect(page.locator("#spawn-agent-goal")).toHaveCount(0)
    await page.locator("#spawn-agent-handle").fill("plain")
    await page.locator('[data-shell-page-form="spawn-agent"]').getByRole("button", { name: "Spawn agent", exact: true }).click()
    await expect.poll(() => spawnBodies.length).toBe(2)
    expect(spawnBodies[1]).not.toHaveProperty("goal")
  })

  test("@guard spawn is a shell page, Escape returns to the origin, and the returned handle owns navigation", async ({ page }) => {
    const returnedTopology = topologyFixture([{ paneId: "w1H:pReturned", label: null, agentKind: "claude", agentStatus: "idle", focused: false, participant: "lead-2", participantRouteState: "active" }])
    await openWithTopology(page, {
      liveStream: true,
      lifecycle: { spawn: { handle: "lead-2", paneId: "w1H:pReturned" } },
      waitForMessages: false,
    })
    await page.route("**/api/agents/lead-2", async (route) => {
      await fulfillJson(route, {
        participant: { agentKind: "claude", handle: "lead-2", kind: "agent", lastSeenAt: null, routeState: "active" },
        routeState: "active",
        pane: { agentKind: "claude", agentStatus: "idle", focused: false, label: null, paneId: "w1H:pReturned", participant: "lead-2", participantRouteState: "active" },
        recentMessageIds: [],
      })
    })
    await page.goto("/agents/new")
    await expect(page.locator('[data-shell-page="spawn-agent"]')).toBeVisible()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    await page.keyboard.press("Escape")
    await expect(page).toHaveURL(/\/agents$/)

    await page.goto("/agents/new")
    await page.locator("#spawn-agent-handle").fill("typed-lead")
    await page.locator('[data-shell-page-form="spawn-agent"]').getByRole("button", { name: "Spawn agent", exact: true }).click()
    await expect(page.locator('[data-assigned-handle="lead-2"]')).toBeVisible()
    expect(await pushTopologySnapshot(page, returnedTopology)).toBe(true)
    await expect(page).toHaveURL(/\/agents\/lead-2$/)
    await expect(page.locator('[data-shell-page="agent-detail"]')).toBeVisible()
    await expect(page.locator('[data-agent-view="lead-2"]')).toBeVisible()
  })

  test("@guard native role attribution is visible and native role editing is read-only", async ({ page }) => {
    const roles = [{ agentKind: null, effort: null, launcher: "claude-personal", model: null, name: "lead", native: true, summary: "Coordinates the workspace." }]
    await openWithTopology(page, {
      lifecycle: {
        roleDetails: { lead: { ...roles[0], briefing: "Native lead briefing." } },
        roles,
      },
      waitForMessages: false,
    })
    await page.goto("/staffing")
    await expect(page.locator('[data-role-row="lead"] [data-role-native]')).toHaveText("Built in")
    await expect(page.locator('[data-role-edit="lead"]')).toBeEnabled()
    await expect(page.locator('[data-role-delete="lead"]')).toHaveCount(0)
    await page.locator('[data-role-edit="lead"]').click()
    await expect(page.locator('[data-role-form][data-role-native="true"]')).toBeVisible()
    await expect(page.locator('[data-role-native-message]')).toContainText("Built-in role instructions are read-only.")
    await expect(page.locator("#role-summary")).toBeDisabled()
    await expect(page.locator("#role-briefing")).toHaveValue("Native lead briefing.")
    const runtimeInputs = page.locator('[data-role-runtime] input[data-combobox-input]')
    await expect(runtimeInputs).toHaveCount(4)
    for (const input of await runtimeInputs.all()) await expect(input).toBeDisabled()
    await expect(page.locator('[data-shell-page-form="edit-role"] button[type="submit"]')).toBeDisabled()
  })

  test("@guard native role attribution reaches agent detail and workspace directory rows", async ({ page }) => {
    const leadPane = { agentKind: "claude", agentStatus: "working", focused: true, label: null, paneId: "w1A:p1", participant: "lead", participantRouteState: "active", role: "lead" }
    const topology = { workspaces: [{ id: "w1A", label: "quiet-repo", panes: [leadPane], tabs: [{ id: "w1A:tab-main", label: "Main", panes: [leadPane] }] }] }
    await openWithTopology(page, { topology, waitForMessages: false })
    await page.route("**/api/agents/lead", async (route) => {
      await fulfillJson(route, {
        participant: { agentKind: "claude", handle: "lead", kind: "agent", lastSeenAt: null, role: "lead", routeState: "active" },
        routeState: "active",
        pane: leadPane,
        recentMessageIds: [],
      })
    })
    await page.goto("/agents/lead")
    await expect(page.locator('[data-agent-role="lead"]')).toBeVisible()
    await page.goto("/workspaces")
    await expect(page.locator('[data-workspace-block="w1A"]')).toBeVisible()
    await expect(page.locator('[data-workspace-block="w1A"] [data-workspace-lead]')).toHaveText("Lead: lead")
    await expect(page.locator('[data-workspace-block="w1A"] [data-agent-row="lead"]')).toBeVisible()
  })

  test("@guard native lead spawn is disabled when the selected workspace already has a lead", async ({ page }) => {
    const roles = [{ agentKind: null, effort: null, launcher: "claude-personal", model: null, name: "lead", native: true, summary: "Coordinates the workspace." }]
    const leadPane = { agentKind: "claude", agentStatus: "working", focused: true, label: null, paneId: "w1A:p1", participant: "lead", participantRouteState: "active", role: "lead" }
    const spawnRequests: string[] = []
    await openWithTopology(page, {
      lifecycle: {
        roleDetails: { lead: { ...roles[0], briefing: "Native lead briefing." } },
        roles,
      },
      topology: { workspaces: [{ id: "w1A", label: "quiet-repo", panes: [leadPane], tabs: [{ id: "w1A:tab-main", label: "Main", panes: [leadPane] }] }] },
      waitForMessages: false,
    })
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/herdr/agents" && request.method() === "POST") spawnRequests.push(request.url())
    })
    await page.goto("/agents/new?role=lead&workspaceId=w1A")
    await expect(page.locator('[data-native-lead-guard]')).toContainText("already has an active native lead")
    const spawnButton = page.locator('[data-shell-page-form="spawn-agent"] button[type="submit"]')
    await expect(spawnButton).toBeDisabled()
    await expect.poll(() => spawnRequests.length).toBe(0)
  })
})
