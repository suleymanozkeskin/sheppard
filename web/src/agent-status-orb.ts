import type { OrbState } from "thinking-orbs"

import type { AgentStatus } from "@/api/types"

export type AgentOrbTrigger = "spawn-awaiting-pane" | "reconnecting-stream"
export type AgentOrbState = Extract<OrbState, "connecting" | "working"> | "static"

export function agentOrbState(status: AgentStatus, trigger?: AgentOrbTrigger): AgentOrbState {
  if (status === "blocked") return "static"
  if (trigger !== undefined) return "connecting"
  return status === "working" ? "working" : "static"
}
