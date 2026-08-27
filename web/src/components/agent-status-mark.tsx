import type { HerdrPaneView } from "@/api/types"
import { AgentStatusOrb } from "@/components/agent-status-orb"

export function AgentStatusMark({ size, status }: { size: 64 | 20; status: HerdrPaneView["agentStatus"] }) {
  return (
    <span className="inline-flex shrink-0" data-agent-status-size={size}>
      <AgentStatusOrb ariaLabel={`${status} agent`} size={size} status={status} />
    </span>
  )
}
