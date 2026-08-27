import { describe, expect, it } from "bun:test"

import { HttpMsgrApi } from "@/api/client"
import { MockMsgrApi } from "@/api/mock"
import { parseSearchQuery } from "@/hooks/use-search"
import { shellRouteFromLocation, shellRoutePath } from "@/shell-routing"

describe("search route", () => {
  it("round trips query and channel scope", () => {
    const route = { kind: "search" as const, query: "from:scout query", scope: "channel:research" as const }
    const path = shellRoutePath(route)
    const [pathname, search = ""] = path.split("?")

    expect(shellRouteFromLocation({ pathname, search: `?${search}` })).toEqual(route)
    expect(shellRouteFromLocation({ pathname: "/search", search: "?q=gate" })).toEqual({
      kind: "search",
      query: "gate",
      scope: "all",
    })
  })
})

describe("search query parsing", () => {
  it("sends the sender prefix as a filter and removes it from the literal query", () => {
    expect(parseSearchQuery("from:codex-reviewer verify rollout")).toEqual({
      effectiveQuery: "verify rollout",
      notice: undefined,
      sender: "codex-reviewer",
    })
  })

  it("keeps the eight-term cap notice after sender parsing", () => {
    expect(parseSearchQuery("from:scout one two three four five six seven eight nine")).toEqual({
      effectiveQuery: "one two three four five six seven eight",
      notice: "Searched the first 8 words. 1 more were ignored.",
      sender: "scout",
    })
  })
})

describe("search API contract", () => {
  it("filters mock results by sender and reports exact truncation", async () => {
    const result = await new MockMsgrApi().search({ limit: 1, q: "query", sender: "scout" })
    expect(result.match({ ok: ({ results, truncated }) => [results.length, results[0]?.sender, truncated], err: () => [] })).toEqual([1, "scout", false])
  })

  it("encodes sender and decodes the truncation flag", async () => {
    let request: Request | undefined
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        request = new Request(input, init)
        return new Response(JSON.stringify({ results: [], truncated: true }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      },
    })

    const result = await api.search({ limit: 50, q: "verify", sender: "codex-reviewer" })
    const url = new URL(request?.url ?? "http://127.0.0.1")
    expect([url.pathname, url.searchParams.get("q"), url.searchParams.get("sender"), url.searchParams.get("limit")]).toEqual([
      "/api/search",
      "verify",
      "codex-reviewer",
      "50",
    ])
    expect(result.match({ ok: ({ truncated }) => truncated, err: () => false })).toBe(true)
  })

  it("rejects negative search attachment counts", async () => {
    const api = new HttpMsgrApi({
      fetchImpl: async () => new Response(JSON.stringify({
        results: [{
          attachmentCount: -1,
          channel: "ops",
          createdAt: "2026-08-20T10:00:00.000Z",
          messageId: 1,
          sender: "runner",
          snippet: "invalid count",
        }],
        truncated: false,
      }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    })

    expect((await api.search({ limit: 50, q: "invalid" })).isErr()).toBe(true)
  })
})
