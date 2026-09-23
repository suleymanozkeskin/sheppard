import { describe, expect, test } from "bun:test"

import type { HerdrPaneView, HerdrWorkspaceView, Participant } from "@/api/types"
import { agentLocation, commandCatalog, contextCommands, recipientCatalog, type CommandCorpus } from "./catalog"
import { defaultCommands } from "./defaults"
import { directChannelForAgent, matchCommands, parseCommandQuery } from "./search"
import { COMMAND_QUERY_LIMIT, COMMAND_RESULT_LIMIT, COMMAND_SOURCE_LIMIT, commandChoice, commandEntry, messageTargetKey, messageTargetLabel, type CommandEntry } from "./types"

const agent: Participant = { handle: "worker", kind: "agent", agentKind: "codex", routeState: "active" }
const pane: HerdrPaneView = { agentKind: "codex", agentStatus: "working", focused: false, label: "worker", paneId: "p1", participant: "worker", participantRouteState: "active", role: "tester" }
const workspace: HerdrWorkspaceView = { id: "w1", label: "North", panes: [pane], tabs: [{ id: "t1", label: null, panes: [pane] }] }
const corpus: CommandCorpus = {
  channels: [{ id: 1, kind: "chat", name: "review", topic: "Review and verification", memberCount: 2, messageCount: 0, lastMessageAt: null }],
  direct: [{ channel: "dm-group", participants: ["worker", "reviewer"], unread: 2 }],
  participants: [agent], workspaces: [workspace], joinedChannels: new Set(["review"]),
}

function catalog(input: CommandCorpus = corpus): readonly CommandEntry[] {
  const result = commandCatalog(input)
  if (result.isErr()) throw result.error
  return result.value
}

function search(entries: readonly CommandEntry[], input: string) {
  const result = parseCommandQuery(input, "all")
  if (result.isErr()) throw result.error
  return matchCommands(entries, result.value)
}

describe("command discovery", () => {
  test("finds an agent by workspace, harness, role, and live status", () => {
    expect(search(catalog(), "north tester working").entries.map((entry) => entry.id)).toEqual(["agent:worker"])
    expect(search(catalog(), "codex").entries[0]?.id).toBe("agent:worker")
  })

  test("includes unconnected panes without inventing a chat handle", () => {
    const entries = catalog({ ...corpus, participants: [], workspaces: [{ ...workspace, panes: [{ ...pane, participant: null, participantRouteState: null }] }] })
    const entry = entries.find((item) => item.id === "pane:p1")
    expect(entry?.action.kind).toBe("connect")
    expect(entry?.description).toContain("Not connected to chat")
    expect(entry?.alternatives.some((choice) => choice.action.kind === "compose")).toBe(false)
  })

  test("keeps duplicate display names distinct by workspace and pane", () => {
    const entries = catalog({ ...corpus, participants: [], workspaces: [
      { ...workspace, panes: [{ ...pane, participant: null }] },
      { ...workspace, id: "w2", label: "South", panes: [{ ...pane, paneId: "p2", participant: null }] },
    ] })
    expect(search(entries, "worker south").entries.map((entry) => entry.id)).toEqual(["pane:p2"])
  })

  test("uses explicit pane links when the participant read has not caught up", () => {
    expect(catalog({ ...corpus, participants: [] }).find((entry) => entry.id === "agent:worker")).toBeDefined()
  })

  test("does not invent a route state for an incomplete pane link", () => {
    expect(catalog({ ...corpus, participants: [], workspaces: [{ ...workspace, panes: [{ ...pane, participantRouteState: null }] }] }).some((entry) => entry.id === "agent:worker")).toBe(false)
  })

  test("an offline identity still offers messaging but no terminal actions", () => {
    const entry = catalog({ ...corpus, workspaces: [] }).find((item) => item.id === "agent:worker")
    expect(entry?.description).toContain("Not running")
    expect(entry?.alternatives.map((choice) => choice.action.kind)).toEqual(["compose", "navigate"])
  })

  test("ambiguous links never select a terminal", () => {
    const workspaces = [{ ...workspace, panes: [pane, { ...pane, paneId: "p2" }] }]
    expect(agentLocation(workspaces, "worker").kind).toBe("ambiguous")
    const entry = catalog({ ...corpus, workspaces }).find((item) => item.id === "agent:worker")
    expect(entry?.alternatives.map((choice) => choice.action.kind)).toEqual(["compose", "navigate"])
  })

  test("agent locations distinguish missing and running", () => {
    expect(agentLocation([], "worker")).toEqual({ kind: "not-running" })
    expect(agentLocation([workspace], "worker")).toEqual({ kind: "running", pane, workspace })
  })

  test("unjoined channels offer an explicit join action", () => {
    const entry = recipientCatalog(catalog({ ...corpus, joinedChannels: new Set() })).find((item) => item.id === "channel:review")
    expect(entry?.action).toEqual({ kind: "join-channel", channel: "review" })
  })

  test("recipient actions keep direct, group, and channel audiences distinct", () => {
    const entries = recipientCatalog(catalog())
    expect(entries.find((entry) => entry.id === "agent:worker")?.action).toEqual({ kind: "compose", target: { kind: "agent", handle: "worker", routeState: "active" } })
    expect(entries.find((entry) => entry.id === "direct:dm-group")?.action).toEqual({ kind: "compose", target: { kind: "direct", channel: "dm-group", label: "worker, reviewer" } })
    expect(entries.some((entry) => entry.group === "workspace")).toBe(false)
  })

  test("page context never falls back to the previously selected channel", () => {
    expect(contextCommands(catalog(), { kind: "staffing" })).toEqual([])
    expect(contextCommands(catalog(), { kind: "agent", handle: "worker" }).map((entry) => entry.action.kind)).toEqual(["compose", "focus-agent", "prompt-agent"])
  })

  test("rejects an oversized fleet with a specific recovery action", () => {
    const result = commandCatalog({ ...corpus, participants: Array.from({ length: COMMAND_SOURCE_LIMIT + 1 }, () => agent) })
    expect(result.isErr()).toBe(true)
    if (result.isErr()) expect(result.error.message).toContain("directory page")
  })
})

