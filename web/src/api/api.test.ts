import { describe, expect, it } from "bun:test"
import { Result } from "better-result"

import { AckScheduler, highestContiguousVisibleId } from "./ack"
import { HttpMsgrApi } from "./client"
import { ApiHttpError, ApiNetworkError, formatApiError } from "./errors"
import { mockChannels, mockMessages } from "./fixtures"
import { mergeMessages } from "./message-merge"
import { MockMsgrApi } from "./mock"
import { withMockFallback } from "./runtime"
import { HerdrSseClient, MessageSseClient, parseSseRecords } from "./sse"
import type { ApiResult, FetchImplementation, ReceiptUpdate } from "./types"

describe("MockMsgrApi", () => {
  it("returns the fixture channel list", async () => {
    const result = await new MockMsgrApi().listChannels()
    const count = result.match({
      ok: ({ channels }) => channels.length,
      err: () => -1,
    })

    expect(count).toBe(3)
  })

  it("returns a tagged error for an unknown channel", async () => {
    const result = await new MockMsgrApi().listMessages("missing")
    const resource = result.match({
      ok: () => "unexpected-success",
      err: (error) =>
        error.match({
          ApiNetworkError: () => "network",
          ApiHttpError: () => "http",
          ApiDecodeError: () => "decode",
          ApiNotFoundError: (failure) => failure.resource,
          ApiConflictError: () => "conflict",
        }),
    })

    expect(resource).toBe("missing")
  })

  it("lists participants, adds a member, and stores dropped uploads", async () => {
    const api = new MockMsgrApi()
    const participants = await api.listParticipants()
    expect(participants.match({ ok: ({ participants: roster }) => roster.length, err: () => -1 })).toBe(5)

    const added = await api.addMember("ops", "builder-3")
    expect(added.match({ ok: ({ handle }) => handle, err: () => "error" })).toBe("builder-3")

    const upload = await api.uploadFile(new Blob(["# dropped\n"]), "dropped.md")
    const path = upload.match({ ok: ({ path: storedPath }) => storedPath, err: () => "" })
    expect(path).toContain("/mock/uploads/")
    expect((await api.sendMessage("ops", { attachments: [path], body: "with drop" })).isOk()).toBe(true)
  })

  it("lists direct conversations and reuses a conversation for the same recipients", async () => {
    const api = new MockMsgrApi()
    const initial = await api.listDirect()
    expect(initial.match({ ok: ({ conversations }) => conversations[0]?.channel, err: () => undefined })).toBe("dm-planner-runner")

    const first = await api.createDirect({ body: "first direct", to: ["planner"] })
    const second = await api.createDirect({ body: "second direct", to: ["planner"] })
    const channel = first.match({ ok: ({ channel: name }) => name, err: () => "" })
    expect(second.match({ ok: ({ channel: name }) => name, err: () => "" })).toBe(channel)
    expect(channel).toMatch(/^dm-/u)

    const messages = await api.listMessages(channel)
    expect(messages.match({ ok: ({ messages: rows }) => rows.map((row) => row.body), err: () => [] })).toEqual([
      "first direct",
      "second direct",
    ])
  })

  it("manages workspace tabs and removes their panes on close", async () => {
    const api = new MockMsgrApi()
    const initial = await api.listWorkspaces()
    const workspaceId = initial.match({ ok: ({ workspaces }) => workspaces[0]?.id, err: () => undefined })
    const mainTabId = initial.match({ ok: ({ workspaces }) => workspaces[0]?.tabs[0]?.id, err: () => undefined })
    expect(workspaceId).toBe("workspace-sheppard")

    const created = await api.createTab({ label: "Review", workspaceId: workspaceId ?? "" })
    const tabId = created.match({ ok: ({ tab }) => tab.id, err: () => "" })
    expect(tabId).toContain(":tab-")
    expect((await api.renameTab(tabId, { label: "QA" })).isOk()).toBe(true)
    expect((await api.focusTab(tabId)).isOk()).toBe(true)
    expect((await api.closeTab(tabId, { confirm: "Review" })).isErr()).toBe(true)
    expect((await api.closeTab(tabId, { confirm: "QA" })).isOk()).toBe(true)

    const closed = await api.closeTab(mainTabId ?? "", { confirm: "Main" })
    expect(closed.isOk()).toBe(true)
    const remaining = await api.listWorkspaces()
    expect(remaining.match({ ok: ({ workspaces }) => [workspaces[0]?.tabs.length, workspaces[0]?.panes.length], err: () => [] })).toEqual([0, 0])
  })

  it("lists device models with exact effort options and refreshes one launcher", async () => {
    const api = new MockMsgrApi()
    const initial = await api.listModelCatalogue()
    expect(initial.match({ ok: ({ catalogues }) => catalogues.find((catalogue) => catalogue.launcher === "codex")?.models[0]?.efforts.map((effort) => effort.name), err: () => [] })).toEqual(["low", "medium", "high"])

    const refreshed = await api.refreshModelCatalogue({ launcher: "codex" })
    expect(refreshed.match({ ok: ({ catalogues }) => catalogues.find((catalogue) => catalogue.launcher === "codex")?.status, err: () => "error" })).toBe("ready")
  })

  it("keeps launcher environment values hidden while applying explicit patches", async () => {
    const api = new MockMsgrApi()
    const created = await api.createLauncher({
      agentKind: "claude",
      argv: ["claude", "--config"],
      env: { KEEP_KEY: "keep-value", REMOVE_KEY: "remove-value" },
      name: "launcher-env-test",
      startTimeoutMs: 35_000,
    })
    expect(created.match({ ok: (launcher) => launcher.envKeys, err: () => [] })).toEqual(["KEEP_KEY", "REMOVE_KEY"])
    expect(JSON.stringify(created)).not.toContain("keep-value")
    expect(JSON.stringify(created)).not.toContain("remove-value")

    const updated = await api.updateLauncher("launcher-env-test", {
      agentKind: "claude",
      argv: ["claude", "--config"],
      envPatch: { remove: ["REMOVE_KEY"], set: { KEEP_KEY: "replacement", NEW_KEY: "new-value" } },
    })
    expect(updated.match({ ok: (launcher) => launcher.envKeys, err: () => [] })).toEqual(["KEEP_KEY", "NEW_KEY"])
    expect(JSON.stringify(updated)).not.toContain("replacement")
    expect(JSON.stringify(updated)).not.toContain("new-value")

    const listed = await api.listLaunchers()
    expect(listed.match({ ok: ({ launchers }) => launchers.find((launcher) => launcher.name === "launcher-env-test")?.envKeys, err: () => [] })).toEqual(["KEEP_KEY", "NEW_KEY"])
    const refreshed = await api.refreshModelCatalogue({ launcher: "launcher-env-test" })
    expect(refreshed.match({ ok: ({ catalogues }) => catalogues.find((catalogue) => catalogue.launcher === "launcher-env-test")?.revision, err: () => -1 })).toBe(2)
  })
})

