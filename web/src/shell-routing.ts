import { useCallback, useEffect, useState } from "react"

export type ShellRoute =
  | { kind: "current" }
  | { kind: "search"; query: string; scope: SearchRouteScope }
  | { kind: "attachments"; scope: AttachmentRouteScope; attachmentKind: AttachmentRouteKind }
  | { kind: "workspaces"; query?: string; filter?: WorkspaceFilter }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "channels"; query?: string; membership?: ChannelMembershipFilter }
  | { kind: "channel"; channel: string; channelKind?: "chat" | "workspace"; messageId?: number }
  | { kind: "direct"; query?: string; filter?: DirectFilter }
  | { kind: "conversation"; channel: string; messageId?: number; query?: string; filter?: DirectFilter }
  | { kind: "agents" }
  | { kind: "agent"; handle: string }
  | { kind: "launchers" }
  | { kind: "create-launcher" }
  | { kind: "edit-launcher"; name: string }
  | { kind: "staffing" }
  | { kind: "create-role" }
  | { kind: "edit-role"; name: string }
  | { kind: "create-model" }
  | { kind: "create-workspace" }
  | { kind: "create-channel" }
  | { kind: "create-direct" }
  | { kind: "spawn-agent"; workspaceId?: string; role?: string; mode?: "add-reporter" }

export type SearchRouteScope = "all" | `channel:${string}`
export type AttachmentRouteScope = "all" | `channel:${string}`
export type AttachmentRouteKind = "all" | "image" | "markdown" | "other"
export type ChannelMembershipFilter = "all" | "joined" | "available"
export type DirectFilter = "unread"
export type WorkspaceFilter = "with-agents" | "needs-attention"

export type ShellNavigate = (route: ShellRoute, replace?: boolean) => void

