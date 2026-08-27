import { lazy, Suspense } from "react"

import genericBotMark from "@/assets/harness-generic-bot.svg"
import type { AgentKind } from "@/api/types"
import { cn } from "@/lib/utils"
import type { IconType } from "@lobehub/icons"

interface AgentMark {
  label: string
  icon: IconType
}

interface AgentAvatarProps {
  agentKind: AgentKind | null
  className?: string
}

const LazyAgentBrand = lazy(() => import("@lobehub/icons").then(({ Claude, Codex, OpenCode, Pi }) => {
  const agentMarks = new Map<string, AgentMark>([
    ["claude", { label: "Claude", icon: Claude.Color }],
    ["codex", { label: "Codex", icon: Codex.Color }],
    ["opencode", { label: "OpenCode", icon: OpenCode }],
    ["pi", { label: "Pi", icon: Pi }],
  ])
  function AgentBrand({ agentKind, className }: { agentKind: string; className?: string }) {
    const mark = agentMarks.get(agentKind)
    if (mark === undefined) return <GenericBotAvatar className={className} />
    const Icon = mark.icon
    return <Icon aria-hidden="true" className={cn("size-5", className)} size={20} title={`${mark.label} harness`} />
  }
  return { default: AgentBrand }
}))

function GenericBotAvatar({ className }: { className?: string }) {
  return <img alt="" aria-hidden="true" className={cn("size-5", className)} height={20} src={genericBotMark} title="generic bot harness" width={20} />
}

export function AgentAvatar({ agentKind, className }: AgentAvatarProps) {
  if (agentKind === null) return <GenericBotAvatar className={className} />
  return (
    <Suspense fallback={<GenericBotAvatar className={className} />}>
      <LazyAgentBrand agentKind={agentKind} className={className} />
    </Suspense>
  )
}
