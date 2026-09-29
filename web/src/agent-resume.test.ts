import { describe, expect, it } from "bun:test"

import { HttpMsgrApi } from "@/api/client"
import { MockMsgrApi } from "@/api/mock"
import type { ResumableAgent } from "@/api/types"
import { planResumeAll, resumeAllLabel, resumeNote, resumeRequest } from "@/agent-resume"

interface JsonObject {
  [key: string]: JsonValue
}
type JsonValue = boolean | JsonObject | JsonValue[] | null | number | string

function jsonResponse(body: JsonValue): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status: 200 })
}

describe("resumeNote", () => {
  it("shows nothing for a connected identity and an action for a resumable one", () => {
    expect(resumeNote({ kind: "connected" })).toEqual({ kind: "none" })
    const launcher = { kind: "matched" as const, launcher: "claude" }
    expect(resumeNote({ kind: "resumable", harness: "claude", sessionId: "s", launcher })).toEqual({ kind: "action", launcher })
  })

  it("explains every state without a Resume button", () => {
    expect(resumeNote({ kind: "no-session" }).kind).toBe("hint")
    expect(resumeNote({ kind: "no-launcher", harness: "pi" })).toMatchObject({ kind: "hint", text: expect.stringContaining("pi launcher") })
    expect(resumeNote({ kind: "unsupported", harness: null })).toMatchObject({ kind: "hint", text: expect.stringContaining("unknown") })
    expect(resumeNote({ kind: "unsupported", harness: "amp" })).toMatchObject({ kind: "hint", text: "amp cannot resume a session by id." })
  })
})

describe("resumeRequest", () => {
  it("sends no launcher when the hub knows it", () => {
    expect(resumeRequest({ kind: "recorded", launcher: "claude" }, null)).toEqual({ kind: "ready", request: {} })
  })

  it("needs a pick among the offered launchers when two fit", () => {
    const choose = { kind: "choose" as const, launchers: ["claude-personal", "claude-work"] }
    expect(resumeRequest(choose, null)).toEqual({ kind: "needs-launcher", launchers: choose.launchers })
    expect(resumeRequest(choose, "other")).toEqual({ kind: "needs-launcher", launchers: choose.launchers })
    expect(resumeRequest(choose, "claude-work")).toEqual({ kind: "ready", request: { launcher: "claude-work" } })
  })
})

describe("planResumeAll", () => {
  it("starts agents with a known launcher and leaves the choices to the human", () => {
    const agents: ResumableAgent[] = [
      { handle: "worker", resume: { kind: "resumable", harness: "codex", sessionId: "a", launcher: { kind: "matched", launcher: "codex" } } },
      { handle: "lead", resume: { kind: "resumable", harness: "claude", sessionId: "b", launcher: { kind: "choose", launchers: ["x", "y"] } } },
      { handle: "gone", resume: { kind: "no-session" } },
    ]
    expect(planResumeAll(agents)).toEqual({ automatic: ["worker"], needsLauncher: ["lead"] })
    expect(resumeAllLabel(1)).toBe("Resume 1 agent")
    expect(resumeAllLabel(3)).toBe("Resume 3 agents")
  })
})

describe("resume API", () => {
  it("decodes an agent detail from a hub without resume as no-session", async () => {
    const api = new HttpMsgrApi({
      fetchImpl: async () => jsonResponse({
        participant: { handle: "worker", kind: "agent", agentKind: "claude", routeState: "stale", lastSeenAt: null },
        routeState: "stale",
        pane: null,
        recentMessageIds: [],
      }),
    })
    const detail = await api.getAgentDetail("worker")
    expect(detail.isOk() && detail.value.resume).toEqual({ kind: "no-session" })
  })

  it("posts the chosen launcher to the resume path", async () => {
    const calls: string[] = []
    const api = new HttpMsgrApi({
      baseUrl: "",
      fetchImpl: async (input, init) => {
        calls.push(`${init?.method} ${String(input)} ${String(init?.body)}`)
        return jsonResponse({ handle: "lead", paneId: "w1:p9", sessionId: "b" })
      },
    })
    const resumed = await api.resumeAgent("lead", { launcher: "claude-work" })
    expect(resumed.isOk()).toBe(true)
    expect(calls).toEqual(['POST /api/agents/lead/resume {"launcher":"claude-work"}'])
  })

  it("the mock resumes a matched agent once and refuses a choose without a launcher", async () => {
    const api = new MockMsgrApi()
    const listed = await api.listResumableAgents()
    expect(listed.isOk() && listed.value.agents.map((agent) => agent.handle)).toEqual(["old-runner", "archived-reviewer"])
    expect((await api.resumeAgent("archived-reviewer", {})).isErr()).toBe(true)
    expect((await api.resumeAgent("old-runner", {})).isOk()).toBe(true)
    expect((await api.resumeAgent("old-runner", {})).isErr()).toBe(true)
  })
})
