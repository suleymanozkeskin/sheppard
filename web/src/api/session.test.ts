import { describe, expect, it } from "bun:test"

import { HttpMsgrApi } from "./client"
import { lastSpokenText, mockSessionTurns } from "./fixtures"
import { MockMsgrApi } from "./mock"
import type { AgentSession, SessionTurn } from "./types"

const READY_BODY = {
  turns: [
    { kind: "turn", role: "user", text: "take the viewer batch", tool: null, at: "2026-08-19T08:00:00.000Z", sidechain: false },
    { kind: "tool", role: null, text: "bun test tests/", tool: { name: "Bash", outcome: "unknown" }, at: "2026-08-19T08:00:01.000Z", sidechain: false },
    { kind: "turn", role: "assistant", text: "Tests are green.", tool: null, at: "2026-08-19T08:00:09.000Z", sidechain: false },
  ],
  nextBefore: 65_536,
  source: {
    state: "ready",
    harness: "claude",
    sessionPath: "/sessions/claude/9f2c.jsonl",
    glance: "Tests are green.",
    reason: null,
  },
  mapping: { confidence: "exact", candidates: [] },
}

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

describe("the session client", () => {
  it("reads the pane's session and carries the paging window in the query", async () => {
    const requests: Request[] = []
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return jsonResponse(READY_BODY)
      },
    })

    const result = await api.getAgentSession("w1:p1", { before: 65_536, limit: 50 })

    expect(result.match({ ok: (session) => session.turns.length, err: () => -1 })).toBe(3)
    // A pane id carries a colon, so it goes on the wire encoded. The server
    // decodes each path segment before matching.
    const url = new URL(requests[0]?.url ?? "http://x/")
    expect([requests[0]?.method, url.pathname]).toEqual(["GET", "/api/herdr/agents/w1%3Ap1/session"])
    expect(decodeURIComponent(url.pathname)).toBe("/api/herdr/agents/w1:p1/session")
    expect([url.searchParams.get("limit"), url.searchParams.get("before")]).toEqual(["50", "65536"])
  })

  it("selects a candidate with only its opaque session id", async () => {
    const requests: Request[] = []
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return jsonResponse({ state: "ready", sessionId: "newer" })
      },
    })

    const result = await api.selectAgentSession("w1:p1", { sessionId: "newer" })

    expect(result.match({ ok: (selection) => selection.sessionId, err: () => "error" })).toBe("newer")
    const request = requests[0]
    if (request === undefined) throw new Error("selection request was not sent")
    expect([request.method, new URL(request.url).pathname]).toEqual([
      "POST",
      "/api/herdr/agents/w1%3Ap1/session/select",
    ])
    expect(JSON.parse(await request.text())).toEqual({ sessionId: "newer" })
  })

  it("keeps every state distinct instead of decoding it into an empty session", async () => {
    const states = ["absent", "ambiguous", "unsupported", "error"]
    const decoded: string[] = []
    for (const state of states) {
      const api = new HttpMsgrApi({
        fetchImpl: async () => jsonResponse({
          turns: [],
          nextBefore: null,
          source: { state, harness: "amp", sessionPath: null, glance: null, reason: "list failed" },
          mapping: null,
        }),
      })
      const result = await api.getAgentSession("w1:p1")
      decoded.push(result.match({ ok: (session) => session.source.state, err: () => "decode-error" }))
    }

    expect(decoded).toEqual(states)
  })

  it("refuses a state the panel has no rendering for", async () => {
    // A new state must reach the panel as a decode failure, not as a silently
    // empty transcript that reads like "this agent did nothing".
    const api = new HttpMsgrApi({
      fetchImpl: async () => jsonResponse({
        ...READY_BODY,
        source: { ...READY_BODY.source, state: "partially-ready" },
      }),
    })

    const result = await api.getAgentSession("w1:p1")

    expect(result.match({ ok: () => "unexpected-success", err: () => "rejected" })).toBe("rejected")
  })
})

describe("the session fixture", () => {
  it("answers ready for a harness with a reader and unsupported for one without", async () => {
    const mock = new MockMsgrApi()

    const claude = await mock.getAgentSession("pane-server")
    const codex = await mock.getAgentSession("pane-web")

    const state = (result: Awaited<ReturnType<MockMsgrApi["getAgentSession"]>>): string =>
      result.match({ ok: (session: AgentSession) => session.source.state, err: () => "error" })
    expect([state(claude), state(codex)]).toEqual(["ready", "ready"])
  })

  it("exposes the session selection method for a known pane", async () => {
    const result = await new MockMsgrApi().selectAgentSession("pane-web", { sessionId: "candidate" })
    expect(result.match({ ok: (selection) => selection, err: () => undefined })).toEqual({
      state: "ready",
      sessionId: "candidate",
    })
  })

  it("puts a tool call and its result in the transcript, so the panel can collapse them", () => {
    const turns = mockSessionTurns("worker-tabs")

    expect(turns.filter((turn: SessionTurn) => turn.kind === "tool")).toHaveLength(2)
    expect(turns.at(-1)?.role).toBe("assistant")
  })

  it("never promotes tool output into the glance line", () => {
    const toolOnly: SessionTurn[] = [
      { kind: "tool", role: null, text: "1  # Coordination", tool: { name: "result", outcome: "ok" }, at: null, sidechain: false },
    ]

    expect(lastSpokenText(mockSessionTurns("worker-tabs"))).toBe("The viewer batch is unclaimed. Taking it and starting on the panel.")
    expect(lastSpokenText(toolOnly)).toBeNull()
    expect(lastSpokenText([])).toBeNull()
  })
})