describe("HttpMsgrApi", () => {
  it("decodes a contract response", async () => {
    const api = new HttpMsgrApi({
      fetchImpl: async () =>
        new Response(JSON.stringify({ channels: [] }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        }),
    })
    const result = await api.listChannels()

    expect(result.match({ ok: ({ channels }) => channels.length, err: () => -1 })).toBe(0)
  })

  it("uses the direct-message endpoints and decodes their responses", async () => {
    const requests: Request[] = []
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(
          requests.at(-1)?.method === "POST"
            ? JSON.stringify({ channel: "dm-1234", messageId: 42 })
            : JSON.stringify({ conversations: [{ channel: "dm-1234", participants: ["planner"], unread: 2 }] }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        )
      },
    })

    const created = await api.createDirect({ body: "hello", to: ["planner"] })
    const listed = await api.listDirect()
    expect(created.match({ ok: ({ channel }) => channel, err: () => "" })).toBe("dm-1234")
    expect(listed.match({ ok: ({ conversations }) => conversations[0]?.participants[0], err: () => "" })).toBe("planner")
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["POST", "/api/direct"],
      ["GET", "/api/direct"],
    ])
  })

  it("uses the human-only directory picker endpoint", async () => {
    const requests: Request[] = []
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(JSON.stringify({
          currentPath: "/Users/operator/Projects",
          parentPath: "/Users/operator",
          directories: [{ name: "sheppard", path: "/Users/operator/Projects/sheppard" }],
          truncated: false,
        }), { headers: { "Content-Type": "application/json" }, status: 200 })
      },
    })

    const result = await api.listDirectories("/Users/operator/Projects")
    expect(result.match({ ok: ({ directories }) => directories[0]?.name, err: () => "" })).toBe("sheppard")
    expect(requests[0]?.method).toBe("GET")
    expect(new URL(requests[0]?.url ?? "http://127.0.0.1").searchParams.get("path")).toBe("/Users/operator/Projects")
  })

  it("uses GET and targeted POST for the device model catalogue", async () => {
    const requests: Request[] = []
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        const request = new Request(input, init)
        requests.push(request)
        return new Response(JSON.stringify({
          catalogues: [{
            launcher: "codex",
            harness: "codex",
            status: "ready",
            error: null,
            revision: 1,
            models: [{
              name: "gpt-5.6-sol",
              resolvedModel: "gpt-5.6-sol",
              label: "GPT-5.6 Sol",
              description: "Current device model",
              default: true,
              efforts: [{ name: "medium", description: "Balanced", default: true }],
            }],
            executableAvailable: true,
            checkedAt: "2026-08-23T08:00:00.000Z",
            fetchedAt: "2026-08-23T08:00:00.000Z",
            freshUntil: "2026-08-23T13:00:00.000Z",
          }],
        }), { headers: { "Content-Type": "application/json" }, status: 200 })
      },
    })

    expect((await api.listModelCatalogue()).isOk()).toBe(true)
    expect((await api.refreshModelCatalogue({ launcher: "codex" })).isOk()).toBe(true)
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/api/herdr/model-catalogue"],
      ["POST", "/api/herdr/model-catalogue"],
    ])
    expect(await requests[1]?.clone().json()).toEqual({ launcher: "codex" })
  })

  it("uses the agent detail endpoint and decodes pane and message references", async () => {
    const requests: Request[] = []
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(JSON.stringify({
          participant: {
            agentKind: "codex",
            handle: "codex-reviewer",
            kind: "agent",
            lastSeenAt: "2026-08-18T09:00:00.000Z",
            routeState: "active",
          },
          pane: null,
          recentMessageIds: [{ channel: "ops", messageIds: [7, 4] }],
          routeState: "active",
        }), { headers: { "Content-Type": "application/json" }, status: 200 })
      },
    })

    const result = await api.getAgentDetail("codex-reviewer")
    expect(result.match({ ok: ({ participant, recentMessageIds }) => [participant.handle, recentMessageIds[0]?.messageIds], err: () => [] })).toEqual([
      "codex-reviewer",
      [7, 4],
    ])
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/api/agents/codex-reviewer"],
    ])
  })

  it("returns a decode error for invalid JSON", async () => {
    const api = new HttpMsgrApi({
      fetchImpl: async () => new Response("not json", { status: 200 }),
    })
    const result = await api.listChannels()
    const message = result.match({
      ok: () => "unexpected-success",
      err: (error) => formatApiError(error),
    })

    expect(message).toContain("invalid JSON")
  })

  it("reports unauthorized responses to the session controller", async () => {
    let unauthorized = 0
    const api = new HttpMsgrApi({
      fetchImpl: async () => new Response(JSON.stringify({ code: "Unauthorized" }), { status: 401 }),
      onUnauthorized: () => { unauthorized += 1 },
    })
    const result = await api.inbox()

    expect(result.isErr()).toBe(true)
    expect(unauthorized).toBe(1)
  })

  it("names the leftover pane after a spawn timeout", () => {
    const error = new ApiHttpError({
      body: JSON.stringify({ code: "HerdrCallFailed", error: "herdr agent start did not complete: timed out while starting pane w1:spawned-2" }),
      message: "spawn failed",
      operation: "spawnAgent",
      status: 503,
    })

    const copy = formatApiError(error)
    expect(copy).toContain("w1:spawned-2")
    expect(copy).toContain("Do not retry until the pane is resolved.")
    expect(copy).not.toContain("Channels and messages are unaffected")
  })

  it("names the leftover pane after an unreachable spawn", () => {
    const error = new ApiHttpError({
      body: JSON.stringify({ code: "HerdrCallFailed", error: "herdr agent start did not complete: agent start failed while starting pane w1:spawned-2" }),
      message: "spawn failed",
      operation: "spawnAgent",
      status: 503,
    })

    const copy = formatApiError(error)
    expect(copy).toContain("w1:spawned-2")
    expect(copy).not.toContain("Retry")
  })

  it("does not say that an unresolved cleanup pane was closed", () => {
    const error = new ApiHttpError({
      body: JSON.stringify({ code: "HerdrCallFailed", error: "spawn cleanup pane close failed while cleaning up pane w1:spawned-2; cleanup state is unresolved" }),
      message: "spawn failed",
      operation: "spawnAgent",
      status: 503,
    })

    const copy = formatApiError(error)
    expect(copy).toContain("w1:spawned-2")
    expect(copy).toContain("may still be open")
    expect(copy).not.toContain("closed")
  })

  it("states that cleanup is unresolved when the pane identity is unknown", () => {
    const error = new ApiHttpError({
      body: JSON.stringify({ code: "HerdrCallFailed", error: "spawn cleanup pane close failed; pane identity is unknown; cleanup state is unresolved" }),
      message: "spawn failed",
      operation: "spawnAgent",
      status: 503,
    })

    const copy = formatApiError(error)
    expect(copy).toContain("cleanup is unresolved")
    expect(copy).toContain("pane state is unknown")
    expect(copy).not.toContain("closed")
  })
})

