import { describe, expect, it } from "bun:test"

import { hasActiveNativeLead } from "./native-lead"
import type { HerdrWorkspaceView, RolePreset } from "../api/types"

const nativeLead: RolePreset = { name: "lead", native: true, summary: "Native lead" }
const userLead: RolePreset = { name: "lead", native: false, summary: "User lead" }

function workspace(role: string | null, participant: string | null): HerdrWorkspaceView {
  return {
    id: "workspace-1",
    label: "Workspace",
    panes: [{
      agentKind: "claude",
      agentStatus: "working",
      focused: true,
      label: "lead",
      paneId: "workspace-1:pane-1",
      participant,
      participantRouteState: "active",
      role,
    }],
    tabs: [],
  }
}

describe("native lead spawn guard", () => {
  it("blocks a second native lead when the topology has a live lead", () => {
    expect(hasActiveNativeLead(workspace("lead", "lead"), nativeLead)).toBe(true)
  })

  it("does not block an empty pane, another role, or a user role", () => {
    expect(hasActiveNativeLead(workspace("lead", null), nativeLead)).toBe(false)
    expect(hasActiveNativeLead(workspace("reviewer", "reviewer"), nativeLead)).toBe(false)
    expect(hasActiveNativeLead(workspace("lead", "lead"), userLead)).toBe(false)
  })
})
