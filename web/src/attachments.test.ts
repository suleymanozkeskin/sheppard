import { describe, expect, it } from "bun:test"

import { HttpMsgrApi } from "@/api/client"
import { MockMsgrApi } from "@/api/mock"
import { isPageLevelFocus } from "@/attachments-focus"
import { shellRouteFromLocation, shellRoutePath } from "@/shell-routing"

describe("attachment initial focus", () => {
  it("claims focus only when the document has page-level focus", () => {
    const body = {}
    const documentElement = {}
    const control = {}

    expect(isPageLevelFocus(null, body, documentElement)).toBe(true)
    expect(isPageLevelFocus(undefined, body, documentElement)).toBe(true)
    expect(isPageLevelFocus(body, body, documentElement)).toBe(true)
    expect(isPageLevelFocus(documentElement, body, documentElement)).toBe(true)
    expect(isPageLevelFocus(control, body, documentElement)).toBe(false)
  })
})

describe("attachments route", () => {
  it("round trips scope and kind filters", () => {
    const route = { attachmentKind: "markdown" as const, kind: "attachments" as const, scope: "channel:ops" as const }
    const path = shellRoutePath(route)
    const [pathname, search = ""] = path.split("?")

    expect(shellRouteFromLocation({ pathname, search: `?${search}` })).toEqual(route)
    expect(shellRouteFromLocation({ pathname: "/attachments", search: "" })).toEqual({
      attachmentKind: "all",
      kind: "attachments",
      scope: "all",
    })
  })
})

describe("attachment listing API", () => {
  it("filters by kind and reports exact truncation", async () => {
    const result = await new MockMsgrApi().listAttachments({ kind: "image", limit: 1 })
    expect(result.match({
      ok: ({ rows, truncated }) => [rows.map((row) => row.attachment.displayName), truncated],
      err: () => [],
    })).toEqual([["rollout.png"], false])

    const limited = await new MockMsgrApi().listAttachments({ limit: 2 })
    expect(limited.match({
      ok: ({ rows, truncated }) => [rows.map((row) => row.attachment.id), truncated],
      err: () => [],
    })).toEqual([[103, 102], true])
  })

  it("omits kind for all and sends channel and kind filters when set", async () => {
    const requests: Request[] = []
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(JSON.stringify({ rows: [], truncated: false }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      },
    })

    await api.listAttachments({ channel: "ops", limit: 50 })
    await api.listAttachments({ channel: "ops", kind: "markdown", limit: 50 })
    expect(requests.map((request) => new URL(request.url).search)).toEqual([
      "?channel=ops&limit=50",
      "?channel=ops&kind=markdown&limit=50",
    ])
  })
})
