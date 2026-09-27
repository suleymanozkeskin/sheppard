import { describe, expect, it } from "bun:test"

import { HttpMsgrApi } from "@/api/client"
import { mockWorkspaces } from "@/api/fixtures"
import { MockMsgrApi } from "@/api/mock"
import type { HerdrWorkspaceView, KeepAwakePolicy, Member } from "@/api/types"
import {
  KEEP_AWAKE_DEFAULTS,
  defaultCoordinator,
  describeCause,
  describeSetting,
  draftFromLimits,
  keepAwakeAlarms,
  parseLimitsDraft,
  workspaceLeadHandles,
} from "@/keep-awake"

const WATCHING: KeepAwakePolicy = {
  id: 1,
  target: { kind: "agent", participantId: 4, handle: "bob" },
  limits: KEEP_AWAKE_DEFAULTS,
  state: { kind: "watching", wakesUsed: 1, lastWake: { kind: "woken", at: "2026-08-17T10:00:00.000Z" }, since: "2026-08-17T09:00:00.000Z" },
  humanMarkId: 0,
}

function stopped(id: number, since: string, target: KeepAwakePolicy["target"]): KeepAwakePolicy {
  return { ...WATCHING, id, target, state: { kind: "needs-human", cause: { kind: "wakes-exhausted" }, since } }
}

function member(handle: string, kind: Member["kind"]): Member {
  return { handle, kind, agentKind: kind === "agent" ? "claude" : null, routeState: "active", unread: 0, joinedAt: "2026-08-17T09:00:00.000Z" }
}

describe("parseLimitsDraft", () => {
  it("accepts whole numbers inside the bounds", () => {
    expect(parseLimitsDraft(draftFromLimits(KEEP_AWAKE_DEFAULTS))).toEqual({ kind: "valid", limits: KEEP_AWAKE_DEFAULTS })
  })

  it("names the first field out of bounds", () => {
    expect(parseLimitsDraft({ idleMinutes: "20", blockedMinutes: "0", maxWakes: "3" })).toMatchObject({ kind: "invalid", field: "blockedMinutes" })
    expect(parseLimitsDraft({ idleMinutes: "20", blockedMinutes: "30", maxWakes: "11" })).toMatchObject({ kind: "invalid", field: "maxWakes" })
    expect(parseLimitsDraft({ idleMinutes: "", blockedMinutes: "30", maxWakes: "3" })).toMatchObject({ kind: "invalid", field: "idleMinutes" })
    expect(parseLimitsDraft({ idleMinutes: "2.5", blockedMinutes: "30", maxWakes: "3" })).toMatchObject({ kind: "invalid", field: "idleMinutes" })
  })
})

describe("describeCause", () => {
  it("states each cause in plain words", () => {
    expect(describeCause({ kind: "wakes-exhausted" }, 3)).toBe("Stopped after 3 wakes.")
    expect(describeCause({ kind: "agent-requested", handle: "bob" }, 3)).toBe("@bob asked for a human decision.")
    expect(describeCause({ kind: "dialog-unrecognized", handle: "bob", reason: "folder-trust" }, 3)).toBe("@bob shows a dialog sheppard cannot close (folder trust).")
    expect(describeCause({ kind: "dialog-stuck", handle: "bob" }, 3)).toBe("@bob's dialog stayed open after Escape.")
  })
})

describe("describeSetting", () => {
  it("distinguishes off, watching, and needs-human", () => {
    const time = () => "10:00"
    expect(describeSetting({ kind: "off" }, time).tone).toBe("off")
    expect(describeSetting({ kind: "on", policy: WATCHING }, time)).toEqual({
      tone: "watching",
      headline: "Keep awake is on",
      detail: "1 of 3 wakes used. Last wake 10:00.",
    })
    expect(describeSetting({ kind: "on", policy: stopped(2, "x", WATCHING.target) }, time).tone).toBe("needs-human")
  })
})

describe("defaultCoordinator", () => {
  it("prefers a workspace lead, then the first agent member", () => {
    const members = [member("human", "human"), member("worker", "agent"), member("lead", "agent")]
    expect(defaultCoordinator(members, new Set(["lead"]))).toEqual({ kind: "chosen", handle: "lead" })
    expect(defaultCoordinator(members, new Set())).toEqual({ kind: "chosen", handle: "worker" })
    expect(defaultCoordinator([member("human", "human")], new Set())).toEqual({ kind: "no-agent-members" })
  })
})

describe("keepAwakeAlarms", () => {
  it("lists only stopped policies, oldest first, with their routes", () => {
    const alarms = keepAwakeAlarms([
      WATCHING,
      stopped(3, "2026-08-17T11:00:00.000Z", { kind: "channel", channelId: 1, channel: "ops", coordinatorId: 2, coordinator: "lead" }),
      stopped(2, "2026-08-17T10:00:00.000Z", WATCHING.target),
    ])
    expect(alarms.map((alarm) => [alarm.label, alarm.route])).toEqual([
      ["@bob", { kind: "agent", handle: "bob" }],
      ["#ops", { kind: "channel", name: "ops" }],
    ])
  })
})

describe("workspaceLeadHandles", () => {
  it("collects routed lead participants", () => {
    const base = mockWorkspaces[0]
    const pane = base?.panes[0]
    if (base === undefined || pane === undefined) throw new Error("fixture workspace missing")
    const workspaces: HerdrWorkspaceView[] = [{
      ...base,
      panes: [
        { ...pane, role: "lead", participant: "lead" },
        { ...pane, role: "lead", participant: null },
        { ...pane, role: "worker", participant: "w" },
      ],
    }]
    expect([...workspaceLeadHandles(workspaces)]).toEqual(["lead"])
  })
})

describe("keep-awake API", () => {
  it("decodes the hub's setting payload and uses the keep-awake paths", async () => {
    const requests: Request[] = []
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(JSON.stringify({ setting: { kind: "on", policy: WATCHING } }), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      },
    })
    const set = await api.setAgentKeepAwake("bob", KEEP_AWAKE_DEFAULTS)
    await api.clearChannelKeepAwake("ops")
    expect(set.match({ ok: ({ setting }) => setting.kind, err: () => "error" })).toBe("on")
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["PUT", "/api/keep-awake/agents/bob"],
      ["DELETE", "/api/keep-awake/channels/ops"],
    ])
  })

  it("refuses a malformed state variant", async () => {
    const api = new HttpMsgrApi({
      fetchImpl: async () => new Response(JSON.stringify({ setting: { kind: "on", policy: { ...WATCHING, state: { kind: "asleep" } } } }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      }),
    })
    const read = await api.getAgentKeepAwake("bob")
    expect(read.isErr()).toBe(true)
  })

  it("the mock refuses a coordinator outside the channel", async () => {
    const api = new MockMsgrApi()
    const refused = await api.setChannelKeepAwake("ops", { ...KEEP_AWAKE_DEFAULTS, coordinator: "nobody" })
    expect(refused.isErr()).toBe(true)
    const set = await api.setAgentKeepAwake("planner", KEEP_AWAKE_DEFAULTS)
    expect(set.match({ ok: ({ setting }) => setting.kind, err: () => "error" })).toBe("on")
    const listed = await api.listKeepAwake()
    expect(listed.match({ ok: ({ policies }) => policies.length, err: () => -1 })).toBe(1)
  })
})
