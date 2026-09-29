import { describe, expect, test } from "bun:test"

import type { HerdrPaneView, HerdrWorkspaceView } from "@/api/types"
import { compareWorkspaces, connectPaneActionLabel, initialConnectHandle, paneIdentityDetails, paneStatusLabel, suggestedPaneHandle, unmanagedAgentCount, workspaceDirectoryBudget } from "@/workspace-presentation"

const workspace: HerdrWorkspaceView = {
  id: "workspace-test",
  label: "Test",
  panes: [
    {
      paneId: "pane-routed",
      label: "routed",
      agentKind: "codex",
      agentStatus: "idle",
      focused: false,
      participant: "codex-reviewer",
      participantRouteState: "active",
      previousIdentity: { kind: "none" },
    },
    {
      paneId: "pane-unmanaged",
      label: "unmanaged",
      agentKind: "claude",
      agentStatus: "done",
      focused: false,
      participant: null,
      participantRouteState: null,
      previousIdentity: { kind: "none" },
    },
    {
      paneId: "pane-empty",
      label: "shell",
      agentKind: null,
      agentStatus: "unknown",
      focused: false,
      participant: null,
      participantRouteState: null,
      previousIdentity: { kind: "none" },
    },
  ],
  tabs: [],
}

describe("workspace presentation", () => {
  test("keeps runtime status separate from chat linkage", () => {
    expect(unmanagedAgentCount(workspace)).toBe(1)
    expect(paneStatusLabel(workspace.panes[1]!)).toBe("done")
  })

  test("uses a tab label before a terminal title or pane id", () => {
    const pane = { ...workspace.panes[1]!, label: null, title: "repository" }
    const withTab = {
      ...workspace,
      panes: [pane],
      tabs: [{ id: "tab-lead", label: "Lead", panes: [pane] }],
    }
    expect(paneIdentityDetails(pane, withTab)).toEqual({ label: "Lead", source: "tab-label" })
  })

  test("creates a valid default handle from a display label", () => {
    expect(suggestedPaneHandle("SCHMART LEAD", "w1:p3")).toBe("schmart-lead")
    expect(suggestedPaneHandle("1", "w1:p3")).toBe("agent-1")
  })

  test("derives a smaller full-block budget from a shorter page body", () => {
    expect(workspaceDirectoryBudget(900)).toBe(6)
    expect(workspaceDirectoryBudget(600)).toBe(4)
    expect(workspaceDirectoryBudget(900)).not.toBe(workspaceDirectoryBudget(600))
  })

  test("puts stale workspaces first when matched counts tie", () => {
    const active = { ...workspace, id: "active", label: "Active" }
    const stale = {
      ...workspace,
      id: "stale",
      label: "Stale",
      panes: workspace.panes.map((pane) => pane.participant === null ? pane : { ...pane, participantRouteState: "stale" as const }),
    }
    expect([active, stale].toSorted(compareWorkspaces).map(({ id }) => id)).toEqual(["stale", "active"])
  })
})

describe("reconnect after an ended route", () => {
  const base: HerdrPaneView = {
    paneId: "w1:pQ",
    label: "worker pane",
    agentKind: "claude",
    agentStatus: "idle",
    focused: false,
    participant: null,
    participantRouteState: null,
    previousIdentity: { kind: "none" },
  }

  test("starts the connect dialog with the ended identity", () => {
    const ended: HerdrPaneView = { ...base, previousIdentity: { kind: "ended", handle: "claude-personal-worker" } }
    expect(initialConnectHandle(ended, "worker pane")).toBe("claude-personal-worker")
    expect(connectPaneActionLabel(ended, "Connect to chat")).toBe("Reconnect as @claude-personal-worker")
  })

  test("falls back to the label suggestion without an ended identity", () => {
    expect(initialConnectHandle(base, "worker pane")).toBe("worker-pane")
    expect(connectPaneActionLabel(base, "Connect to chat")).toBe("Connect to chat")
  })
})
