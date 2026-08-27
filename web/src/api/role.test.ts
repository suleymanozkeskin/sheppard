import { describe, expect, it } from "bun:test"

import { HttpMsgrApi } from "./client"

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string

function jsonResponse(body: JsonValue): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  })
}

describe("role detail client", () => {
  it("normalizes the live direct role response and keeps native attribution", async () => {
    const api = new HttpMsgrApi({
      fetchImpl: async () => jsonResponse({
        agentKind: null,
        briefing: "Lead briefing",
        effort: null,
        launcher: "claude",
        model: null,
        name: "lead",
        native: true,
        summary: "Native lead",
      }),
    })

    const result = await api.getRole("lead")

    expect(result.match({ ok: ({ role }) => [role.name, role.native, role.briefing], err: () => [] })).toEqual([
      "lead",
      true,
      "Lead briefing",
    ])
  })

  it("keeps compatibility with the wrapped role response", async () => {
    const api = new HttpMsgrApi({
      fetchImpl: async () => jsonResponse({
        role: {
          agentKind: "claude",
          briefing: "User briefing",
          effort: null,
          launcher: null,
          model: null,
          name: "reviewer",
          native: false,
          summary: "User role",
        },
      }),
    })

    const result = await api.getRole("reviewer")

    expect(result.match({ ok: ({ role }) => [role.name, role.native], err: () => [] })).toEqual(["reviewer", false])
  })
})