describe("command search", () => {
  test("supports category prefixes without requiring them", () => {
    expect(search(catalog(), "@worker").entries.every((entry) => entry.group === "agent")).toBe(true)
    expect(search(catalog(), "#review").entries.map((entry) => entry.id)).toEqual(["channel:review"])
    expect(search(defaultCommands({ kind: "choose" }), ">spawn").entries[0]?.id).toBe("action:spawn")
  })

  test("parses message intent without executing anything", () => {
    const result = parseCommandQuery("message @worker", "all")
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value).toEqual({ text: "worker", tokens: ["worker"], filter: "agent", intent: "message" })
  })

  test("ranks exact names above supporting text and keeps ties stable", () => {
    const choice = commandChoice("a", "Review tools", "worker", "agent", { kind: "recipients" }, "agent")
    const entries = [commandEntry(choice), commandEntry({ ...choice, id: "b", title: "worker" }), commandEntry({ ...choice, id: "c" })]
    expect(search(entries, "worker").entries.map((entry) => entry.id)).toEqual(["b", "a", "c"])
  })

  test("bounds visible results and reports the number left", () => {
    const choice = commandChoice("a", "worker", "", "agent", { kind: "recipients" }, "agent")
    const entries = Array.from({ length: COMMAND_RESULT_LIMIT + 5 }, (_, index) => commandEntry({ ...choice, id: String(index) }))
    const result = search(entries, "worker")
    expect(result.entries).toHaveLength(COMMAND_RESULT_LIMIT)
    expect(result.remaining).toBe(5)
  })

  test("rejects oversized input and preserves an empty query", () => {
    expect(parseCommandQuery("x".repeat(COMMAND_QUERY_LIMIT + 1), "all").isErr()).toBe(true)
    expect(search(catalog(), " ").total).toBe(catalog().length)
    expect(search(catalog(), "no-such-item").total).toBe(0)
  })

  test("never mistakes a group for a one-to-one conversation", () => {
    expect(directChannelForAgent(corpus.direct, "worker")).toEqual({ kind: "not-started" })
    expect(directChannelForAgent([...corpus.direct, { channel: "dm-worker", participants: ["worker"] }], "worker")).toEqual({ kind: "existing", channel: "dm-worker" })
  })

  test("message labels and keys keep targets separate", () => {
    const targets = [
      { kind: "agent", handle: "worker", routeState: "active" },
      { kind: "channel", channel: "worker", membership: "joined" },
      { kind: "direct", channel: "dm-worker", label: "worker" },
      { kind: "broadcast", workspaceId: "w1", label: "North", recipients: ["worker"] },
    ] as const
    expect(targets.map(messageTargetLabel)).toEqual(["worker", "#worker", "worker", "North"])
    expect(new Set(targets.map(messageTargetKey)).size).toBe(targets.length)
  })
})
