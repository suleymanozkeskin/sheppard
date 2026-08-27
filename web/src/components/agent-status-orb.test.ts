import { describe, expect, it } from "bun:test"

import { agentOrbState } from "@/agent-status-orb"

describe("agent status orb mapping", () => {
  it("maps working agents to animation and every other status to a paused orb", () => {
    expect(agentOrbState("working")).toBe("working")
    for (const status of ["idle", "done", "blocked", "unknown"] as const) {
      expect(agentOrbState(status)).toBe("static")
    }
  })

  it("uses connecting for spawn and stream transitions", () => {
    expect(agentOrbState("idle", "spawn-awaiting-pane")).toBe("connecting")
    expect(agentOrbState("working", "reconnecting-stream")).toBe("connecting")
    expect(agentOrbState("blocked", "reconnecting-stream")).toBe("static")
  })
})
