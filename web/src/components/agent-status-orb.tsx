import { useEffect, useRef, useState } from "react"
import { ThinkingOrb, type OrbSize } from "thinking-orbs"

import type { AgentStatus } from "@/api/types"
import { agentOrbState, type AgentOrbState, type AgentOrbTrigger } from "@/agent-status-orb"

interface AgentStatusOrbProps {
  ariaLabel: string
  size: OrbSize
  status: AgentStatus
  trigger?: AgentOrbTrigger
}

export function AgentStatusOrb({ ariaLabel, size, status, trigger }: AgentStatusOrbProps) {
  const state = agentOrbState(status, trigger)
  return <VisibleStatusOrb ariaLabel={ariaLabel} blocked={status === "blocked"} size={size} state={state} />
}

function VisibleStatusOrb({ ariaLabel, blocked, size, state }: { ariaLabel: string; blocked: boolean; size: OrbSize; state: AgentOrbState }) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const [animating, setAnimating] = useState(false)
  const visualState = state === "static" ? "working" : state

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    if (state === "static") {
      setAnimating(false)
      return
    }

    let intersecting = false
    const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
    const updateAnimationState = () => {
      setAnimating(
        intersecting
        && document.visibilityState !== "hidden"
        && reducedMotion?.matches !== true,
      )
    }
    const observerConstructor = globalThis.IntersectionObserver
    const observer = observerConstructor === undefined
      ? undefined
      : new observerConstructor((entries) => {
        intersecting = entries[0]?.isIntersecting === true
        updateAnimationState()
      })
    observer?.observe(host)
    const onVisibilityChange = () => updateAnimationState()
    const onMotionPreferenceChange = () => updateAnimationState()
    document.addEventListener("visibilitychange", onVisibilityChange)
    reducedMotion?.addEventListener("change", onMotionPreferenceChange)
    if (observer === undefined) intersecting = true
    updateAnimationState()

    return () => {
      observer?.disconnect()
      document.removeEventListener("visibilitychange", onVisibilityChange)
      reducedMotion?.removeEventListener("change", onMotionPreferenceChange)
    }
  }, [state])

  return (
    <span className={size === 64 ? "inline-flex size-16 shrink-0 items-center justify-center overflow-hidden" : "inline-flex size-5 shrink-0"} data-orb-slot={size} ref={hostRef}>
      <ThinkingOrb
        aria-label={ariaLabel}
        className={blocked ? "rounded-full ring-2 ring-amber-500/70" : undefined}
        data-agent-orb
        data-orb-alert={blocked ? "amber" : undefined}
        data-orb-animating={animating ? "true" : "false"}
        data-orb-state={state}
        data-orb-visual-state={visualState}
        paused={state === "static" || !animating}
        size={size}
        state={visualState}
        theme="auto"
      />
    </span>
  )
}