describe("mergeMessages", () => {
  it("sorts by id and ignores duplicate message ids", () => {
    const first = mockMessages[2]
    const duplicate = { ...first, body: "duplicate content" }
    const merged = mergeMessages([first], [duplicate, mockMessages[0]])

    expect(merged.map((message) => message.id)).toEqual([1, 3])
    expect(merged.find((message) => message.id === 3)?.body).toBe(first.body)
  })
})

describe("M3 client helpers", () => {
  it("parses complete and partial SSE records", () => {
    const complete = parseSseRecords("id: 4\ndata: {\"id\":4}\n\n")
    const partial = parseSseRecords("id: 5\ndata: {\"id\":5}")

    expect(complete.match({ ok: ({ events }) => events[0]?.id, err: () => undefined })).toBe("4")
    expect(partial.match({ ok: ({ events, rest }) => [events.length, rest], err: () => [] })).toEqual([
      0,
      "id: 5\ndata: {\"id\":5}",
    ])
  })

  it("closes message and topology streams on cleanup", async () => {
    let activeStreams = 0
    let aborts = 0
    const fetchImpl: FetchImplementation = async (_input, init) => {
      activeStreams += 1
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start: (stream) => {
          signal?.addEventListener("abort", () => {
            aborts += 1
            activeStreams -= 1
            stream.error(new DOMException("aborted", "AbortError"))
          }, { once: true })
        },
      })
      return new Response(body, { status: 200 })
    }
    const messages = new MessageSseClient(
      { fetchImpl, maxRetryDelayMs: 0, retryDelayMs: 0, retryJitterMs: 0, url: "/api/events" },
      { onError: () => undefined, onMessage: () => undefined, onOpen: () => undefined },
    )
    const topology = new HerdrSseClient(
      { fetchImpl, maxRetryDelayMs: 0, retryDelayMs: 0, retryJitterMs: 0, url: "/api/herdr/events" },
      { onError: () => undefined, onOpen: () => undefined, onSnapshot: () => undefined },
    )
    messages.start()
    topology.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    messages.close()
    topology.close()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(activeStreams).toBe(0)
    expect(aborts).toBe(2)
  })

  it("reconnects each stream without overlapping response bodies", async () => {
    const calls = new Map<string, number>()
    const active = new Map<string, number>()
    const maximum = new Map<string, number>()
    const fetchImpl: FetchImplementation = async (input, init) => {
      const url = String(input)
      const call = (calls.get(url) ?? 0) + 1
      calls.set(url, call)
      const current = (active.get(url) ?? 0) + 1
      active.set(url, current)
      maximum.set(url, Math.max(maximum.get(url) ?? 0, current))
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start: (stream) => {
          let aborted = false
          signal?.addEventListener("abort", () => {
            if (aborted) return
            aborted = true
            active.set(url, (active.get(url) ?? 1) - 1)
            stream.error(new DOMException("aborted", "AbortError"))
          }, { once: true })
          if (call === 1) queueMicrotask(() => stream.error(new DOMException("server closed", "NetworkError")))
        },
      })
      return new Response(body, { status: 200 })
    }
    const messages = new MessageSseClient(
      { fetchImpl, maxRetryDelayMs: 0, retryDelayMs: 0, retryJitterMs: 0, url: "/api/events" },
      { onError: () => undefined, onMessage: () => undefined, onOpen: () => undefined },
    )
    const topology = new HerdrSseClient(
      { fetchImpl, maxRetryDelayMs: 0, retryDelayMs: 0, retryJitterMs: 0, url: "/api/herdr/events" },
      { onError: () => undefined, onOpen: () => undefined, onSnapshot: () => undefined },
    )
    messages.start()
    topology.start()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(calls.get("/api/events")).toBeGreaterThanOrEqual(2)
    expect(calls.get("/api/herdr/events")).toBeGreaterThanOrEqual(2)
    expect(maximum.get("/api/events")).toBe(1)
    expect(maximum.get("/api/herdr/events")).toBe(1)

    messages.close()
    topology.close()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(active.get("/api/events")).toBe(0)
    expect(active.get("/api/herdr/events")).toBe(0)
  })

  it("sends the resume cursor and preserves SSE event ids", async () => {
    const seed = mockMessages[0]
    if (seed === undefined) throw new Error("fixtures lost the stream seed")
    const headers: Headers[] = []
    let eventId: string | undefined
    const encoder = new TextEncoder()
    const fetchImpl: FetchImplementation = async (_input, init) => {
      headers.push(new Headers(init?.headers))
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(encoder.encode(`id: 7\ndata: ${JSON.stringify(seed)}\n\n`))
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true })
        },
      })
      return new Response(body, { status: 200 })
    }
    const stream = new MessageSseClient(
      { fetchImpl, lastEventId: "6", maxRetryDelayMs: 0, retryDelayMs: 0, retryJitterMs: 0, url: "/api/events" },
      {
        onError: () => undefined,
        onMessage: (_message, receivedId) => { eventId = receivedId },
        onOpen: () => undefined,
      },
    )
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    stream.close()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(headers[0]?.get("Last-Event-ID")).toBe("6")
    expect(eventId).toBe("7")
  })

  it("decodes a receipt event with its channel", async () => {
    let update: ReceiptUpdate | undefined
    const encoder = new TextEncoder()
    const fetchImpl: FetchImplementation = async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(encoder.encode(`event: receipt\ndata: ${JSON.stringify({ channel: "ops", handle: "bob", cursorMessageId: 4 })}\n\n`))
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true })
        },
      })
      return new Response(body, { status: 200 })
    }
    const stream = new MessageSseClient(
      { fetchImpl, maxRetryDelayMs: 0, retryDelayMs: 0, retryJitterMs: 0, url: "/api/events" },
      {
        onError: () => undefined,
        onMessage: () => undefined,
        onOpen: () => undefined,
        onReceipt: (received) => { update = received },
      },
    )
    stream.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    stream.close()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(update).toEqual({ channel: "ops", handle: "bob", cursorMessageId: 4 })
  })

  it("finds the highest visible contiguous message", () => {
    expect(highestContiguousVisibleId(mockMessages.slice(0, 4), ["2", "3"])).toBe(3)
    expect(highestContiguousVisibleId(mockMessages.slice(0, 4), ["2", "4"])).toBe(2)
  })

  it("coalesces acknowledgements and keeps non-member errors visible", async () => {
    const calls: number[] = []
    const channel = mockChannels[0].name
    const scheduler = new AckScheduler(async (_channel, throughId) => {
      calls.push(throughId)
      return Result.ok({ cursorId: throughId })
    }, 0)
    scheduler.enqueue(channel, 2)
    scheduler.enqueue(channel, 4)
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.close()

    const nonMember = await withMockFallback(
      () =>
        Promise.resolve(
          Result.err(
            new ApiHttpError({ body: '{"error":"Not a member"}', message: "Not a member", status: 400 }),
          ),
        ),
      () => Promise.resolve(Result.ok({ cursorId: 99 })),
    )

    expect(calls).toEqual([4])
    expect(
      nonMember.match({
        ok: () => -1,
        err: (error) =>
          error.match({
            ApiNetworkError: () => -1,
            ApiHttpError: (failure) => failure.status,
            ApiDecodeError: () => -1,
            ApiNotFoundError: () => -1,
            ApiConflictError: () => -1,
          }),
      }),
    ).toBe(400)
  })

  it("drops acknowledgements already flushed for a channel", async () => {
    const calls: number[] = []
    const scheduler = new AckScheduler(async (_channel, throughId) => {
      calls.push(throughId)
      return Result.ok({ cursorId: throughId })
    }, 0)

    scheduler.enqueue("ops", 4)
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.enqueue("ops", 4)
    scheduler.enqueue("ops", 3)
    await new Promise((resolve) => setTimeout(resolve, 10))
    scheduler.close()

    expect(calls).toEqual([4])
  })

  it("uses mocks only when the caller enables the development fallback", async () => {
    const networkError = async (): ApiResult<string> =>
      Result.err(
        new ApiNetworkError({
          cause: undefined,
          message: "The hub is down",
        }),
      )
    const fallback = async (): ApiResult<string> => Result.ok("fixture")

    const production = await withMockFallback(networkError, fallback, false)
    const development = await withMockFallback(networkError, fallback, true)

    expect(production.match({ ok: () => "fixture", err: () => "primary" })).toBe("primary")
    expect(development.match({ ok: (value) => value, err: () => "primary" })).toBe("fixture")
  })

  it("keeps a live model catalogue 5xx as an error when fallback is disabled", async () => {
    const liveFailure = async (): ApiResult<{ models: string[] }> => Result.err(new ApiHttpError({ body: "catalogue unavailable", message: "catalogue unavailable", operation: "listModelCatalogue", status: 503 }))
    const fixture = async (): ApiResult<{ models: string[] }> => Result.ok({ models: ["fixture-model"] })
    const result = await withMockFallback(liveFailure, fixture, false)
    expect(result.match({ ok: () => "fixture", err: (error) => error.match({ ApiHttpError: (failure) => String(failure.status), ApiNetworkError: () => "network", ApiDecodeError: () => "decode", ApiNotFoundError: () => "not-found", ApiConflictError: () => "conflict" }) })).toBe("503")
  })

  it("serves markdown content from the mock attachment fixture", async () => {
    const result = await new MockMsgrApi().attachmentContent(103)
    expect(result.match({ ok: (content) => content, err: () => "" })).toContain("# Release notes")
  })
})
