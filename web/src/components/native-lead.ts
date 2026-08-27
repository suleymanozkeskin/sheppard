import type { HerdrWorkspaceView, RolePreset } from "../api/types"

export function hasActiveNativeLead(workspace: HerdrWorkspaceView | undefined, role: RolePreset | undefined): boolean {
  if (role?.native !== true || role.name !== "lead" || workspace === undefined) return false
  return workspace.panes.some((pane) => pane.role === "lead" && pane.participant !== null)
}
