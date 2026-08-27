import { describe, expect, test } from "bun:test"

import type { HerdrWorkspaceView } from "@/api/types"
import { compareWorkspaces, paneStatusLabel, unmanagedAgentCount, workspaceDirectoryBudget } from "@/workspace-presentation"

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
    },
    {
      paneId: "pane-unmanaged",
      label: "unmanaged",
      agentKind: "claude",
      agentStatus: "done",
      focused: false,
      participant: null,
      participantRouteState: null,
    },
    {
      paneId: "pane-empty",
      label: "shell",
      agentKind: null,
      agentStatus: "unknown",
      focused: false,
      participant: null,
      participantRouteState: null,
    },
  ],
  tabs: [],
}

describe("workspace presentation", () => {
  test("counts occupied panes without a participant as unmanaged", () => {
    expect(unmanagedAgentCount(workspace)).toBe(1)
    expect(paneStatusLabel(workspace.panes[1]!)).toBe("unmanaged")
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
