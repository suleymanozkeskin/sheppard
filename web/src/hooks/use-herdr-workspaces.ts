import { Result, TaggedError } from "better-result"
import { useCallback, useEffect, useMemo, useState } from "react"

import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { Channel, HerdrPaneView, HerdrWorkspaceView, MsgrApi, RouteState, WorkspaceList } from "@/api/types"
import { useSettledRouteStates, type RouteObservation } from "@/hooks/use-settled-route-state"

export type WorkspaceLoadState =
  | { status: "loading" }
  | { status: "ready"; errorMessage?: string }
  | { status: "error"; message: string }

export interface HerdrWorkspaceData {
  workspaceChannels: Channel[]
  workspaceChannelsById: Map<string, string>
  workspaces: HerdrWorkspaceView[]
  settledWorkspaces: HerdrWorkspaceView[]
  workspaceState: WorkspaceLoadState
  reloadWorkspaces: () => void
  lastTopologyAt: number | undefined
  topologyStreamState: "connecting" | "live" | "reconnecting" | "degraded" | "offline"
  onTopologyDegraded: (degraded: boolean) => void
  onTopologyError: () => void
  onTopologyOpen: (reconnecting: boolean) => void
  onTopologySnapshot: (snapshot: WorkspaceList) => void
}

class WorkspaceChannelHashError extends TaggedError("WorkspaceChannelHashError")<{
  cause: unknown
  message: string
}> {}

function legacyWorkspaceChannelName(workspace: HerdrWorkspaceView): string {
  const source = workspace.label ?? workspace.id
  const sanitized = source.toLocaleLowerCase().replaceAll(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "")
  return `ws-${(sanitized.length === 0 ? "workspace" : sanitized).slice(0, 29)}`
}

function hashedWorkspaceChannelName(id: string): Promise<Result<string, WorkspaceChannelHashError>> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) {
    return Promise.resolve(Result.err(new WorkspaceChannelHashError({ cause: undefined, message: "Web Crypto is unavailable" })))
  }
  return Result.tryPromise<ArrayBuffer, WorkspaceChannelHashError>({
    try: () => subtle.digest("SHA-256", new TextEncoder().encode(id)),
    catch: (cause) => new WorkspaceChannelHashError({ cause, message: "The workspace channel id could not be derived" }),
  }).then((digest) => digest.map((bytes) => {
    const suffix = [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 28)
    return `ws-${suffix}`
  }))
}

function currentPaneView(pane: HerdrPaneView, settledRouteStates: ReadonlyMap<string, RouteState>): HerdrPaneView {
  if (pane.participant === null || pane.participantRouteState === null) return pane
  const routeState = settledRouteStates.get(`${pane.paneId}\u0000${pane.participant}`) ?? pane.participantRouteState
  switch (routeState) {
    case "active":
      return { ...pane, participantRouteState: routeState }
    case "stale":
      return { ...pane, participant: null, participantRouteState: null, role: null }
  }
}

export function useHerdrWorkspaces(api: MsgrApi, fallback: MsgrApi | undefined): HerdrWorkspaceData {
  const [workspaces, setWorkspaces] = useState<HerdrWorkspaceView[]>([])
  const [workspaceChannels, setWorkspaceChannels] = useState<Channel[]>([])
  const [workspaceChannelsById, setWorkspaceChannelsById] = useState<Map<string, string>>(new Map())
  const [workspaceState, setWorkspaceState] = useState<WorkspaceLoadState>({ status: "loading" })
  const [reloadKey, setReloadKey] = useState(0)
  const [topologyStreamState, setTopologyStreamState] = useState<HerdrWorkspaceData["topologyStreamState"]>("connecting")
  const [lastTopologyAt, setLastTopologyAt] = useState<number | undefined>()

  const routeObservations = useMemo<RouteObservation[]>(
    () => workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => (
      pane.participant === null || pane.participantRouteState === null
        ? []
        : [{ key: `${pane.paneId}\u0000${pane.participant}`, state: pane.participantRouteState }]
    ))),
    [workspaces],
  )
  const settledRouteStates = useSettledRouteStates(routeObservations)
  const settledWorkspaces = useMemo(
    () => workspaces.map((workspace) => ({
      ...workspace,
      panes: workspace.panes.map((pane) => currentPaneView(pane, settledRouteStates)),
      tabs: workspace.tabs.map((tab) => ({
        ...tab,
        panes: tab.panes.map((pane) => currentPaneView(pane, settledRouteStates)),
      })),
    })),
    [settledRouteStates, workspaces],
  )

  const reloadWorkspaces = useCallback(() => setReloadKey((current) => current + 1), [])

  const onTopologyOpen = useCallback((reconnecting: boolean) => {
    setTopologyStreamState("live")
    if (reconnecting) reloadWorkspaces()
  }, [reloadWorkspaces])

  const onTopologySnapshot = useCallback((snapshot: WorkspaceList) => {
    setWorkspaces(snapshot.workspaces)
    setLastTopologyAt(Date.now())
    setWorkspaceState({ status: "ready" })
  }, [])

  const onTopologyError = useCallback(() => {
    setTopologyStreamState("reconnecting")
  }, [])

  const onTopologyDegraded = useCallback((degraded: boolean) => {
    setTopologyStreamState(degraded ? "degraded" : "reconnecting")
  }, [])

  useEffect(() => {
    let mounted = true
    void Promise.all(workspaces.map(async (workspace) => {
      const hashed = await hashedWorkspaceChannelName(workspace.id)
      const hashedName = hashed.match({ ok: (value) => value, err: () => undefined })
      const channel = workspaceChannels.find((candidate) => candidate.name === hashedName)
        ?? workspaceChannels.find((candidate) => candidate.name === legacyWorkspaceChannelName(workspace))
      return channel === undefined ? undefined : { id: workspace.id, name: channel.name }
    })).then((pairs) => {
      if (!mounted) return
      setWorkspaceChannelsById(new Map(pairs.flatMap((pair) => pair === undefined ? [] : [[pair.id, pair.name]])))
    })
    return () => {
      mounted = false
    }
  }, [workspaceChannels, workspaces])

  useEffect(() => {
    let mounted = true
    setWorkspaceState((current) => current.status === "ready" ? current : { status: "loading" })
    void apiCall(api, fallback, (client) => client.listWorkspaces()).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ workspaces: next }) => {
          setWorkspaces(next)
          setLastTopologyAt(Date.now())
          setWorkspaceState({ status: "ready" })
        },
        err: (error) => setWorkspaceState((current) => current.status === "ready"
          ? { ...current, errorMessage: formatApiError(error) }
          : { message: formatApiError(error), status: "error" }),
      })
    })
    void apiCall(api, fallback, (client) => client.listChannels("workspace")).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ channels }) => setWorkspaceChannels(channels),
        err: () => setWorkspaceChannels([]),
      })
    })
    return () => {
      mounted = false
    }
  }, [api, fallback, reloadKey])

  return {
    lastTopologyAt,
    onTopologyDegraded,
    onTopologyError,
    onTopologyOpen,
    onTopologySnapshot,
    reloadWorkspaces,
    settledWorkspaces,
    topologyStreamState,
    workspaceChannels,
    workspaceChannelsById,
    workspaceState,
    workspaces,
  }
}
