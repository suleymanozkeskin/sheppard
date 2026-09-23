import { describe, expect, test } from "bun:test"

import { HttpMsgrApi } from "@/api/client"
import { ApiConflictError, ApiDecodeError, ApiHttpError, ApiNetworkError, ApiNotFoundError } from "@/api/errors"
import type { FetchImplementation, HerdrPaneView, HerdrWorkspaceView } from "@/api/types"
import { commandWriteFailure, currentAgentPane, focusCommandAgent, messageDestination, promptCommandAgent, sendCommandMessage } from "./execute"
import { COMMAND_MESSAGE_LIMIT } from "./types"

const pane: HerdrPaneView = { agentKind: "codex", agentStatus: "idle", focused: false, label: "worker", paneId: "current-pane", participant: "worker", participantRouteState: "active" }
const workspace: HerdrWorkspaceView = { id: "w1", label: "North", panes: [pane], tabs: [{ id: "current-tab", label: "Work", panes: [pane] }] }

describe("command message writes", () => {
  test("sends exactly once to a named agent, without selecting a group", async () => {
    const calls: string[] = []
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async (input, init) => { calls.push(`${input} ${init?.body}`); return Response.json({ channel: "dm-one", messageId: 1 }) } })
    const result = await sendCommandMessage(api, { kind: "agent", handle: "worker", routeState: "active" }, "  Review this.  ")
    expect(result.isOk()).toBe(true)
    expect(calls).toEqual(['/api/direct {"to":["worker"],"body":"Review this."}'])
    if (result.isOk()) expect(result.value.destination).toEqual({ kind: "conversation", channel: "dm-one" })
  })

  test("a channel send does not join as a hidden side effect", async () => {
    let calls = 0
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async () => { calls += 1; return Response.json({}) } })
    const result = await sendCommandMessage(api, { kind: "channel", channel: "review", membership: "not-joined" }, "Review this.")
    expect(result.isErr()).toBe(true)
    expect(calls).toBe(0)
  })

  test("rejects empty or oversized text before the request", async () => {
    let calls = 0
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async () => { calls += 1; return Response.json({}) } })
    const target = { kind: "agent", handle: "worker", routeState: "active" } as const
    expect((await sendCommandMessage(api, target, " ")).isErr()).toBe(true)
    expect((await sendCommandMessage(api, target, "x".repeat(COMMAND_MESSAGE_LIMIT + 1))).isErr()).toBe(true)
    expect(calls).toBe(0)
  })

  test("network failure reports uncertainty and never retries", async () => {
    let calls = 0
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async () => { calls += 1; throw new TypeError("Connection lost") } })
    const result = await sendCommandMessage(api, { kind: "agent", handle: "worker", routeState: "active" }, "Review this.")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.kind).toBe("outcome-unknown")
    expect(calls).toBe(1)
  })

  test("uses the message endpoint for joined channels and direct groups", async () => {
    const calls: string[] = []
    const fetchImpl: FetchImplementation = async (input) => { calls.push(String(input)); return Response.json({ id: 1, channel: "review", sender: "operator", senderKind: "human", senderAgentKind: null, body: "Ready.", attachments: [], createdAt: "2026-09-24T00:00:00Z" }) }
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl })
    expect((await sendCommandMessage(api, { kind: "channel", channel: "review", membership: "joined" }, "Ready.")).isOk()).toBe(true)
    expect((await sendCommandMessage(api, { kind: "direct", channel: "dm-group", label: "worker, reviewer" }, "Ready.")).isOk()).toBe(true)
    expect(calls).toEqual(["/api/channels/review/messages", "/api/channels/dm-group/messages"])
  })

  test("broadcast uses the workspace endpoint and reports its destination", async () => {
    const calls: string[] = []
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async (input) => { calls.push(String(input)); return Response.json({ channel: "ws-north", messageId: 1, recipients: ["worker"] }) } })
    const result = await sendCommandMessage(api, { kind: "broadcast", workspaceId: "w1", label: "North", recipients: ["worker"] }, "Status update, please.")
    expect(result.isOk()).toBe(true)
    expect(calls).toEqual(["/api/herdr/workspaces/w1/broadcast"])
  })

  test("write failures keep rejection separate from uncertain completion", () => {
    const errors = [
      new ApiNetworkError({ message: "lost", cause: "network" }),
      new ApiDecodeError({ message: "invalid", endpoint: "/api/direct", cause: "json" }),
      new ApiHttpError({ message: "failed", status: 500, body: "" }),
      new ApiHttpError({ message: "rejected", status: 400, body: "" }),
      new ApiNotFoundError({ message: "Target missing", resource: "agent" }),
      new ApiConflictError({ message: "Target changed", resource: "agent" }),
    ]
    expect(errors.map((error) => commandWriteFailure(error).kind)).toEqual(["outcome-unknown", "outcome-unknown", "outcome-unknown", "not-completed", "not-completed", "not-completed"])
  })
})

describe("current terminal targets", () => {
  test("focus refreshes topology and uses the current tab", async () => {
    const calls: string[] = []
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async (input) => { const path = String(input); calls.push(path); return Response.json(path.endsWith("/workspaces") ? { workspaces: [workspace] } : { tabId: "current-tab" }) } })
    const result = await focusCommandAgent(api, "worker")
    expect(calls).toEqual(["/api/herdr/workspaces", "/api/herdr/tabs/current-tab/focus"])
    expect(result.isOk()).toBe(true)
  })

  test("missing and ambiguous agent links stop before terminal input", async () => {
    for (const workspaces of [[], [{ ...workspace, panes: [pane, { ...pane, paneId: "other-pane" }] }]]) {
      const calls: string[] = []
      const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async (input) => { calls.push(String(input)); return Response.json({ workspaces }) } })
      expect((await promptCommandAgent(api, "worker", "Please continue.")).isErr()).toBe(true)
      expect(calls).toEqual(["/api/herdr/workspaces"])
    }
  })

  test("a failed topology read is not reported as a missing agent", async () => {
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async () => { throw new TypeError("offline") } })
    const result = await currentAgentPane(api, "worker")
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.message).toContain("not answering")
  })

  test("terminal input is sent once to the current pane", async () => {
    const calls: string[] = []
    const api = new HttpMsgrApi({ baseUrl: "", fetchImpl: async (input) => { const path = String(input); calls.push(path); return Response.json(path.endsWith("/workspaces") ? { workspaces: [workspace] } : { delivered: true }) } })
    expect((await promptCommandAgent(api, "worker", "Please continue.")).isOk()).toBe(true)
    expect(calls).toEqual(["/api/herdr/workspaces", "/api/herdr/agents/current-pane/prompt"])
  })

  test("inspection destinations preserve each audience", () => {
    expect(messageDestination({ kind: "agent", handle: "worker", routeState: "stale" })).toEqual({ kind: "agent", handle: "worker" })
    expect(messageDestination({ kind: "channel", channel: "review", membership: "joined" })).toEqual({ kind: "channel", channel: "review" })
    expect(messageDestination({ kind: "direct", channel: "dm-group", label: "Group" })).toEqual({ kind: "conversation", channel: "dm-group" })
    expect(messageDestination({ kind: "broadcast", workspaceId: "w1", label: "North", recipients: [] })).toEqual({ kind: "workspace", workspaceId: "w1" })
  })
})