export interface ShellRouter {
  route: ShellRoute
  navigate: ShellNavigate
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function messageIdFromSearch(search: string): number | undefined {
  const raw = new URLSearchParams(search).get("messageId")
  if (raw === null || raw.length === 0) return undefined
  const messageId = Number(raw)
  return Number.isSafeInteger(messageId) && messageId >= 0 ? messageId : undefined
}

function spawnRouteFromSearch(workspaceId: string | undefined, search: string): ShellRoute {
  const params = new URLSearchParams(search)
  const role = params.get("role") ?? undefined
  const mode = params.get("mode") === "add-reporter" ? "add-reporter" : undefined
  const route: Extract<ShellRoute, { kind: "spawn-agent" }> = { kind: "spawn-agent" }
  if (workspaceId !== undefined) route.workspaceId = workspaceId
  if (role !== undefined) route.role = role
  if (mode !== undefined) route.mode = mode
  return route
}

type ChannelScope = `channel:${string}`

function isChannelScope(value: string): value is ChannelScope {
  return value.startsWith("channel:") && value.length > "channel:".length
}

function routeScopeFromSearch(value: string | null): "all" | ChannelScope {
  return value !== null && isChannelScope(value) ? value : "all"
}

function channelsRouteFromSearch(search: string): Extract<ShellRoute, { kind: "channels" }> {
  const params = new URLSearchParams(search)
  const query = params.get("q")?.trim()
  const rawMembership = params.get("membership")
  const membership: ChannelMembershipFilter | undefined = rawMembership === "joined" || rawMembership === "available"
    ? rawMembership
    : undefined
  const route: Extract<ShellRoute, { kind: "channels" }> = { kind: "channels" }
  if (query !== undefined && query.length > 0) route.query = query
  if (membership !== undefined) route.membership = membership
  return route
}

function workspacesRouteFromSearch(search: string): Extract<ShellRoute, { kind: "workspaces" }> {
  const params = new URLSearchParams(search)
  const query = params.get("q")?.trim()
  const rawFilter = params.get("filter")
  const filter: WorkspaceFilter | undefined = rawFilter === "with-agents" || rawFilter === "needs-attention"
    ? rawFilter
    : undefined
  const route: Extract<ShellRoute, { kind: "workspaces" }> = { kind: "workspaces" }
  if (query !== undefined && query.length > 0) route.query = query
  if (filter !== undefined) route.filter = filter
  return route
}

function directRouteOptions(search: string): Pick<Extract<ShellRoute, { kind: "direct" }>, "query" | "filter"> {
  const params = new URLSearchParams(search)
  const query = params.get("q")?.trim()
  const filter = params.get("filter") === "unread" ? "unread" : undefined
  const options: Pick<Extract<ShellRoute, { kind: "direct" }>, "query" | "filter"> = {}
  if (query !== undefined && query.length > 0) options.query = query
  if (filter !== undefined) options.filter = filter
  return options
}

function routeFromWorkspacePath(item: string | undefined, segments: readonly string[], search: string): ShellRoute {
  switch (item) {
    case undefined:
      return { kind: "workspaces" }
    case "new":
      return { kind: "create-workspace" }
    default:
      switch (segments[2]) {
        case "agents":
          return segments[3] === "new"
            ? spawnRouteFromSearch(decodeSegment(item), search)
            : { kind: "workspace", workspaceId: decodeSegment(item) }
        default:
          return { kind: "workspace", workspaceId: decodeSegment(item) }
      }
  }
}

function routeFromSegments(segments: readonly string[], search: string): ShellRoute {
  const section = segments[0]
  const item = segments[1]
  switch (section) {
    case undefined:
      return { kind: "current" }
    case "search": {
      const params = new URLSearchParams(search)
      const scope = routeScopeFromSearch(params.get("scope"))
      return { kind: "search", query: params.get("q") ?? "", scope }
    }
    case "attachments": {
      const params = new URLSearchParams(search)
      const scope = routeScopeFromSearch(params.get("scope"))
      const rawKind = params.get("kind")
      const attachmentKind: AttachmentRouteKind = rawKind === "image" || rawKind === "markdown" || rawKind === "other"
        ? rawKind
        : "all"
      return { attachmentKind, kind: "attachments", scope }
    }
    case "workspaces":
      return item === undefined
        ? workspacesRouteFromSearch(search)
        : routeFromWorkspacePath(item, segments, search)
    case "channels":
      switch (item) {
        case undefined:
          return channelsRouteFromSearch(search)
        case "new":
          return { kind: "create-channel" }
        default: {
          const channel = decodeSegment(item)
          const messageId = messageIdFromSearch(search)
          const channelKind = new URLSearchParams(search).get("channelKind") === "workspace" ? "workspace" : undefined
          const route: Extract<ShellRoute, { kind: "channel" }> = { channel, kind: "channel" }
          if (channelKind !== undefined) route.channelKind = channelKind
          if (messageId !== undefined) route.messageId = messageId
          return route
        }
      }
    case "direct":
      switch (item) {
        case undefined:
          return { kind: "direct", ...directRouteOptions(search) }
        case "new":
          return { kind: "create-direct" }
        default: {
          const channel = decodeSegment(item)
          const messageId = messageIdFromSearch(search)
          const options = directRouteOptions(search)
          return messageId === undefined
            ? { channel, kind: "conversation", ...options }
            : { channel, kind: "conversation", messageId, ...options }
        }
      }
    case "agents":
      switch (item) {
        case undefined:
          return { kind: "agents" }
        case "new":
        case "spawn": {
          const workspaceId = new URLSearchParams(search).get("workspaceId")
          return spawnRouteFromSearch(workspaceId ?? undefined, search)
        }
        default:
          return { kind: "agent", handle: decodeSegment(item) }
      }
    case "launchers":
      switch (item) {
        case undefined:
          return { kind: "launchers" }
        case "new":
          return { kind: "create-launcher" }
        default:
          return segments[2] === "edit"
            ? { kind: "edit-launcher", name: decodeSegment(item) }
            : { kind: "launchers" }
      }
    case "staffing":
      if (item === undefined) return { kind: "staffing" }
      if (item === "new" || item === "roles" && segments[2] === "new") return { kind: "create-role" }
      if (item === "models" && segments[2] === "new") return { kind: "create-model" }
      if (item === "roles" && segments[2] !== undefined && segments[3] === "edit") return { kind: "edit-role", name: decodeSegment(segments[2]) }
      if (segments[2] === "edit") return { kind: "edit-role", name: decodeSegment(item) }
      return { kind: "staffing" }
    default:
      return { kind: "current" }
  }
}

export function shellRouteFromLocation(location: Pick<Location, "pathname" | "search">): ShellRoute {
  const segments = location.pathname.split("/").filter((segment) => segment.length > 0)
  return routeFromSegments(segments, location.search)
}

export function shellRoutePath(route: ShellRoute): string {
  switch (route.kind) {
    case "current":
      return "/"
    case "search": {
      const params = new URLSearchParams({ q: route.query, scope: route.scope })
      return `/search?${params.toString()}`
    }
    case "attachments": {
      const params = new URLSearchParams({ scope: route.scope, kind: route.attachmentKind })
      return `/attachments?${params.toString()}`
    }
    case "workspaces":
      {
        const params = new URLSearchParams()
        if (route.query !== undefined && route.query.length > 0) params.set("q", route.query)
        if (route.filter !== undefined) params.set("filter", route.filter)
        const search = params.toString()
        return search.length === 0 ? "/workspaces" : `/workspaces?${search}`
      }
    case "workspace":
      return `/workspaces/${encodeURIComponent(route.workspaceId)}`
    case "channels":
      {
        const params = new URLSearchParams()
        if (route.query !== undefined && route.query.length > 0) params.set("q", route.query)
        if (route.membership !== undefined && route.membership !== "all") params.set("membership", route.membership)
        const search = params.toString()
        return search.length === 0 ? "/channels" : `/channels?${search}`
      }
    case "channel":
      {
        const params = new URLSearchParams()
        if (route.messageId !== undefined) params.set("messageId", String(route.messageId))
        if (route.channelKind === "workspace") params.set("channelKind", "workspace")
        const search = params.toString()
        const path = `/channels/${encodeURIComponent(route.channel)}`
        return search.length === 0 ? path : `${path}?${search}`
      }
    case "direct":
      {
        const params = new URLSearchParams()
        if (route.query !== undefined && route.query.length > 0) params.set("q", route.query)
        if (route.filter !== undefined) params.set("filter", route.filter)
        const search = params.toString()
        return search.length === 0 ? "/direct" : `/direct?${search}`
      }
    case "conversation": {
      const params = new URLSearchParams()
      if (route.messageId !== undefined) params.set("messageId", String(route.messageId))
      if (route.query !== undefined && route.query.length > 0) params.set("q", route.query)
      if (route.filter !== undefined) params.set("filter", route.filter)
      const search = params.toString()
      const path = `/direct/${encodeURIComponent(route.channel)}`
      return search.length === 0 ? path : `${path}?${search}`
    }
    case "agents":
      return "/agents"
    case "agent":
      return `/agents/${encodeURIComponent(route.handle)}`
    case "launchers":
      return "/launchers"
    case "create-launcher":
      return "/launchers/new"
    case "edit-launcher":
      return `/launchers/${encodeURIComponent(route.name)}/edit`
    case "create-workspace":
      return "/workspaces/new"
    case "create-channel":
      return "/channels/new"
    case "create-direct":
      return "/direct/new"
    case "spawn-agent":
      {
        const params = new URLSearchParams()
        if (route.workspaceId !== undefined) params.set("workspaceId", route.workspaceId)
        if (route.role !== undefined) params.set("role", route.role)
        if (route.mode !== undefined) params.set("mode", route.mode)
        const query = params.toString()
        const path = route.workspaceId === undefined
          ? "/agents/new"
          : `/workspaces/${encodeURIComponent(route.workspaceId)}/agents/new`
        return query.length === 0 ? path : `${path}?${query}`
      }
    case "staffing":
      return "/staffing"
    case "create-role":
      return "/staffing/roles/new"
    case "edit-role":
      return `/staffing/roles/${encodeURIComponent(route.name)}/edit`
    case "create-model":
      return "/staffing/models/new"
  }
}

export function shellParentRoute(route: ShellRoute): ShellRoute | undefined {
  switch (route.kind) {
    case "current":
      return undefined
    case "search":
    case "attachments":
    case "workspaces":
    case "channels":
    case "direct":
    case "agents":
    case "launchers":
    case "staffing":
      return { kind: "current" }
    case "workspace":
    case "create-workspace":
      return { kind: "workspaces" }
    case "channel":
    case "create-channel":
      return { kind: "channels" }
    case "conversation":
      {
        const parent: Extract<ShellRoute, { kind: "direct" }> = { kind: "direct" }
        if (route.query !== undefined) parent.query = route.query
        if (route.filter !== undefined) parent.filter = route.filter
        return parent
      }
    case "create-direct":
      return { kind: "direct" }
    case "agent":
      return { kind: "agents" }
    case "create-launcher":
    case "edit-launcher":
      return { kind: "launchers" }
    case "create-role":
    case "edit-role":
    case "create-model":
      return { kind: "staffing" }
    case "spawn-agent":
      return route.workspaceId === undefined
        ? { kind: "agents" }
        : { kind: "workspace", workspaceId: route.workspaceId }
  }
}

function initialShellRoute(): ShellRoute {
  if (globalThis.location === undefined) return { kind: "current" }
  return shellRouteFromLocation(globalThis.location)
}

export function useShellRouter(): ShellRouter {
  const [route, setRoute] = useState<ShellRoute>(initialShellRoute)

  useEffect(() => {
    const onPopState = (): void => setRoute(initialShellRoute())
    globalThis.addEventListener("popstate", onPopState)
    return () => globalThis.removeEventListener("popstate", onPopState)
  }, [])

  const navigate = useCallback<ShellNavigate>((next, replace = false) => {
    const path = shellRoutePath(next)
    if (globalThis.history === undefined) {
      setRoute(next)
      return
    }
    const currentPath = globalThis.location === undefined
      ? undefined
      : `${globalThis.location.pathname}${globalThis.location.search}`
    if (currentPath !== path) {
      if (replace) globalThis.history.replaceState(null, "", path)
      else globalThis.history.pushState(null, "", path)
    }
    setRoute(next)
  }, [])

  return { navigate, route }
}
