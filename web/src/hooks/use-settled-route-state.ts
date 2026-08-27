import { useEffect, useRef, useState } from "react"

import type { RouteState } from "@/api/types"

export const ROUTE_SETTLE_DELAY_MS = 750

export interface RouteObservation {
  key: string
  state: RouteState
}

interface PendingTransition {
  state: RouteState
  timer: ReturnType<typeof setTimeout>
}

function routeMap(observations: readonly RouteObservation[]): Map<string, RouteState> {
  return new Map(observations.map(({ key, state }) => [key, state]))
}

/**
 * Keeps a route state transition out of the UI until it has held briefly.
 * Initial observations render immediately. A transition that reverses before
 * the delay is cancelled, so transient notifier confirmations do not repaint
 * the visible route badges.
 */
export function useSettledRouteStates(
  observations: readonly RouteObservation[],
  delayMs = ROUTE_SETTLE_DELAY_MS,
): ReadonlyMap<string, RouteState> {
  const initial = routeMap(observations)
  const [settled, setSettled] = useState<ReadonlyMap<string, RouteState>>(initial)
  const settledRef = useRef<Map<string, RouteState>>(initial)
  const pendingRef = useRef<Map<string, PendingTransition>>(new Map())

  const signature = observations
    .map(({ key, state }) => `${key}\u0000${state}`)
    .join("\u0001")
  const observed = routeMap(observations)

  // Route timers are reconciled per key in this effect and cleared by the unmount
  // effect below. A cleanup here would restart unchanged timers on every observation update.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    const pending = pendingRef.current

    for (const [key, transition] of pending) {
      const nextState = observed.get(key)
      if (nextState === undefined || nextState === transition.state) continue
      clearTimeout(transition.timer)
      pending.delete(key)
    }

    const current = settledRef.current
    const next = new Map(current)
    let changed = false

    for (const [key, state] of observed) {
      const settledState = current.get(key)
      if (settledState === undefined) {
        next.set(key, state)
        changed = true
        continue
      }
      if (settledState === state || pending.has(key)) continue

      const timer = setTimeout(() => {
        const transition = pending.get(key)
        if (transition === undefined || transition.state !== state) return
        pending.delete(key)

        const latest = new Map(settledRef.current)
        if (latest.get(key) === state) return
        latest.set(key, state)
        settledRef.current = latest
        setSettled(latest)
      }, delayMs)
      pending.set(key, { state, timer })
    }

    for (const key of current.keys()) {
      if (observed.has(key)) continue
      next.delete(key)
      changed = true
    }

    if (changed) {
      settledRef.current = next
      setSettled(next)
    }
  // `signature` fully represents the key/state pairs used to derive `observed`.
  // Adding the derived map would restart this effect for semantically unchanged arrays.
  // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [delayMs, signature])

  useEffect(() => {
    const pending = pendingRef.current
    return () => {
      for (const transition of pending.values()) clearTimeout(transition.timer)
      pending.clear()
    }
  }, [])

  return settled
}
