import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent, type ReactNode, type RefObject } from "react"
import {
  Bot,
  Hash,
  Inbox,
  Keyboard,
  LoaderCircle,
  MessageCircle,
  MessageCirclePlus,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Radio,
  Search,
  Settings2,
  SquareTerminal,
  Upload,
  UserCog,
  UserRound,
  UserPlus,
  WifiOff,
  X,
} from "lucide-react"
import * as v from "valibot"

import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type { AgentStatus, Channel, DirectConversation, HerdrPaneView, HerdrWorkspaceView, InboxEntry, Member, Participant, SearchResult } from "@/api/types"
import { Button } from "@/components/ui/button"
import { ShellBackLink } from "@/components/shell-back-link"
import type { CreationPagesController } from "@/components/creation-pages"
import { AgentAvatar } from "@/components/agent-avatar"
import { ChannelView } from "@/components/channel-view"
import { AgentStatusOrb } from "@/components/agent-status-orb"
import { KeyboardOverlay } from "@/components/ui/keyboard-overlay"
import { cn } from "@/lib/utils"
import { useComposerAutosize } from "@/hooks/use-composer-autosize"
import { useAppController, type AppController, type MemberAddState, type MessageContextTarget, type WorkspaceActionState } from "@/hooks/use-app-controller"
import type { AttachmentPath } from "@/hooks/use-composer-state"
import type { InboxState } from "@/hooks/use-channel-state"
import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import type { StoredIdentity } from "@/api/identity"
import { useLiveMessages } from "@/hooks/use-live-messages"
import { useKeyboardLayer } from "@/hooks/use-keyboard-dispatcher"
import { useSettledRouteStates, type RouteObservation } from "@/hooks/use-settled-route-state"
import { quickSwitcherEntries, quickSwitcherMatches, type QuickSwitcherEntry } from "@/quick-switcher"
import { shellRoutePath, useShellRouter, type ShellRoute, type ShellRouter } from "@/shell-routing"
import { isThemeMode, type ResolvedTheme, type ThemeMode } from "@/theme"
import {
  agentPaneCount,
  absoluteTimeLabel,
  compareWorkspaces,
  paneIdentity,
  paneStopConfirmation,
  paneStatusLabel,
  paneTitle,
  workspaceLabel as formatWorkspaceLabel,
} from "@/workspace-presentation"
import { SIDEBAR_ROW_HEIGHT_PX } from "@/sidebar-layout"
import {
  ACTION_REGISTRY,
  bindingTitle,
  bindingConflicts,
  comboFromKeyEvent,
  defaultBindings,
  displayBinding,
  isModifierOnlyKey,
  replaceBinding,
  type ActionName,
  type KeyEventLike,
  type KeyboardBindings,
} from "@/keyboard"

const LazyShellPageMain = lazy(() => import("@/components/shell-pages").then(({ ShellPageMain }) => ({ default: ShellPageMain })))
const LazySearchView = lazy(() => import("@/components/search-view").then(({ SearchView }) => ({ default: SearchView })))

function ShellPageLoading() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-shell-page-loading="true">
      <section className="flex min-h-0 flex-1 items-center justify-center p-6" role="status">
        <p className="rounded-xl border border-dashed px-6 py-5 text-sm text-muted-foreground">Loading page…</p>
      </section>
    </main>
  )
}

function creationPagesController(controller: AppController): CreationPagesController {
  return {
    workspaceCwd: controller.workspaceCwd,
    workspaceLabel: controller.workspaceLabel,
    setWorkspaceCwd: controller.setWorkspaceCwd,
    setWorkspaceLabel: controller.setWorkspaceLabel,
    handleWorkspaceCreateSubmit: controller.handleWorkspaceCreateSubmit,
    workspaceCreateState: controller.workspaceCreateState,
    workspaceDirectoryPickerState: controller.workspaceDirectoryPickerState,
    browseWorkspaceDirectory: controller.browseWorkspaceDirectory,
    chooseWorkspaceDirectory: controller.chooseWorkspaceDirectory,
    closeWorkspaceDirectoryPicker: controller.closeWorkspaceDirectoryPicker,
    openWorkspaceDirectoryPicker: controller.openWorkspaceDirectoryPicker,
    createChannelName: controller.createChannelName,
    setCreateChannelName: controller.setCreateChannelName,
    handleCreateChannelSubmit: controller.handleCreateChannelSubmit,
    setCreateChannelTopic: controller.setCreateChannelTopic,
    createChannelState: controller.createChannelState,
    createChannelTopic: controller.createChannelTopic,
    directAttachmentInputOpen: controller.directAttachmentInputOpen,
    directAttachmentPathInput: controller.directAttachmentPathInput,
    directAttachments: controller.directAttachments,
    directBody: controller.directBody,
    handleDirectAttachmentInputChange: controller.handleDirectAttachmentInputChange,
    addDirectAttachmentPath: controller.addDirectAttachmentPath,
    setDirectBody: controller.setDirectBody,
    removeDirectAttachmentPath: controller.removeDirectAttachmentPath,
    toggleDirectAttachmentInput: controller.toggleDirectAttachmentInput,
    setDirectRecipients: controller.setDirectRecipients,
    handleDirectSubmit: controller.handleDirectSubmit,
    participants: controller.participants,
    directRecipients: controller.directRecipients,
    directState: controller.directState,
  }
}

function App() {
  const router = useShellRouter()
  const contextRoute = messageContextRoute(router.route)
  const contextTarget: MessageContextTarget | undefined = contextRoute === undefined
    ? undefined
    : { channel: contextRoute.channel, messageId: contextRoute.messageId }
  const searchRoute = router.route.kind === "search" ? router.route : undefined
  const controller = useAppController(router.navigate, contextTarget, searchRoute)
  return <WorkspaceLayout controller={controller} router={router} />
}

function WorkspaceLayout({ controller, router }: { controller: AppController; router: ShellRouter }) {
  return (
    <div className="relative flex h-screen overflow-hidden bg-muted/30 text-foreground">
      {controller.sidebarHidden ? (
        <aside aria-label="Collapsed sidebar" className="hidden h-full w-10 shrink-0 flex-col items-center border-r bg-sidebar py-2 md:flex" data-sidebar-collapsed="true">
          <Button aria-label="Show sidebar" onClick={controller.toggleSidebar} size="icon-sm" title="Show sidebar (⌘B)" type="button" variant="ghost">
            <PanelLeftOpen aria-hidden="true" />
          </Button>
        </aside>
      ) : (
        <WorkspaceSidebar controller={controller} router={router} />
      )}
      <WorkspaceMain controller={controller} router={router} />
      <WorkspaceOverlays controller={controller} router={router} />
    </div>
  )
}

type SidebarSectionRoute = Extract<ShellRoute, { kind: "workspaces" | "channels" | "direct" | "agents" | "staffing" }>['kind']

const SIDEBAR_QUICK_NAV_ITEMS = [
  { Icon: SquareTerminal, label: "Workspaces", route: "workspaces" },
  { Icon: Bot, label: "Agents", route: "agents" },
  { Icon: Hash, label: "Channels", route: "channels" },
  { Icon: MessageCircle, label: "Direct", route: "direct" },
  { Icon: UserCog, label: "Role presets", route: "staffing" },
] as const

function sidebarSectionForContext(route: ShellRoute, selectedKind: "chat" | "direct" | "workspace" | undefined): SidebarSectionRoute {
  switch (route.kind) {
    case "workspaces":
    case "workspace":
    case "create-workspace":
      return "workspaces"
    case "agents":
    case "agent":
    case "spawn-agent":
    case "launchers":
    case "create-launcher":
    case "edit-launcher":
      return "agents"
    case "staffing":
    case "create-role":
    case "edit-role":
    case "create-model":
      return "staffing"
    case "channels":
    case "channel":
    case "create-channel":
      return "channels"
    case "direct":
    case "conversation":
    case "create-direct":
      return "direct"
    case "current":
    case "search":
    case "attachments":
      switch (selectedKind) {
        case "direct":
          return "direct"
        case "workspace":
          return "workspaces"
        case "chat":
        case undefined:
          return "channels"
      }
  }
}

function sidebarSectionRoute(section: SidebarSectionRoute): Extract<ShellRoute, { kind: SidebarSectionRoute }> {
  switch (section) {
    case "workspaces":
      return { kind: "workspaces" }
    case "agents":
      return { kind: "agents" }
    case "channels":
      return { kind: "channels" }
    case "direct":
      return { kind: "direct" }
    case "staffing":
      return { kind: "staffing" }
  }
}

function shouldHandleClientNavigation(event: MouseEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function SidebarPrimaryLink({ active, Icon, label, route, router }: { active: boolean; Icon: typeof SquareTerminal; label: string; route: SidebarSectionRoute; router: ShellRouter }) {
  const destination = sidebarSectionRoute(route)
  return (
    <Button
      aria-current={active ? "page" : undefined}
      aria-label={`Open ${label}`}
      className="text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground"
      data-quick-nav-item={route}
      onClick={(event) => {
        if (!shouldHandleClientNavigation(event)) return
        event.preventDefault()
        router.navigate(destination)
      }}
      render={<a href={shellRoutePath(destination)} />}
      size="icon-xs"
      title={label}
      variant="ghost"
    >
      <Icon aria-hidden="true" className="size-4" />
    </Button>
  )
}

function SidebarFrame({ activeSection, children, controller, directManager = false, router }: { activeSection: SidebarSectionRoute; children: ReactNode; controller: AppController; directManager?: boolean; router: ShellRouter }) {
  const unread = controller.unreadTotal
  return (
    <aside className="hidden h-full min-h-0 w-72 shrink-0 flex-col border-r bg-sidebar md:flex" data-direct-manager={directManager ? "true" : undefined} data-sidebar-rail>
      <div className="flex h-10 shrink-0 items-center justify-between border-b px-3" data-sidebar-head>
        <p className="font-heading text-sm font-semibold tracking-tight">Sheppard</p>
        <div className="flex items-center gap-1">
          {controller.identity !== null && <Button aria-label={unread === 0 ? "Open inbox" : `Open inbox, ${unread} unread`} className="relative focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1" onClick={() => controller.dispatchAction("inbox.open")} size="icon-xs" title={unread === 0 ? "Inbox" : `${unread} unread`} type="button" variant="ghost">
            <Inbox aria-hidden="true" />
            {unread > 0 && <span aria-hidden="true" className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-sidebar-primary" />}
          </Button>}
          <Button aria-label="Hide sidebar" className="focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1" onClick={controller.toggleSidebar} size="icon-xs" title="Hide sidebar (⌘B)" type="button" variant="ghost">
            <PanelLeftClose aria-hidden="true" />
          </Button>
          <Button aria-label="Open settings" className="focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1" onClick={() => controller.dispatchAction("settings.open")} size="icon-xs" title="Settings" type="button" variant="ghost">
            <Settings2 aria-hidden="true" />
          </Button>
        </div>
      </div>
      <nav aria-label="Primary navigation" className="flex h-8 shrink-0 items-center justify-around gap-1 border-b px-3" data-quick-nav>
        {SIDEBAR_QUICK_NAV_ITEMS.map((item) => <SidebarPrimaryLink {...item} active={activeSection === item.route} key={item.route} router={router} />)}
      </nav>
      <div className="flex min-h-0 flex-1 flex-col" data-sidebar-body>
        {children}
      </div>
    </aside>
  )
}

function SidebarPanelHeader({ count, title }: { count: string; title: string }) {
  return (
    <div className="flex h-12 shrink-0 items-center border-b px-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold">{title}</h2>
        <p className="text-[11px] tabular-nums text-sidebar-foreground/50">{count}</p>
      </div>
    </div>
  )
}

function SidebarSearch({ id, label, onChange, placeholder, value }: { id: string; label: string; onChange: (value: string) => void; placeholder: string; value: string }) {
  return (
    <form className="shrink-0 border-b p-3" onSubmit={(event) => event.preventDefault()} role="search">
      <label className="flex h-8 items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/30 px-2 text-sidebar-foreground/60 focus-within:ring-2 focus-within:ring-sidebar-ring" htmlFor={id}>
        <Search aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="sr-only">{label}</span>
        <input autoComplete="off" className="min-w-0 flex-1 bg-transparent text-xs text-sidebar-foreground outline-none placeholder:text-sidebar-foreground/40 [&::-webkit-search-cancel-button]:appearance-none" id={id} name={id} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} spellCheck={false} type="search" value={value} />
        {value.length > 0 && <Button aria-label={`Clear ${label.toLocaleLowerCase()}`} onClick={() => onChange("")} size="icon-xs" title="Clear search" type="button" variant="ghost"><X aria-hidden="true" /></Button>}
      </label>
    </form>
  )
}

type DirectManagerRoute = Extract<ShellRoute, { kind: "direct" | "conversation" }>

function directRouteWithFilters(route: DirectManagerRoute, query: string, unreadOnly: boolean): DirectManagerRoute {
  const normalizedQuery = query.trim()
  switch (route.kind) {
    case "direct": {
      const next: Extract<ShellRoute, { kind: "direct" }> = { kind: "direct" }
      if (normalizedQuery.length > 0) next.query = normalizedQuery
      if (unreadOnly) next.filter = "unread"
      return next
    }
    case "conversation": {
      const next: Extract<ShellRoute, { kind: "conversation" }> = { channel: route.channel, kind: "conversation" }
      if (route.messageId !== undefined) next.messageId = route.messageId
      if (normalizedQuery.length > 0) next.query = normalizedQuery
      if (unreadOnly) next.filter = "unread"
      return next
    }
  }
}

function directConversationRoute(route: DirectManagerRoute, channel: string, messageId?: number): Extract<ShellRoute, { kind: "conversation" }> {
  const next: Extract<ShellRoute, { kind: "conversation" }> = { channel, kind: "conversation" }
  if (messageId !== undefined) next.messageId = messageId
  if (route.query !== undefined) next.query = route.query
  if (route.filter !== undefined) next.filter = route.filter
  return next
}

type MessageContextRoute = Extract<ShellRoute, { kind: "channel" | "conversation" }> & { messageId: number }

function messageContextRoute(route: ShellRoute): MessageContextRoute | undefined {
  switch (route.kind) {
    case "channel":
    case "conversation":
      if (route.messageId === undefined) return undefined
      return { ...route, messageId: route.messageId }
    default:
      return undefined
  }
}

/**
 * A channel route with no message target. The route names what the page shows,
 * so the destination opens that transcript on arrival rather than a placeholder.
 */
function channelRouteTarget(route: ShellRoute): { channel: string; kind: "chat" | "direct" | "workspace" } | undefined {
  switch (route.kind) {
    case "channel":
      return route.messageId === undefined ? { channel: route.channel, kind: route.channelKind ?? "chat" } : undefined
    case "conversation":
      return route.messageId === undefined ? { channel: route.channel, kind: "direct" } : undefined
    default:
      return undefined
  }
}

function transcriptRoute(channel: string | undefined, kind: "chat" | "workspace" | "direct" | undefined): ShellRoute {
  if (channel === undefined) return { kind: "current" }
  switch (kind) {
    case "direct":
      return { channel, kind: "conversation" }
    case "chat":
      return { channel, kind: "channel" }
    case "workspace":
    case undefined:
      return { kind: "current" }
  }
}

function transcriptParentRoute(route: ShellRoute, selectedKind: "chat" | "workspace" | "direct" | undefined): ShellRoute | undefined {
  switch (route.kind) {
    case "channel":
      return { kind: "channels" }
    case "conversation":
      return { kind: "direct" }
    case "current":
      switch (selectedKind) {
        case "chat":
          return { kind: "channels" }
        case "direct":
          return { kind: "direct" }
        case "workspace":
          return { kind: "workspaces" }
        case undefined:
          return undefined
      }
    default:
      return { kind: "current" }
  }
}

function transcriptParentLabel(destination: ShellRoute | undefined): string {
  switch (destination?.kind) {
    case "channels":
      return "Back to Channels"
    case "direct":
      return "Back to Direct"
    case "workspaces":
      return "Back to Workspaces"
    case "current":
      return "Back to Current View"
    default:
      return "No Previous Page"
  }
}

function searchReturnLabel(destination: ShellRoute): string {
  switch (destination.kind) {
    case "channel":
      return "Back to Channel"
    case "conversation":
      return "Back to Conversation"
    case "workspace":
      return "Back to Workspace"
    default:
      return "Back to Current View"
  }
}

function WorkspaceSidebarPanel({ controller, router }: { controller: AppController; router: ShellRouter }) {
  const [query, setQuery] = useState("")
  const [menu, setMenu] = useState<{ workspaceId: string; x: number; y: number } | undefined>()
  const workspaces = useMemo(
    () => {
      const normalizedQuery = query.trim().toLocaleLowerCase()
      return controller.workspaceData.settledWorkspaces
        .filter((workspace) => normalizedQuery.length === 0
          || formatWorkspaceLabel(workspace).toLocaleLowerCase().includes(normalizedQuery)
          || workspace.id.toLocaleLowerCase().includes(normalizedQuery))
        .toSorted(compareWorkspaces)
    },
    [controller.workspaceData.settledWorkspaces, query],
  )
  const selectedWorkspaceId = router.route.kind === "workspace"
    ? router.route.workspaceId
    : controller.activeWorkspaceId

  useEffect(() => {
    const handleMenuRequest = (event: Event): void => {
      if (!isWorkspaceOrPaneMenuRequest(event) || event.detail.kind !== "workspace") return
      const row = globalThis.document.querySelector<HTMLElement>(`[data-workspace-id="${CSS.escape(event.detail.workspaceId)}"]`)
      const trigger = row?.querySelector<HTMLButtonElement>('[data-menu-trigger="workspace"]')
      if (trigger === null || trigger === undefined) return
      const rect = trigger.getBoundingClientRect()
      setMenu({ workspaceId: event.detail.workspaceId, x: rect.right, y: rect.bottom })
    }
    globalThis.addEventListener("msgr:context-menu", handleMenuRequest)
    return () => globalThis.removeEventListener("msgr:context-menu", handleMenuRequest)
  }, [])

  const menuWorkspace = menu === undefined
    ? undefined
    : controller.workspaceData.settledWorkspaces.find((workspace) => workspace.id === menu.workspaceId)

  return (
    <>
      <SidebarPanelHeader
        count={`${controller.workspaceData.settledWorkspaces.length} workspace${controller.workspaceData.settledWorkspaces.length === 1 ? "" : "s"}`}
        title="Workspaces"
      />
      <SidebarSearch id="sidebar-workspace-search" label="Search workspaces" onChange={setQuery} placeholder="Search workspaces…" value={query} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" data-sidebar-family="workspaces">
        {controller.workspaceData.workspaceState.status === "loading" && <WorkspaceSkeleton />}
        {controller.workspaceData.workspaceState.status === "error" && <SidebarMessageRow role="alert">{controller.workspaceData.workspaceState.message}</SidebarMessageRow>}
        {controller.workspaceData.workspaceState.status === "ready" && controller.workspaceData.workspaceState.errorMessage !== undefined && <SidebarMessageRow role="alert">Workspace refresh failed: {controller.workspaceData.workspaceState.errorMessage}</SidebarMessageRow>}
        {controller.workspaceData.workspaceState.status === "ready" && workspaces.length === 0 && <SidebarMessageRow>{query.length === 0 ? "No workspaces are open." : "No matching workspaces."}</SidebarMessageRow>}
        <nav aria-label="Workspaces">
          {controller.workspaceData.workspaceState.status === "ready" && workspaces.map((workspace) => {
            const label = formatWorkspaceLabel(workspace)
            const agentCount = agentPaneCount(workspace)
            const destination: ShellRoute = { kind: "workspace", workspaceId: workspace.id }
            return (
              <div className="group flex h-10 min-w-0 items-center gap-1 [content-visibility:auto] [contain-intrinsic-size:auto_40px]" data-workspace-id={workspace.id} key={workspace.id} onContextMenu={(event) => { event.preventDefault(); setMenu({ workspaceId: workspace.id, x: event.clientX, y: event.clientY }) }}>
                <a
                  aria-current={selectedWorkspaceId === workspace.id ? "page" : undefined}
                  className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium"
                  href={shellRoutePath(destination)}
                  onClick={(event) => {
                    if (!shouldHandleClientNavigation(event)) return
                    event.preventDefault()
                    controller.openWorkspace(workspace.id)
                    router.navigate(destination)
                  }}
                >
                  <SquareTerminal aria-hidden="true" className="size-3.5 shrink-0 text-sidebar-foreground/50" />
                  <span className="min-w-0 flex-1" data-agent-identity>
                    <span className="block truncate font-medium">{label}</span>
                    <span className="block truncate text-[10px] tabular-nums text-sidebar-foreground/45">{agentCount} agent{agentCount === 1 ? "" : "s"} · {workspace.panes.length} pane{workspace.panes.length === 1 ? "" : "s"}</span>
                  </span>
                </a>
                <Button aria-haspopup="menu" aria-label={`More actions for ${label}`} className="shrink-0 text-sidebar-foreground/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring" data-menu-trigger="workspace" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ workspaceId: workspace.id, x: rect.right, y: rect.bottom }) }} size="icon-xs" title="Workspace actions" type="button" variant="ghost"><MoreHorizontal aria-hidden="true" /></Button>
              </div>
            )
          })}
        </nav>
      </div>
      {menu !== undefined && menuWorkspace !== undefined && (
        <WorkspaceContextMenu
          canWrite={controller.identity !== null}
          onAddReporter={() => { controller.openAddReporter(menuWorkspace.id); setMenu(undefined) }}
          onBroadcast={() => { controller.openWorkspaceBroadcast(menuWorkspace.id); setMenu(undefined) }}
          onClose={() => setMenu(undefined)}
          onCloseWorkspace={() => { controller.openCloseWorkspace(menuWorkspace.id); setMenu(undefined) }}
          onSpawn={() => { controller.openSpawnAgent(menuWorkspace.id); setMenu(undefined) }}
          position={{ x: menu.x, y: menu.y }}
          reporterAvailable={controller.roles.some((role) => role.name === "reporter")}
          workspace={menuWorkspace}
        />
      )}
    </>
  )
}

interface SidebarAgentEntry {
  identity: string
  pane: HerdrPaneView
  workspace: HerdrWorkspaceView
}

const sidebarAgentStatusRank = {
  working: 0,
  blocked: 1,
  idle: 2,
  done: 3,
  unknown: 4,
} satisfies Record<AgentStatus, number>

function AgentSidebarPanel({ controller, router }: { controller: AppController; router: ShellRouter }) {
  const [query, setQuery] = useState("")
  const [menu, setMenu] = useState<{ pane: HerdrPaneView; x: number; y: number } | undefined>()
  const allAgents = useMemo<SidebarAgentEntry[]>(
    () => controller.workspaceData.settledWorkspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.agentKind === null ? [] : [{ identity: paneIdentity(pane, workspace), pane, workspace }])).toSorted((left, right) =>
      sidebarAgentStatusRank[left.pane.agentStatus] - sidebarAgentStatusRank[right.pane.agentStatus]
      || left.identity.localeCompare(right.identity)),
    [controller.workspaceData.settledWorkspaces],
  )
  const agents = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return normalizedQuery.length === 0
      ? allAgents
      : allAgents.filter((entry) => entry.identity.toLocaleLowerCase().includes(normalizedQuery)
        || formatWorkspaceLabel(entry.workspace).toLocaleLowerCase().includes(normalizedQuery)
        || entry.pane.agentKind?.toLocaleLowerCase().includes(normalizedQuery) === true)
  }, [allAgents, query])
  const selectedHandle = router.route.kind === "agent" ? router.route.handle : undefined

  useEffect(() => {
    const handleMenuRequest = (event: Event): void => {
      if (!isWorkspaceOrPaneMenuRequest(event) || event.detail.kind !== "pane") return
      const paneId = event.detail.paneId
      const entry = allAgents.find((candidate) => candidate.pane.paneId === paneId)
      if (entry === undefined) return
      const row = globalThis.document.querySelector<HTMLElement>(`[data-pane-id="${CSS.escape(entry.pane.paneId)}"]`)
      const trigger = row?.querySelector<HTMLButtonElement>('[data-menu-trigger="pane"]')
      if (trigger === null || trigger === undefined) return
      const rect = trigger.getBoundingClientRect()
      setMenu({ pane: entry.pane, x: rect.right, y: rect.bottom })
    }
    globalThis.addEventListener("msgr:context-menu", handleMenuRequest)
    return () => globalThis.removeEventListener("msgr:context-menu", handleMenuRequest)
  }, [allAgents])

  const menuEntry = menu === undefined ? undefined : allAgents.find((entry) => entry.pane.paneId === menu.pane.paneId)

  return (
    <>
      <SidebarPanelHeader
        count={`${allAgents.length} agent${allAgents.length === 1 ? "" : "s"}`}
        title="Agents"
      />
      <SidebarSearch id="sidebar-agent-search" label="Search agents" onChange={setQuery} placeholder="Search agents…" value={query} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" data-sidebar-family="agents">
        {controller.workspaceData.workspaceState.status === "loading" && <WorkspaceSkeleton />}
        {controller.workspaceData.workspaceState.status === "error" && <SidebarMessageRow role="alert">{controller.workspaceData.workspaceState.message}</SidebarMessageRow>}
        {controller.workspaceData.workspaceState.status === "ready" && agents.length === 0 && <SidebarMessageRow>{query.length === 0 ? "No agents are running." : "No matching agents."}</SidebarMessageRow>}
        <nav aria-label="Agents">
          {controller.workspaceData.workspaceState.status === "ready" && agents.map((entry) => {
            const participant = entry.pane.participant
            const linked = participant !== null
            const destination: Extract<ShellRoute, { kind: "agent" }> | undefined = participant !== null
              ? { handle: participant, kind: "agent" }
              : undefined
            const rowClassName = "flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium"
            const rowContents = (
              <>
                <AgentStatusOrb ariaLabel={`Status: ${paneStatusLabel(entry.pane)}`} size={20} status={entry.pane.agentStatus} />
                <AgentAvatar agentKind={entry.pane.agentKind} className="size-4 shrink-0" />
                <span className="min-w-0 flex-1" data-agent-identity>
                  <span className="block truncate font-medium">{entry.identity}</span>
                  <span className="block truncate text-[10px] text-sidebar-foreground/45">{formatWorkspaceLabel(entry.workspace)} · {linked ? paneStatusLabel(entry.pane) : "connect to chat"}</span>
                </span>
              </>
            )
            return (
              <div className="group flex h-10 min-w-0 items-center gap-1 [content-visibility:auto] [contain-intrinsic-size:auto_40px]" data-pane-id={entry.pane.paneId} data-pane-status={paneStatusLabel(entry.pane)} key={`${entry.workspace.id}:${entry.pane.paneId}`} onContextMenu={(event) => { event.preventDefault(); setMenu({ pane: entry.pane, x: event.clientX, y: event.clientY }) }}>
                {destination === undefined
                  ? <button aria-label={`Connect ${entry.identity} to Sheppard chat`} className={rowClassName} onClick={() => controller.openConnectPane(entry.pane, entry.identity)} title={`Connect ${entry.identity} to Sheppard chat`} type="button">{rowContents}</button>
                  : <a aria-current={entry.pane.participant === selectedHandle ? "page" : undefined} className={rowClassName} href={shellRoutePath(destination)} onClick={(event) => { if (!shouldHandleClientNavigation(event)) return; event.preventDefault(); router.navigate(destination) }} title={paneTitle(entry.pane)}>{rowContents}</a>}
                <Button aria-haspopup="menu" aria-label={`More actions for ${entry.identity}`} className="shrink-0 text-sidebar-foreground/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring" data-menu-trigger="pane" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ pane: entry.pane, x: rect.right, y: rect.bottom }) }} size="icon-xs" title="Agent actions" type="button" variant="ghost"><MoreHorizontal aria-hidden="true" /></Button>
              </div>
            )
          })}
        </nav>
      </div>
      {menu !== undefined && menuEntry !== undefined && <PaneContextMenu canWrite={controller.identity !== null} onClose={() => setMenu(undefined)} onClosePane={() => { controller.openClosePane(menu.pane); setMenu(undefined) }} onConnect={() => { controller.openConnectPane(menu.pane, menuEntry.identity); setMenu(undefined) }} onMessage={(handle) => { controller.startDirect(handle); setMenu(undefined) }} onOpenWorkspace={() => { router.navigate({ kind: "workspace", workspaceId: menuEntry.workspace.id }); setMenu(undefined) }} onStopAgent={() => { controller.openStopAgent(menu.pane); setMenu(undefined) }} pane={menu.pane} position={{ x: menu.x, y: menu.y }} />}
    </>
  )
}

function ChannelSidebarPanel({ controller, router }: { controller: AppController; router: ShellRouter }) {
  const [query, setQuery] = useState("")
  const [menu, setMenu] = useState<{ channel: string; x: number; y: number } | undefined>()
  const channels = useMemo(() => {
    if (controller.channelState.status !== "ready") return []
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return controller.channelState.channels
      .filter((channel) => normalizedQuery.length === 0 || channel.name.toLocaleLowerCase().includes(normalizedQuery) || channel.topic?.toLocaleLowerCase().includes(normalizedQuery) === true)
      .toSorted((left, right) => {
        const leftUnread = controller.inboxByChannel.get(left.name)?.unread ?? 0
        const rightUnread = controller.inboxByChannel.get(right.name)?.unread ?? 0
        return rightUnread - leftUnread || (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "") || left.name.localeCompare(right.name)
      })
  }, [controller.channelState, controller.inboxByChannel, query])

  useEffect(() => {
    const handleMenuRequest = (event: Event): void => {
      if (!isChannelMenuRequest(event)) return
      const row = globalThis.document.querySelector<HTMLElement>(`[data-channel-row="${CSS.escape(event.detail.channel)}"]`)
      const trigger = row?.querySelector<HTMLButtonElement>('[data-menu-trigger="channel"]')
      if (trigger === null || trigger === undefined) return
      const rect = trigger.getBoundingClientRect()
      setMenu({ channel: event.detail.channel, x: rect.right, y: rect.bottom })
    }
    globalThis.addEventListener("msgr:context-menu", handleMenuRequest)
    return () => globalThis.removeEventListener("msgr:context-menu", handleMenuRequest)
  }, [])

  return (
    <>
      <SidebarPanelHeader
        count={`${controller.channelState.status === "ready" ? controller.channelState.channels.length : 0} channels`}
        title="Channels"
      />
      <SidebarSearch id="sidebar-channel-search" label="Search channels" onChange={setQuery} placeholder="Search channels…" value={query} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" data-sidebar-family="channels">
        {controller.inboxState.status === "ready" && controller.inboxState.errorMessage !== undefined && <SidebarMessageRow>Unread state unavailable: {controller.inboxState.errorMessage}</SidebarMessageRow>}
        {controller.channelState.status === "loading" && <ChannelSkeleton />}
        {controller.channelState.status === "error" && <SidebarMessageRow role="alert">{controller.channelState.message}<Button className="ms-2 h-6 px-2 text-[11px]" onClick={controller.reload} size="sm" variant="outline">Try again</Button></SidebarMessageRow>}
        {controller.channelState.status === "ready" && controller.channelState.errorMessage !== undefined && <SidebarMessageRow role="alert">Channel refresh failed: {controller.channelState.errorMessage}</SidebarMessageRow>}
        {controller.channelState.status === "ready" && channels.length === 0 && <SidebarMessageRow>{query.length === 0 ? "No channels yet." : "No matching channels."}</SidebarMessageRow>}
        <nav aria-label="Channels">
          {controller.channelState.status === "ready" && channels.map((channel) => {
            const unread = controller.identity === null ? 0 : controller.inboxByChannel.get(channel.name)?.unread ?? 0
            const destination: ShellRoute = { channel: channel.name, kind: "channel" }
            return (
              <div className="group flex h-10 min-w-0 items-center gap-1 [content-visibility:auto] [contain-intrinsic-size:auto_40px]" data-channel-row={channel.name} key={channel.id} onContextMenu={(event) => { event.preventDefault(); controller.setFocusedChannelRow(channel.name); setMenu({ channel: channel.name, x: event.clientX, y: event.clientY }) }}>
                <a aria-current={channel.name === controller.selectedChannel ? "page" : undefined} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium" href={shellRoutePath(destination)} onClick={(event) => { if (!shouldHandleClientNavigation(event)) return; event.preventDefault(); controller.selectChannel(channel.name, "chat"); controller.setFocusedMessageId(undefined); router.navigate(destination) }} onFocus={() => controller.setFocusedChannelRow(channel.name)} onMouseEnter={() => controller.setFocusedChannelRow(channel.name)}>
                  <Hash aria-hidden="true" className="size-3.5 shrink-0 text-sidebar-foreground/50" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{channel.name}</span>
                    <span className="block truncate text-[10px] text-sidebar-foreground/45">{channel.topic?.trim() || (channel.lastMessageAt === null ? "No activity" : relativeActivity(channel.lastMessageAt))}</span>
                  </span>
                  {unread > 0 && <span className="min-w-5 rounded-full bg-sidebar-primary px-1.5 text-center text-[11px] font-semibold leading-5 tabular-nums text-sidebar-primary-foreground">{unread}</span>}
                </a>
                <Button aria-haspopup="menu" aria-label={`More actions for ${channel.name}`} className="shrink-0 text-sidebar-foreground/50 focus-visible:ring-2 focus-visible:ring-sidebar-ring" data-menu-trigger="channel" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ channel: channel.name, x: rect.right, y: rect.bottom }) }} size="icon-xs" title="Channel actions" type="button" variant="ghost"><MoreHorizontal aria-hidden="true" /></Button>
              </div>
            )
          })}
        </nav>
      </div>
      {menu !== undefined && (
        <ChannelContextMenu
          canDelete={controller.channelState.status === "ready" && controller.channelState.channels.some((channel) => channel.name === menu.channel && channel.kind === "chat")}
          channel={menu.channel}
          membership={channelMembershipState(controller.identity, controller.membersByChannel.get(menu.channel))}
          onClose={() => setMenu(undefined)}
          onCopy={() => { controller.copyChannelName(menu.channel); setMenu(undefined) }}
          onDelete={() => { controller.openDeleteChannel(menu.channel); setMenu(undefined) }}
          onJoin={() => { controller.joinChannel(menu.channel); setMenu(undefined) }}
          onLeave={() => { controller.leaveChannel(menu.channel); setMenu(undefined) }}
          onManageMembers={() => { controller.openMembers(menu.channel); setMenu(undefined) }}
          onMarkRead={() => { controller.markChannelRead(menu.channel); setMenu(undefined) }}
          position={{ x: menu.x, y: menu.y }}
        />
      )}
    </>
  )
}

function directSidebarRoute(controller: AppController, route: ShellRoute): DirectManagerRoute {
  switch (route.kind) {
    case "direct":
    case "conversation":
      return route
    default:
      return controller.selectedChannelKind === "direct" && controller.selectedChannel !== undefined
        ? { channel: controller.selectedChannel, kind: "conversation" }
        : { kind: "direct" }
  }
}

function WorkspaceSidebar({ controller, router }: { controller: AppController; router: ShellRouter }) {
  const activeSection = sidebarSectionForContext(router.route, controller.selectedChannelKind)
  switch (activeSection) {
    case "direct":
      return <DirectManagerSidebar controller={controller} route={directSidebarRoute(controller, router.route)} router={router} />
    case "workspaces":
      return <SidebarFrame activeSection="workspaces" controller={controller} router={router}><WorkspaceSidebarPanel controller={controller} router={router} /></SidebarFrame>
    case "agents":
    case "staffing":
      return <SidebarFrame activeSection={activeSection} controller={controller} router={router}><AgentSidebarPanel controller={controller} router={router} /></SidebarFrame>
    case "channels":
      return <SidebarFrame activeSection="channels" controller={controller} router={router}><ChannelSidebarPanel controller={controller} router={router} /></SidebarFrame>
  }
}

type DirectMessageSearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; results: SearchResult[]; truncated: boolean }
  | { status: "error"; message: string }

function DirectManagerSidebar({ controller, route, router }: { controller: AppController; route: DirectManagerRoute; router: ShellRouter }) {
  const {
    api,
    copyChannelName,
    directConversations,
    directListState,
    fallbackApi,
    identity,
    markChannelRead,
    openDeleteChannel,
    selectedChannel,
    selectChannel,
    setFocusedMessageId,
  } = controller
  const query = route.query ?? ""
  const unreadOnly = route.filter === "unread"
  const [menu, setMenu] = useState<{ channel: string; x: number; y: number } | undefined>()
  const [searchRevision, setSearchRevision] = useState(0)
  const [messageSearch, setMessageSearch] = useState<DirectMessageSearchState>({ status: "idle" })

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length === 0) {
      setMessageSearch({ status: "idle" })
      return
    }
    let mounted = true
    setMessageSearch({ status: "loading" })
    const timeout = globalThis.setTimeout(() => {
      void apiCall(api, fallbackApi, (client) => client.search({ kind: "direct", limit: 50, q: normalizedQuery })).then((result) => {
        if (!mounted) return
        result.match({
          ok: ({ results, truncated }) => setMessageSearch({ results, status: "ready", truncated }),
          err: (error) => setMessageSearch({ message: formatApiError(error), status: "error" }),
        })
      })
    }, 180)
    return () => {
      mounted = false
      globalThis.clearTimeout(timeout)
    }
  }, [api, fallbackApi, query, searchRevision])

  const orderedConversations = useMemo(
    () => directConversations.toSorted((left, right) =>
      right.unread - left.unread
      || (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")
      || directConversationLabel(left).localeCompare(directConversationLabel(right))),
    [directConversations],
  )
  const eligibleConversations = useMemo(
    () => unreadOnly ? orderedConversations.filter((conversation) => conversation.unread > 0) : orderedConversations,
    [orderedConversations, unreadOnly],
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matchingConversations = useMemo(
    () => normalizedQuery.length === 0
      ? eligibleConversations
      : eligibleConversations.filter((conversation) =>
        directConversationLabel(conversation).toLocaleLowerCase().includes(normalizedQuery)
        || conversation.channel.toLocaleLowerCase().includes(normalizedQuery)),
    [eligibleConversations, normalizedQuery],
  )
  const eligibleChannels = useMemo(
    () => new Set(eligibleConversations.map((conversation) => conversation.channel)),
    [eligibleConversations],
  )
  const messageResults = messageSearch.status === "ready"
    ? messageSearch.results.filter((result) => eligibleChannels.has(result.channel))
    : []

  const updateRoute = useCallback((nextQuery: string, nextUnreadOnly: boolean) => {
    router.navigate(directRouteWithFilters(route, nextQuery, nextUnreadOnly), true)
  }, [route, router])
  const openConversation = useCallback((channel: string, messageId?: number) => {
    selectChannel(channel, "direct")
    setFocusedMessageId(messageId)
    router.navigate(directConversationRoute(route, channel, messageId))
  }, [route, router, selectChannel, setFocusedMessageId])
  const menuConversation = menu === undefined
    ? undefined
    : directConversations.find((conversation) => conversation.channel === menu.channel)

  return (
    <SidebarFrame activeSection="direct" controller={controller} directManager router={router}>
      <div className="flex min-h-0 flex-1 flex-col" data-sidebar-family="direct">
        <div className="shrink-0 space-y-2 border-b p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold">Direct Messages</h2>
              <p className="text-[11px] tabular-nums text-sidebar-foreground/50">{directConversations.length} conversation{directConversations.length === 1 ? "" : "s"}</p>
            </div>
          </div>

          <form onSubmit={(event) => event.preventDefault()} role="search">
            <label className="flex h-8 items-center gap-2 rounded-md border border-sidebar-border bg-sidebar-accent/30 px-2 text-sidebar-foreground/60 focus-within:ring-2 focus-within:ring-sidebar-ring" htmlFor="direct-manager-search">
              <Search aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="sr-only">Search direct messages</span>
              <input
                autoComplete="off"
                className="min-w-0 flex-1 bg-transparent text-xs text-sidebar-foreground outline-none placeholder:text-sidebar-foreground/40 [&::-webkit-search-cancel-button]:appearance-none"
                id="direct-manager-search"
                name="direct-query"
                onChange={(event) => updateRoute(event.target.value, unreadOnly)}
                placeholder="Search people and messages…"
                spellCheck={false}
                type="search"
                value={query}
              />
              {query.length > 0 && (
                <Button aria-label="Clear direct-message search" onClick={() => updateRoute("", unreadOnly)} size="icon-xs" title="Clear search" type="button" variant="ghost">
                  <X aria-hidden="true" />
                </Button>
              )}
            </label>
          </form>

          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex rounded-md border border-sidebar-border bg-sidebar-accent/20 p-0.5">
              <Button aria-pressed={!unreadOnly} className="h-7 px-2.5 text-xs aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground" onClick={() => updateRoute(query, false)} size="sm" type="button" variant="ghost">All</Button>
              <Button aria-pressed={unreadOnly} className="h-7 px-2.5 text-xs aria-pressed:bg-sidebar-accent aria-pressed:text-sidebar-accent-foreground" onClick={() => updateRoute(query, true)} size="sm" type="button" variant="ghost">Unread</Button>
            </div>
            <p aria-live="polite" className="text-[11px] tabular-nums text-sidebar-foreground/50" role="status">
              {normalizedQuery.length === 0 ? `${matchingConversations.length} shown` : `${matchingConversations.length + messageResults.length} results`}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {identity === null && <p className="px-2 py-4 text-sm text-sidebar-foreground/60">{NOT_CONNECTED_REASON}</p>}
          {identity !== null && directListState.status === "loading" && <div className="flex items-center gap-2 px-2 py-4 text-sm text-sidebar-foreground/60" role="status"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> Loading conversations…</div>}
          {identity !== null && directListState.status === "ready" && directListState.errorMessage !== undefined && <p className="px-2 py-4 text-sm text-destructive" role="alert">{directListState.errorMessage}</p>}

          {directListState.status === "ready" && matchingConversations.length > 0 && (
            <section aria-labelledby="direct-conversation-list-title">
              {normalizedQuery.length > 0 && <h3 className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/50" id="direct-conversation-list-title">Conversations</h3>}
              <ul aria-label="Direct conversations" role="list">
                {matchingConversations.map((conversation) => {
                  const label = directConversationLabel(conversation)
                  const destination = directConversationRoute(route, conversation.channel)
                  return (
                    <li className="group flex min-w-0 items-center [content-visibility:auto] [contain-intrinsic-size:auto_48px]" data-channel-row={conversation.channel} key={conversation.channel}>
                      <a
                        aria-current={conversation.channel === selectedChannel ? "page" : undefined}
                        className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1 aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground"
                        href={shellRoutePath(destination)}
                        onClick={(event) => { if (!shouldHandleClientNavigation(event)) return; event.preventDefault(); openConversation(conversation.channel) }}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-foreground/70"><MessageCircle aria-hidden="true" className="size-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{label}</span>
                          <span className="block truncate text-[11px] text-sidebar-foreground/50">{conversation.lastMessageAt === undefined || conversation.lastMessageAt === null ? "No activity" : relativeActivity(conversation.lastMessageAt)}</span>
                        </span>
                        {conversation.unread > 0 && <span className="min-w-5 rounded-full bg-sidebar-primary px-1.5 text-center text-[11px] font-semibold leading-5 tabular-nums text-sidebar-primary-foreground">{conversation.unread}</span>}
                      </a>
                      <Button aria-haspopup="menu" aria-label={`Actions for ${label}`} className="shrink-0 text-sidebar-foreground/50 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); setMenu({ channel: conversation.channel, x: rect.right, y: rect.bottom }) }} size="icon-xs" title="Conversation actions" type="button" variant="ghost"><MoreHorizontal aria-hidden="true" /></Button>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {normalizedQuery.length > 0 && (
            <section aria-labelledby="direct-message-results-title" className="mt-2 border-t border-sidebar-border pt-2">
              <h3 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/50" id="direct-message-results-title">Messages</h3>
              {messageSearch.status === "loading" && <p className="flex items-center gap-2 px-2 py-3 text-xs text-sidebar-foreground/60" role="status"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> Searching messages…</p>}
              {messageSearch.status === "error" && <div className="px-2 py-3" role="alert"><p className="text-xs text-destructive">{messageSearch.message}</p><Button className="mt-2" onClick={() => setSearchRevision((revision) => revision + 1)} size="sm" type="button" variant="outline">Try Again</Button></div>}
              {messageSearch.status === "ready" && messageResults.length === 0 && <p className="px-2 py-3 text-xs text-sidebar-foreground/60">No messages match this search.</p>}
              {messageSearch.status === "ready" && messageResults.length > 0 && (
                <ul aria-label="Direct-message search results" role="list">
                  {messageResults.map((result) => {
                    const conversation = directConversations.find((candidate) => candidate.channel === result.channel)
                    const label = conversation === undefined ? result.channel : directConversationLabel(conversation)
                    const destination = directConversationRoute(route, result.channel, result.messageId)
                    return (
                      <li className="[content-visibility:auto] [contain-intrinsic-size:auto_64px]" key={result.messageId}>
                        <a className="block w-full min-w-0 rounded-md px-2 py-2 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-1" href={shellRoutePath(destination)} onClick={(event) => { if (!shouldHandleClientNavigation(event)) return; event.preventDefault(); openConversation(result.channel, result.messageId) }}>
                          <span className="flex min-w-0 items-center gap-2 text-[11px] text-sidebar-foreground/50"><span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground">{label}</span><time className="shrink-0 tabular-nums" dateTime={result.createdAt} title={absoluteTimeLabel(result.createdAt)}>{relativeActivity(result.createdAt)}</time></span>
                          <span className="mt-0.5 block line-clamp-2 break-words text-xs text-sidebar-foreground/70"><span className="font-medium">{result.sender}:</span> {result.snippet}</span>
                        </a>
                      </li>
                    )
                  })}
                </ul>
              )}
              {messageSearch.status === "ready" && messageSearch.truncated && <p className="px-2 py-2 text-[11px] text-sidebar-foreground/50">Showing the first 50 message results. Refine the search to narrow the list.</p>}
            </section>
          )}

          {directListState.status === "ready" && normalizedQuery.length === 0 && matchingConversations.length === 0 && <p className="px-2 py-4 text-sm text-sidebar-foreground/60">{unreadOnly ? "No unread conversations." : "No direct conversations."}</p>}
          {directListState.status === "ready" && normalizedQuery.length > 0 && matchingConversations.length === 0 && messageSearch.status === "ready" && messageResults.length === 0 && <p className="px-2 py-4 text-sm text-sidebar-foreground/60">No direct messages match this search.</p>}
        </div>
      </div>

      {menu !== undefined && menuConversation !== undefined && (
        <ContextMenu
          items={[
            { action: () => { markChannelRead(menu.channel); setMenu(undefined) }, disabled: menuConversation.unread === 0, id: "mark-read", label: "Mark as read" },
            { action: () => { copyChannelName(menu.channel); setMenu(undefined) }, id: "copy-id", label: "Copy conversation ID" },
            { action: () => { openDeleteChannel(menu.channel); setMenu(undefined) }, destructive: true, disabled: identity === null, id: "delete", label: "Delete conversation", title: identity === null ? NOT_CONNECTED_REASON : "Deletes this conversation for all participants" },
          ]}
          kind="direct"
          label={`Actions for ${directConversationLabel(menuConversation)}`}
          onClose={() => setMenu(undefined)}
          position={{ x: menu.x, y: menu.y }}
        />
      )}
    </SidebarFrame>
  )
}

function SidebarMessageRow({ children, role, surfaceKind }: { children: ReactNode; role?: "alert"; surfaceKind?: "empty-state" }) {
  return (
    <div className="flex h-6 min-w-0 items-center overflow-hidden rounded-md px-2 text-[11px] text-sidebar-foreground/60" data-sidebar-row="message" data-sidebar-row-height={SIDEBAR_ROW_HEIGHT_PX} data-surface-kind={surfaceKind} role={role}>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

function WorkspaceMain({ controller, router }: { controller: AppController; router: ShellRouter }) {
  const [channelMenu, setChannelMenu] = useState<{ x: number; y: number } | undefined>()
  const {
    activeWorkspaceId,
    activeChannel,
    activeDirect,
    api,
    ackScheduler,
    attachmentInputOpen,
    attachmentPathInput,
    attachmentPathRef,
    attachments,
    composerRef,
    composerState,
    copyChannelName,
    channelState,
    draft,
    dispatchAction,
    directConversations,
    directListState,
    fallbackApi,
    focusedMessageId,
    handleComposerChange,
    handleAttachmentInputChange,
    handleAttachmentInputSubmit,
    handleDropFiles,
    handleComposerSubmit,
    identity,
    isSelectedMember,
    joinSelectedChannel,
    leaveChannel,
    markChannelRead,
    membersByChannel,
    membersState,
    messageState,
    reload,
    reloadChannels,
    removeAttachmentPath,
    runSearch,
    searchActive,
    searchInputRef,
    searchQuery,
    searchResults,
    searchScope,
    searchState,
    searchNotice,
    selectedResultId,
    selectedChannel,
    selectedChannelKind,
    selectedCursorId,
    selectedInbox,
    selectedMembers,
    selectedMessages,
    startDirect,
    receiptUpdates,
    receiptUpdatesChannel,
    receiptReloadKey,
    setFocusedMessageId,
    setSearchQuery,
    setSearchScope,
    staleMemberCount,
    streamState,
    unread,
    workspaceData,
    openWorkspaceBroadcast,
    openChannelContext,
    openDeleteChannel,
    openMembers,
    openSearchResult,
    openSearch,
    retrySearch,
    searchTruncated,
    participants,
    participantsState,
    selectChannel,
  } = controller
  const activeWorkspace = workspaceData.settledWorkspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const activeWorkspaceChannel = activeWorkspace === undefined
    ? undefined
    : controller.workspaceHistoryChannels.get(activeWorkspace.id) ?? workspaceData.workspaceChannelsById.get(activeWorkspace.id)
  const selectedChannelIsNonMember = identity !== null
    && selectedChannelKind === "chat"
    && selectedChannel !== undefined
    && membersByChannel.has(selectedChannel)
    && membersState.status === "ready"
    && membersState.errorMessage === undefined
    && !isSelectedMember
  const activeParticipantHandles = useMemo(
    () => new Set(participants.map((participant) => participant.handle)),
    [participants],
  )
  const receiptRouteStates = useMemo(
    () => new Map(selectedMembers.map((member) => [member.handle, member.routeState] as const)),
    [selectedMembers],
  )
  const inactiveDirectParticipants = participantsState.status === "ready" && participantsState.errorMessage === undefined
    ? activeDirect?.participants.filter((handle) => !activeParticipantHandles.has(handle)) ?? []
    : []
  const directReadOnly = inactiveDirectParticipants.length > 0
  const directReadOnlyReason = directReadOnly
    ? `This conversation includes a deactivated participant: ${inactiveDirectParticipants.join(", ")}. History remains readable.`
    : "Hub unreachable. Start msgr serve, then retry."
  const staleDirectHandles = selectedMembers.flatMap((member) => member.routeState === "stale" ? [member.handle] : [])
  const composerPlaceholder = selectedChannel === undefined
    ? "Select a channel to write"
    : activeDirect === undefined
    ? `Message ${displayStorageChannelLabel(selectedChannel)}`
    : `Message ${directConversationLabel(activeDirect)}`
  const searchChannelLabel = useCallback((channel: string): string => {
    const direct = directConversations.find((conversation) => conversation.channel === channel)
    if (direct !== undefined) {
      const label = directConversationLabel(direct)
      return label === "Direct conversation" ? label : `Direct · ${label}`
    }
    const workspaceId = [...workspaceData.workspaceChannelsById.entries()]
      .find(([, channelName]) => channelName === channel)?.[0]
    if (workspaceId !== undefined) {
      const workspace = workspaceData.workspaces.find((candidate) => candidate.id === workspaceId)
      if (workspace !== undefined) return `Workspace · ${formatWorkspaceLabel(workspace)}`
    }
    return displayStorageChannelLabel(channel)
  }, [directConversations, workspaceData.workspaceChannelsById, workspaceData.workspaces])
  const currentParent = transcriptParentRoute(router.route, selectedChannelKind)
  const searchReturnRoute = transcriptRoute(selectedChannel, selectedChannelKind)

  const contextRoute = messageContextRoute(router.route)
  const contextChannel = contextRoute?.channel
  const contextMessageId = contextRoute?.messageId
  const contextChannelKind = contextRoute?.kind === "conversation" ? "direct" : contextRoute?.channelKind ?? "chat"
  useEffect(() => {
    if (contextChannel === undefined || contextMessageId === undefined) return
    openChannelContext(contextChannel, contextMessageId, contextChannelKind)
  }, [contextChannel, contextChannelKind, contextMessageId, openChannelContext])

  const arrivalRoute = channelRouteTarget(router.route)
  const arrivalChannel = arrivalRoute?.channel
  const arrivalKind = arrivalRoute?.kind
  useEffect(() => {
    if (arrivalChannel === undefined || arrivalKind === undefined) return
    selectChannel(arrivalChannel, arrivalKind)
    setFocusedMessageId(undefined)
  }, [arrivalChannel, arrivalKind, selectChannel, setFocusedMessageId])

  useEffect(() => {
    if (router.route.kind !== "direct" || activeDirect !== undefined || directListState.status !== "ready") return
    const conversation = directConversations.toSorted((left, right) =>
      right.unread - left.unread
      || (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "")
      || left.channel.localeCompare(right.channel))[0]
    if (conversation === undefined) return
    selectChannel(conversation.channel, "direct")
    setFocusedMessageId(undefined)
  }, [activeDirect, directConversations, directListState.status, router.route.kind, selectChannel, setFocusedMessageId])

  const searchRoute = router.route.kind === "search" ? router.route : undefined
  if (searchRoute !== undefined) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-shell-page="search" data-shell-route={shellRoutePath(searchRoute)}>
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-4">
          <ShellBackLink destination={searchReturnRoute} label={searchReturnLabel(searchReturnRoute)} navigate={router.navigate} />
          <h1 className="truncate text-base font-semibold">Search</h1>
        </header>
        <section className="min-h-0 flex-1 overflow-y-auto" data-page-content="search">
          <Suspense fallback={<ShellPageLoading />}>
            <LazySearchView
              channelLabel={searchChannelLabel}
              onClose={() => router.navigate(searchReturnRoute)}
              onQueryChange={setSearchQuery}
              onRetry={retrySearch}
              onShowAttachments={(result) => router.navigate({ attachmentKind: "all", kind: "attachments", scope: `channel:${result.channel}` })}
              onScopeChange={setSearchScope}
              onSelect={openSearchResult}
              onSubmit={retrySearch}
              query={searchRoute.query}
              queryInputRef={searchInputRef}
              results={searchResults}
              scope={searchScope}
              selectedResultId={selectedResultId}
              state={searchState}
              truncated={searchTruncated}
              notice={searchNotice}
            />
          </Suspense>
        </section>
      </main>
    )
  }

  if (router.route.kind === "direct" && activeDirect === undefined) {
    return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-background" data-shell-page="direct" data-shell-route="/direct">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur">
          <ShellBackLink destination={{ kind: "current" }} label="Back to Current View" navigate={router.navigate} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold">Direct</h1>
            <p className="truncate text-xs text-muted-foreground">Private conversations</p>
          </div>
          <Button disabled={identity === null} onClick={() => startDirect()} size="sm" title={identity === null ? NOT_CONNECTED_REASON : "Start direct message"} type="button" variant="outline">
            <MessageCirclePlus aria-hidden="true" />
            <span className="hidden sm:inline">New Message</span>
            <span className="sm:hidden">New</span>
          </Button>
        </header>
        <section className="flex min-h-0 flex-1 items-center justify-center p-6" data-page-content="direct">
          {directListState.status === "loading" && (
            <div aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
              Loading conversations…
            </div>
          )}
          {directListState.status === "disabled" && (
            <div className="max-w-sm text-center">
              <MessageCircle aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
              <h2 className="mt-3 text-sm font-semibold">Direct Messages Unavailable</h2>
              <p className="mt-1 text-sm text-muted-foreground">{NOT_CONNECTED_REASON}</p>
            </div>
          )}
          {directListState.status === "ready" && directListState.errorMessage !== undefined && (
            <div className="max-w-sm text-center" role="alert">
              <p className="text-sm text-destructive">{directListState.errorMessage}</p>
              <Button className="mt-3" onClick={reload} size="sm" type="button" variant="outline">Try Again</Button>
            </div>
          )}
          {directListState.status === "ready" && directListState.errorMessage === undefined && directConversations.length === 0 && (
            <div className="max-w-sm text-center">
              <MessageCircle aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
              <h2 className="mt-3 text-sm font-semibold">No Direct Messages</h2>
              <p className="mt-1 text-sm text-muted-foreground">Start a conversation with a person or agent.</p>
              <Button className="mt-4" disabled={identity === null} onClick={() => startDirect()} size="sm" type="button">
                <MessageCirclePlus aria-hidden="true" /> Start Direct Message
              </Button>
            </div>
          )}
        </section>
      </main>
    )
  }

  if (router.route.kind !== "current" && router.route.kind !== "direct" && contextRoute === undefined && arrivalRoute === undefined) {
    return (
      <Suspense fallback={<ShellPageLoading />}>
        <LazyShellPageMain creation={creationPagesController(controller)} controller={controller} navigate={router.navigate} route={router.route} />
      </Suspense>
    )
  }

  return (
      <main className="flex min-h-0 min-w-0 flex-1 flex-col" data-shell-page={router.route.kind === "direct" ? "direct" : "current"} data-shell-route={shellRoutePath(router.route)}>
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur">
          <ShellBackLink destination={currentParent} label={transcriptParentLabel(currentParent)} navigate={router.navigate} />
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {activeWorkspace !== undefined ? (
              <SquareTerminal className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : activeDirect === undefined ? (
              <Hash className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <MessageCircle className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold">
                {searchActive ? "Search" : activeWorkspace !== undefined ? activeWorkspace.label ?? activeWorkspace.id : activeDirect === undefined ? activeChannel?.kind === "workspace" ? displayStorageChannelLabel(activeChannel.name) : activeChannel?.name ?? (selectedChannel === undefined ? "Channels" : displayStorageChannelLabel(selectedChannel)) : directConversationLabel(activeDirect)}
              </h1>
              <p className="hidden truncate text-xs text-muted-foreground sm:block">
                {searchActive
                  ? "Search all visible channels"
                  : activeDirect === undefined
                  ? activeWorkspace !== undefined ? `${activeWorkspace.panes.length} panes` : activeChannel === undefined ? "Select a channel to view messages" : activeChannel.topic ?? "No topic"
                  : "Direct conversation"}
              </p>
            </div>
          </div>
          <form
            className="hidden w-80 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-muted-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 sm:flex lg:w-96"
            onSubmit={(event) => {
              event.preventDefault()
              runSearch(searchQuery, searchScope)
            }}
          >
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <label className="sr-only" htmlFor="message-search">
              Search messages
            </label>
            <input
              aria-label="Search messages"
              className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              id="message-search"
              ref={searchInputRef}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                switch (event.key) {
                  case "Escape":
                    event.preventDefault()
                    event.currentTarget.blur()
                    setSearchQuery("")
                    return
                  case "Enter":
                    event.preventDefault()
                    runSearch(searchQuery, searchScope)
                    return
                  default:
                    return
                }
              }}
            placeholder={searchScope === "all" ? "Search all messages…" : "Search this chat…"}
            type="search"
            value={searchQuery}
          />
            <button
              aria-label={searchScope === "all" ? "Search scope: all channels" : "Search scope: current channel"}
              className="h-6 shrink-0 rounded border bg-background px-1.5 text-[10px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-search-header-scope={searchScope}
              onClick={() => setSearchScope(searchScope === "all" ? "channel" : "all")}
              title="Change search scope (S)"
              type="button"
            >
              {searchScope === "all" ? "All" : "Chat"}
            </button>
            <kbd className="hidden rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground lg:inline-flex">
              /
            </kbd>
          </form>
          <Button aria-label="Search messages" className="sm:hidden" onClick={openSearch} size="icon-sm" title="Search messages" variant="ghost">
            <Search aria-hidden="true" />
          </Button>
          {router.route.kind === "direct" && (
            <Button disabled={identity === null} onClick={() => startDirect()} size="sm" title={identity === null ? NOT_CONNECTED_REASON : "Start direct message"} type="button" variant="outline">
              <MessageCirclePlus aria-hidden="true" />
              <span className="hidden lg:inline">New Message</span>
            </Button>
          )}
          {identity === null && <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">Read only</span>}
        </header>

        {activeWorkspace === undefined && activeDirect !== undefined && <div className="flex h-9 shrink-0 items-center justify-between border-b bg-background px-4 text-xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
            <UserRound aria-hidden="true" className="size-3.5 shrink-0" />
            {activeDirect.participants.join(", ")}
            {selectedMembers.length > 0 && <span className="ml-1">· {selectedMembers.length} member{selectedMembers.length === 1 ? "" : "s"}</span>}
            {selectedMembers.length > 0 && <span className={staleMemberCount > 0 ? "ml-1 text-amber-700 dark:text-amber-400" : "ml-1 text-emerald-700 dark:text-emerald-400"}>· {staleMemberCount > 0 ? `${staleMemberCount} inactive chat route${staleMemberCount === 1 ? "" : "s"}` : "all chat routes active"}</span>}
          </span>
          <span className="inline-flex items-center gap-1.5" data-stream-state={streamState}>
            {streamState === "live" && <Radio className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
            {streamState === "reconnecting" && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
            {streamState === "degraded" && <WifiOff className="size-3.5 text-amber-600" aria-hidden="true" />}
            {streamState === "offline" && <WifiOff className="size-3.5" aria-hidden="true" />}
            {streamStateLabel(streamState)}
          </span>
        </div>}
        {activeWorkspace === undefined && activeDirect === undefined && <div className="flex h-9 shrink-0 items-center justify-between gap-3 border-b bg-background px-4 text-xs text-muted-foreground" data-membership={selectedChannelIsNonMember ? "non-member" : undefined}>
          <div className="flex min-w-0 items-center gap-3">
            <Button
              aria-label={`Show ${activeChannel?.memberCount ?? selectedMembers.length} channel members`}
              className="-mx-2 h-auto shrink-0 gap-1.5 px-2 py-1 text-xs font-normal text-muted-foreground"
              onClick={() => dispatchAction("channel.members")}
              variant="ghost"
            >
              <UserRound aria-hidden="true" className="size-3.5" />
              {activeChannel?.memberCount ?? selectedMembers.length} members
              {identity !== null && membersState.status === "ready" && staleMemberCount > 0 && (
                <span className="ml-2 text-amber-700 dark:text-amber-400">
                  · {staleMemberCount} inactive agent route{staleMemberCount === 1 ? "" : "s"}
                </span>
              )}
              {membersState.status === "ready" && membersState.errorMessage !== undefined && (
                <span className="ml-2 text-destructive">· {membersState.errorMessage}</span>
              )}
            </Button>
            {activeChannel !== undefined && (
              <>
                <Button
                  aria-label="Open channel attachments"
                  data-channel-attachments
                  onClick={() => router.navigate({ attachmentKind: "all", kind: "attachments", scope: `channel:${activeChannel.name}` })}
                  size="icon-sm"
                  title="Open channel attachments"
                  type="button"
                  variant="ghost"
                >
                  <Paperclip aria-hidden="true" />
                </Button>
                <Button
                  aria-expanded={channelMenu !== undefined}
                  aria-haspopup="menu"
                  aria-label={`Manage ${activeChannel.name}`}
                  data-channel-manage={activeChannel.name}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect()
                    setChannelMenu({ x: rect.left, y: rect.bottom })
                  }}
                  size="sm"
                  title={`Manage ${activeChannel.name}`}
                  type="button"
                  variant="ghost"
                >
                  <MoreHorizontal aria-hidden="true" />
                  Manage
                </Button>
              </>
            )}
            {selectedChannelIsNonMember && (
              <div className="flex min-w-0 items-center gap-2 text-amber-700 dark:text-amber-300">
                <span className="min-w-0 truncate" data-membership-message role="status">
                  You have not joined this channel. Join it to track unread and post.
                </span>
                <Button aria-label="Join channel" onClick={joinSelectedChannel} size="sm" type="button" variant="outline">Join</Button>
              </div>
            )}
          </div>
          <span className="inline-flex items-center gap-1.5" data-stream-state={streamState}>
            {streamState === "live" && <Radio className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
            {streamState === "reconnecting" && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
            {streamState === "degraded" && <WifiOff className="size-3.5 text-amber-600" aria-hidden="true" />}
            {streamState === "offline" && <WifiOff className="size-3.5" aria-hidden="true" />}
            {streamStateLabel(streamState)}
            {identity !== null && selectedInbox?.pushEnabled && <span className="ml-2">· push enabled</span>}
          </span>
        </div>}

        <ChannelDropZone
          conversationSurface={activeWorkspace === undefined && activeDirect !== undefined}
          enabled={!searchActive && identity !== null && activeWorkspace === undefined && selectedChannel !== undefined && channelState.status !== "error" && !directReadOnly}
          onDropFiles={handleDropFiles}
        >
    <section className="flex min-h-0 flex-1 flex-col">
          {activeWorkspace === undefined && activeDirect !== undefined && staleDirectHandles.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200 sm:px-8" data-direct-delivery-warning role="status">
              <p className="min-w-0" data-direct-delivery-consequence>
                {staleDirectHandles.length === 1
                  ? `${staleDirectHandles[0]} has no active chat route.`
                  : `${staleDirectHandles.join(", ")} have no active chat route.`}
              </p>
              <Button
                aria-label="Write a new message"
                data-direct-delivery-action="compose"
                disabled={directReadOnly}
                onClick={() => dispatchAction("composer.focus")}
                size="sm"
                title={directReadOnly ? directReadOnlyReason : "Focus the composer to write a new message and retry delivery"}
                type="button"
                variant="outline"
              >
                Write a new message
              </Button>
            </div>
          )}
          {channelState.status === "error" && activeWorkspace === undefined ? (
            <HubUnavailableState message={channelState.message} onRetry={reloadChannels} />
          ) : activeWorkspace !== undefined ? (
            <WorkspacePanel
              api={api}
              fallbackApi={fallbackApi}
              identity={identity}
              onBroadcast={() => openWorkspaceBroadcast(activeWorkspace.id)}
              onOpenAttachments={() => router.navigate({ attachmentKind: "all", kind: "attachments", scope: activeWorkspaceChannel === undefined ? "all" : `channel:${activeWorkspaceChannel}` })}
              receiptUpdates={receiptUpdates}
              receiptUpdatesChannel={receiptUpdatesChannel}
              receiptReloadKey={receiptReloadKey}
              streamState={streamState}
              workspace={activeWorkspace}
              workspaceChannel={activeWorkspaceChannel}
            />
          ) : selectedChannel === undefined ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
              <p>No channels are available.</p>
              <Button onClick={() => dispatchAction("channel.create")} type="button" variant="outline">
                Create a channel
              </Button>
            </div>
          ) : (
            <ChannelView
              attachmentContentUrl={(id) => api.attachmentContentUrl(id)}
              fetchAttachmentContent={(id) =>
                apiCall(api, fallbackApi, (client) => client.attachmentContent(id))
              }
              canPreview={identity !== null}
              canAcknowledge={identity !== null && (selectedChannelKind !== "chat" || isSelectedMember)}
              channelName={selectedChannel}
              errorMessage={messageState.status === "ready" ? messageState.errorMessage : undefined}
              focusedMessageId={focusedMessageId}
              ackScheduler={identity === null ? undefined : ackScheduler}
              loadState={messageState.status}
              messages={selectedMessages}
              onFocusedMessageChange={setFocusedMessageId}
              onJoin={joinSelectedChannel}
              onRetry={reload}
              onStartDirect={controller.startDirect}
              messageableHandles={activeParticipantHandles}
              receiptApi={api}
              receiptFallbackApi={fallbackApi}
              receiptUpdates={receiptUpdates}
              receiptUpdatesChannel={receiptUpdatesChannel}
              receiptRouteStates={receiptRouteStates}
              receiptReloadKey={receiptReloadKey}
              selfHandle={identity?.handle}
              unread={unread}
              viewerCursorId={selectedCursorId ?? selectedInbox?.cursorId}
            />
          )}
        </section>

        {!searchActive && activeWorkspace === undefined && (
          <Composer
            attachmentInputOpen={attachmentInputOpen}
            attachmentPathInput={attachmentPathInput}
            attachmentPathRef={attachmentPathRef}
            attachments={attachments}
            draft={draft}
            errorMessage={composerState.status === "error" ? composerState.message : undefined}
            placeholder={composerPlaceholder}
            onAttachmentInputChange={handleAttachmentInputChange}
            onAttachmentInputSubmit={handleAttachmentInputSubmit}
            onAttach={() => dispatchAction("composer.attach")}
            onChange={handleComposerChange}
            onRemoveAttachment={removeAttachmentPath}
            onSubmit={handleComposerSubmit}
            composerRef={composerRef}
            sending={composerState.status === "sending"}
            readOnly={identity === null || channelState.status === "error" || directReadOnly}
            readOnlyReason={identity === null ? NOT_CONNECTED_REASON : directReadOnlyReason}
            sendDisabled={selectedChannel === undefined}
            sendDisabledReason="Select a channel before sending."
          />
        )}
        {channelMenu !== undefined && activeChannel !== undefined && (
          <ChannelContextMenu
            canDelete={identity !== null && activeChannel.kind === "chat"}
            channel={activeChannel.name}
            membership={channelMembershipState(identity, membersByChannel.get(activeChannel.name))}
            onClose={() => setChannelMenu(undefined)}
            onCopy={() => { copyChannelName(activeChannel.name); setChannelMenu(undefined) }}
            onDelete={() => { openDeleteChannel(activeChannel.name); setChannelMenu(undefined) }}
            onLeave={() => { leaveChannel(activeChannel.name); setChannelMenu(undefined) }}
            onJoin={() => { joinSelectedChannel(); setChannelMenu(undefined) }}
            onManageMembers={() => { openMembers(activeChannel.name); setChannelMenu(undefined) }}
            onMarkRead={() => { markChannelRead(activeChannel.name); setChannelMenu(undefined) }}
            position={channelMenu}
          />
        )}
        </ChannelDropZone>
      </main>
  )
}

interface ChannelContextMenuProps {
  canDelete: boolean
  channel: string
  membership: ChannelMembershipState
  onClose: () => void
  onCopy: () => void
  onDelete: () => void
  onLeave: () => void
  onJoin: () => void
  onManageMembers: () => void
  onMarkRead: () => void
  position: { x: number; y: number }
}

type ChannelMembershipState = "joined" | "available" | "unknown"

function channelMembershipState(identity: StoredIdentity | null, members: readonly Member[] | undefined): ChannelMembershipState {
  if (identity === null || members === undefined) return "unknown"
  return members.some((member) => member.handle === identity.handle) ? "joined" : "available"
}

function membershipMenuItem(membership: ChannelMembershipState, onJoin: () => void, onLeave: () => void): ContextMenuItem {
  switch (membership) {
    case "joined":
      return { action: onLeave, id: "leave", label: "Leave channel" }
    case "available":
      return { action: onJoin, id: "join", label: "Join channel" }
    case "unknown":
      return { action: () => undefined, disabled: true, id: "membership-loading", label: "Membership loading…" }
  }
}

function ChannelContextMenu({ canDelete, channel, membership, onClose, onCopy, onDelete, onJoin, onLeave, onManageMembers, onMarkRead, position }: ChannelContextMenuProps) {
  const items = useMemo<ContextMenuItem[]>(() => [
    { action: onManageMembers, id: "members", label: "Manage members" },
    { action: onMarkRead, id: "mark-read", label: "Mark as read" },
    ...(canDelete ? [{ action: onDelete, destructive: true, id: "delete", label: "Delete channel" }] : []),
    membershipMenuItem(membership, onJoin, onLeave),
    { action: onCopy, id: "copy-name", label: "Copy channel name" },
  ], [canDelete, membership, onCopy, onDelete, onJoin, onLeave, onManageMembers, onMarkRead])
  return <ContextMenu items={items} kind="channel" label={`Actions for ${displayStorageChannelLabel(channel)}`} onClose={onClose} position={position} />
}

interface ContextMenuItem {
  action: () => void
  disabled?: boolean
  destructive?: boolean
  id: string
  label: string
  title?: string
}

const CONTEXT_MENU_EDGE_GAP_PX = 8

interface ContextMenuPlacement {
  left: number
  top: number
}

function contextMenuPlacement(
  position: { x: number; y: number },
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): ContextMenuPlacement {
  const maxLeft = Math.max(CONTEXT_MENU_EDGE_GAP_PX, viewportWidth - menuWidth - CONTEXT_MENU_EDGE_GAP_PX)
  const left = Math.min(Math.max(position.x, CONTEXT_MENU_EDGE_GAP_PX), maxLeft)
  const maxTop = Math.max(CONTEXT_MENU_EDGE_GAP_PX, viewportHeight - menuHeight - CONTEXT_MENU_EDGE_GAP_PX)
  const preferredTop = position.y + menuHeight > viewportHeight - CONTEXT_MENU_EDGE_GAP_PX
    ? position.y - menuHeight
    : position.y
  const top = Math.min(Math.max(preferredTop, CONTEXT_MENU_EDGE_GAP_PX), maxTop)
  return { left, top }
}

function ContextMenu({ items, kind, label, onClose, position }: { items: ContextMenuItem[]; kind: "channel" | "direct" | "pane" | "workspace"; label: string; onClose: () => void; position: { x: number; y: number } }) {
  const [activeIndex, setActiveIndex] = useState(() => firstEnabledMenuIndex(items))
  const menuRef = useRef<HTMLDivElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [placement, setPlacement] = useState(() => ({ left: position.x, top: position.y }))
  const { x: positionX, y: positionY } = position

  useLayoutEffect(() => {
    const updatePlacement = (): void => {
      const menu = menuRef.current
      if (menu === null) return
      const rect = menu.getBoundingClientRect()
      const next = contextMenuPlacement({ x: positionX, y: positionY }, rect.width, rect.height, globalThis.innerWidth, globalThis.innerHeight)
      setPlacement((current) => current.left === next.left && current.top === next.top ? current : next)
    }
    updatePlacement()
    globalThis.addEventListener("resize", updatePlacement)
    return () => globalThis.removeEventListener("resize", updatePlacement)
  }, [positionX, positionY])

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const menu = menuRef.current
      if (menu === null || !(event.target instanceof Node) || menu.contains(event.target)) return
      onClose()
    }
    globalThis.document.addEventListener("pointerdown", handlePointerDown)
    return () => globalThis.document.removeEventListener("pointerdown", handlePointerDown)
  }, [onClose])

  useEffect(() => {
    previousFocusRef.current = globalThis.document.activeElement instanceof HTMLElement
      ? globalThis.document.activeElement
      : null
    const menu = menuRef.current
    const firstItem = menu?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
    firstItem?.focus()
    return () => previousFocusRef.current?.focus()
  }, [])

  useEffect(() => {
    const item = menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[activeIndex]
    if (item !== undefined && !item.disabled) item.focus()
  }, [activeIndex])

  const handleLayerKeyDown = useCallback((event: KeyEventLike): boolean => {
    if (event.key === "ArrowDown") {
      setActiveIndex((index) => nextEnabledMenuIndex(items, index, 1))
      return true
    }
    if (event.key === "ArrowUp") {
      setActiveIndex((index) => nextEnabledMenuIndex(items, index, -1))
      return true
    }
    if (event.key === "Enter") {
      const item = items[activeIndex]
      if (item !== undefined && !item.disabled) item.action()
      return true
    }
    return false
  }, [activeIndex, items])
  useKeyboardLayer({ mode: "modal", scope: "menu" }, handleLayerKeyDown, onClose)
  return (
    <div aria-label={label} className="fixed z-50 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg" data-menu={kind} data-surface-kind="menu" ref={menuRef} role="menu" style={{ left: placement.left, top: placement.top }}>
      {items.map((item, index) => (
        <button
          className={cn(
            "flex w-full rounded px-3 py-2 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50",
            item.destructive
              ? "text-destructive hover:bg-destructive/10 data-[active=true]:bg-destructive/10"
              : "hover:bg-muted data-[active=true]:bg-muted",
          )}
          data-active={index === activeIndex ? "true" : undefined}
          data-menu-item={item.id}
          disabled={item.disabled}
          key={item.label}
          onClick={item.action}
          onFocus={() => setActiveIndex(index)}
          role="menuitem"
          title={item.title}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

function firstEnabledMenuIndex(items: readonly ContextMenuItem[]): number {
  return items.findIndex((item) => !item.disabled) === -1 ? 0 : items.findIndex((item) => !item.disabled)
}

function nextEnabledMenuIndex(items: readonly ContextMenuItem[], index: number, direction: 1 | -1): number {
  if (items.length === 0) return 0
  for (let offset = 1; offset <= items.length; offset += 1) {
    const candidate = (index + direction * offset + items.length * 2) % items.length
    if (!items[candidate]?.disabled) return candidate
  }
  return index
}

interface WorkspaceContextMenuProps {
  canWrite: boolean
  reporterAvailable: boolean
  onAddReporter: () => void
  onBroadcast: () => void
  onClose: () => void
  onCloseWorkspace: () => void
  onSpawn: () => void
  position: { x: number; y: number }
  workspace: HerdrWorkspaceView
}

function WorkspaceContextMenu({ canWrite, onAddReporter, onBroadcast, onClose, onCloseWorkspace, onSpawn, position, reporterAvailable, workspace }: WorkspaceContextMenuProps) {
  const items = useMemo<ContextMenuItem[]>(() => [
    { action: onBroadcast, disabled: !canWrite, id: "broadcast", label: "Broadcast", title: canWrite ? undefined : NOT_CONNECTED_REASON },
    { action: onSpawn, disabled: !canWrite, id: "spawn-agent", label: "Spawn agent", title: canWrite ? undefined : NOT_CONNECTED_REASON },
    ...(reporterAvailable ? [{ action: onAddReporter, disabled: !canWrite, id: "add-reporter", label: "Add reporter", title: canWrite ? undefined : NOT_CONNECTED_REASON }] : []),
    { action: onCloseWorkspace, disabled: !canWrite, id: "close-workspace", label: "Close workspace", title: canWrite ? undefined : NOT_CONNECTED_REASON },
    { action: () => copyMenuValue(workspace.id, onClose), id: "copy-id", label: "Copy workspace id" },
  ], [canWrite, onAddReporter, onBroadcast, onClose, onCloseWorkspace, onSpawn, reporterAvailable, workspace.id])
  return <ContextMenu items={items} kind="workspace" label={`Actions for ${formatWorkspaceLabel(workspace)}`} onClose={onClose} position={position} />
}

interface PaneContextMenuProps {
  canWrite: boolean
  onClose: () => void
  onClosePane: () => void
  onConnect: () => void
  onMessage: (handle: string) => void
  onOpenWorkspace: () => void
  onStopAgent: () => void
  pane: HerdrPaneView
  position: { x: number; y: number }
}

function PaneContextMenu({ canWrite, onClose, onClosePane, onConnect, onMessage, onOpenWorkspace, onStopAgent, pane, position }: PaneContextMenuProps) {
  const identity = paneIdentity(pane)
  const participant = pane.participant
  const stopConfirm = paneStopConfirmation(pane)
  const stopAvailable = pane.agentKind !== null && stopConfirm !== null && stopConfirm.length > 0
  const closeAvailable = pane.agentKind === null && pane.label !== null && pane.label.length > 0
  const items = useMemo<ContextMenuItem[]>(() => [
    ...(participant === null ? [{
      action: onConnect,
      disabled: !canWrite,
      id: "connect-pane",
      label: "Connect to Sheppard",
      title: canWrite ? "Create a pane-scoped chat identity" : NOT_CONNECTED_REASON,
    }] : [{
      action: () => {
        onMessage(participant)
      },
      id: "message",
      label: "Message this agent",
    }]),
    { action: onOpenWorkspace, id: "open-workspace", label: "Open workspace" },
    ...(stopAvailable ? [{ action: onStopAgent, disabled: !canWrite, id: "stop-agent", label: "Stop agent", title: canWrite ? undefined : NOT_CONNECTED_REASON }] : []),
    ...(closeAvailable ? [{ action: onClosePane, disabled: !canWrite, id: "close-pane", label: "Close pane", title: canWrite ? undefined : NOT_CONNECTED_REASON }] : []),
    { action: () => copyMenuValue(participant ?? pane.paneId, onClose), id: participant === null ? "copy-pane-id" : "copy-handle", label: participant === null ? "Copy pane id" : "Copy handle" },
    ...(participant === null ? [] : [{ action: () => copyMenuValue(pane.paneId, onClose), id: "copy-pane-id", label: "Copy pane id" }]),
  ], [canWrite, closeAvailable, onClose, onClosePane, onConnect, onMessage, onOpenWorkspace, onStopAgent, pane.paneId, participant, stopAvailable])
  return <ContextMenu items={items} kind="pane" label={`Actions for ${identity}`} onClose={onClose} position={position} />
}

function copyMenuValue(value: string, onClose: () => void): void {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard !== undefined) void clipboard.writeText(value).catch(() => undefined)
  onClose()
}

interface WorkspacePanelProps {
  api: AppController["api"]
  fallbackApi: AppController["fallbackApi"]
  identity: StoredIdentity | null
  onBroadcast: () => void
  onOpenAttachments: () => void
  receiptUpdates: ReadonlyMap<string, number>
  receiptUpdatesChannel: string | undefined
  receiptReloadKey: number
  streamState: "connecting" | "live" | "reconnecting" | "degraded" | "offline"
  workspace: HerdrWorkspaceView
  workspaceChannel: string | undefined
}

function WorkspacePanel({ api, fallbackApi, identity, onBroadcast, onOpenAttachments, receiptReloadKey, receiptUpdates, receiptUpdatesChannel, streamState, workspace, workspaceChannel }: WorkspacePanelProps) {
  const live = useLiveMessages(api, fallbackApi, workspaceChannel, 0, undefined, undefined, undefined, false, { enableStream: false })
  const recipients = workspace.panes.flatMap((pane) => pane.participant === null ? [] : [pane.participant])
  const receiptRouteStates = useMemo(
    () => new Map(workspace.panes.flatMap((pane) => pane.participant === null || pane.participantRouteState === null ? [] : [[pane.participant, pane.participantRouteState] as const])),
    [workspace.panes],
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b bg-background px-4 py-2 text-xs text-muted-foreground sm:px-8">
        <span>{workspace.panes.length} panes · {new Set(recipients).size} routed participants</span>
        <span className="inline-flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5" data-stream-state={streamState}>
            {streamState === "live" && <Radio className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />}
            {streamState === "reconnecting" && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
            {streamState === "degraded" && <WifiOff className="size-3.5 text-amber-600" aria-hidden="true" />}
            {streamState === "offline" && <WifiOff className="size-3.5" aria-hidden="true" />}
            {streamStateLabel(streamState)}
          </span>
          <Button disabled={identity === null} onClick={onBroadcast} size="sm" title={identity === null ? NOT_CONNECTED_REASON : "Broadcast to workspace"} variant="outline">
            Broadcast
          </Button>
          <Button aria-label="Open workspace attachments" data-workspace-attachments disabled={workspaceChannel === undefined} onClick={onOpenAttachments} size="icon-sm" title={workspaceChannel === undefined ? "No broadcasts yet" : "Open workspace attachments"} variant="ghost">
            <Paperclip aria-hidden="true" />
          </Button>
        </span>
      </div>
      {workspaceChannel === undefined ? (
        <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">No broadcasts yet.</div>
      ) : (
        <ChannelView
          attachmentContentUrl={(id) => api.attachmentContentUrl(id)}
          canPreview={identity !== null}
          channelName={workspaceChannel}
          errorMessage={live.messageState.status === "ready" ? live.messageState.errorMessage : undefined}
          fetchAttachmentContent={(id) => apiCall(api, fallbackApi, (client) => client.attachmentContent(id))}
          loadState={live.messageState.status}
          messages={live.selectedMessages}
          unread={0}
          ackScheduler={undefined}
          canAcknowledge={false}
          receiptApi={api}
          receiptFallbackApi={fallbackApi}
          receiptUpdates={receiptUpdates}
          receiptUpdatesChannel={receiptUpdatesChannel}
          receiptRouteStates={receiptRouteStates}
          receiptReloadKey={receiptReloadKey}
          selfHandle={identity?.handle}
          onFocusedMessageChange={() => undefined}
        />
      )}
    </div>
  )
}

function WorkspaceOverlays({ controller, router }: { controller: AppController; router: ShellRouter }) {
  const {
    bindings,
    channelDeleteConfirm,
    channelDeleteName,
    channelDeleteOpen,
    channelDeleteState,
    channelPickerOpen,
    channelState,
    clearStorageNotice,
    directConversations,
    handleMemberAdd,
    handleChannelDeleteSubmit,
    helpOpen,
    identity,
    inboxEntries,
    inboxOpen,
    inboxState,
    openInboxChannel,
    memberAddState,
    memberCandidates,
    memberHandle,
    membersOpen,
    membersPanelChannel,
    membersPanelMembers,
    membersPanelError,
    participantsState,
    participants,
    saveKeyboardBindings,
    saveThemePreference,
    selectedChannel,
    workspaceBroadcastBody,
    workspaceBroadcastOpen,
    workspaceBroadcastState,
    workspaceCloseConfirm,
    workspaceCloseOpen,
    workspaceCloseState,
    handleWorkspaceBroadcastSubmit,
    handleWorkspaceCloseSubmit,
    selectChannel,
    setChannelPickerOpen,
    setChannelDeleteConfirm,
    setChannelDeleteOpen,
    setFocusedMessageId,
    setHelpOpen,
    setInboxOpen,
    setMemberHandle,
    setMembersOpen,
    setWorkspaceBroadcastBody,
    setWorkspaceBroadcastOpen,
    setWorkspaceCloseConfirm,
    setWorkspaceCloseOpen,
    setSettingsOpen,
    settingsOpen,
    streamState,
    storageNotice,
    startDirect,
    resolvedTheme,
    themeMode,
  } = controller
  const memberRouteObservations = useMemo<RouteObservation[]>(
    () => membersPanelMembers.map((member) => ({
      key: `${membersPanelChannel ?? ""}\u0000${member.handle}`,
      state: member.routeState,
    })),
    [membersPanelChannel, membersPanelMembers],
  )
  const settledMemberRouteStates = useSettledRouteStates(memberRouteObservations)
  const settledMembersPanelMembers = useMemo(
    () => membersPanelMembers.map((member) => ({
      ...member,
      routeState: settledMemberRouteStates.get(`${membersPanelChannel ?? ""}\u0000${member.handle}`) ?? member.routeState,
    })),
    [membersPanelChannel, membersPanelMembers, settledMemberRouteStates],
  )
  const agentRuntimeByHandle = useMemo(() => {
    const statusesByHandle = new Map<string, Set<AgentStatus>>()
    for (const workspace of controller.workspaceData.settledWorkspaces) {
      for (const pane of workspace.panes) {
        if (pane.participant === null) continue
        const statuses = statusesByHandle.get(pane.participant) ?? new Set<AgentStatus>()
        statuses.add(pane.agentStatus)
        statusesByHandle.set(pane.participant, statuses)
      }
    }
    return new Map([...statusesByHandle].map(([handle, statuses]) => [handle, [...statuses].toSorted()] as const))
  }, [controller.workspaceData.settledWorkspaces])
  const workspaceCloseWorkspace = controller.workspaceData.workspaces.find((workspace) => workspace.id === controller.workspaceCloseId)
  const workspaceBroadcastWorkspace = controller.workspaceData.workspaces.find((workspace) => workspace.id === controller.workspaceBroadcastId)
  const switcherEntries = useMemo(
    () => quickSwitcherEntries({
      channels: channelState.status === "ready" ? channelState.channels : [],
      directConversations,
      participants,
      workspaces: controller.workspaceData.settledWorkspaces,
    }),
    [channelState, controller.workspaceData.settledWorkspaces, directConversations, participants],
  )
  const selectSwitcherEntry = useCallback((entry: QuickSwitcherEntry) => {
    switch (entry.kind) {
      case "chat":
        selectChannel(entry.name, "chat")
        setFocusedMessageId(undefined)
        router.navigate({ channel: entry.name, kind: "channel" })
        break
      case "direct":
        selectChannel(entry.name, "direct")
        setFocusedMessageId(undefined)
        router.navigate({ channel: entry.name, kind: "conversation" })
        break
      case "agent":
        router.navigate({ handle: entry.name, kind: "agent" })
        break
      case "workspace":
        router.navigate({ kind: "workspace", workspaceId: entry.name })
        break
      case "page":
        router.navigate(entry.name === "search"
          ? { kind: "search", query: "", scope: "all" }
          : { attachmentKind: "all", kind: "attachments", scope: "all" })
        break
    }
    setChannelPickerOpen(false)
  }, [router, selectChannel, setFocusedMessageId, setChannelPickerOpen])
  return (
    <div>


      {storageNotice !== undefined && (
        <div aria-live="polite" className="absolute right-4 top-16 z-40 flex max-w-[min(28rem,calc(100vw-2rem))] items-center gap-2 rounded-lg border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-lg" data-notice-placement="below-header" data-surface-kind="notice" role="status">
          <span className="min-w-0 flex-1 text-pretty">{storageNotice}</span>
          <Button aria-label="Dismiss notice" onClick={clearStorageNotice} size="icon-xs" title="Dismiss notice" type="button" variant="ghost">
            <X aria-hidden="true" />
          </Button>
        </div>
      )}

      {workspaceCloseOpen && (
        <WorkspaceCloseDialog
          confirm={workspaceCloseConfirm}
          agentCount={workspaceCloseWorkspace === undefined ? 0 : agentPaneCount(workspaceCloseWorkspace)}
          label={controller.workspaceData.workspaces.find((workspace) => workspace.id === controller.workspaceCloseId)?.label ?? controller.workspaceCloseId ?? ""}
          paneCount={workspaceCloseWorkspace?.panes.length ?? 0}
          onClose={() => setWorkspaceCloseOpen(false)}
          onConfirmChange={setWorkspaceCloseConfirm}
          onSubmit={handleWorkspaceCloseSubmit}
          state={workspaceCloseState}
        />
      )}

      {workspaceBroadcastOpen && (
        <WorkspaceBroadcastDialog
              body={workspaceBroadcastBody}
              workspaceLabel={workspaceBroadcastWorkspace === undefined ? controller.workspaceBroadcastId ?? "workspace" : formatWorkspaceLabel(workspaceBroadcastWorkspace)}
          onBodyChange={setWorkspaceBroadcastBody}
          onClose={() => setWorkspaceBroadcastOpen(false)}
          onSubmit={handleWorkspaceBroadcastSubmit}
          recipients={workspaceBroadcastRecipients(controller.workspaceData.settledWorkspaces, controller.workspaceBroadcastId)}
          state={workspaceBroadcastState}
        />
      )}

      {channelDeleteOpen && channelDeleteName !== undefined && (
        <ChannelDeleteDialog
          canWrite={identity !== null}
          channel={channelDeleteName}
          confirm={channelDeleteConfirm}
          kind={directConversations.some((conversation) => conversation.channel === channelDeleteName) ? "direct" : "channel"}
          onClose={() => setChannelDeleteOpen(false)}
          onConfirmChange={setChannelDeleteConfirm}
          onSubmit={handleChannelDeleteSubmit}
          state={channelDeleteState}
        />
      )}

      <LifecycleOverlays controller={controller} />

      {channelPickerOpen && (
        <ChannelPicker
          entries={switcherEntries}
          onClose={() => setChannelPickerOpen(false)}
          onSelect={selectSwitcherEntry}
          selectedChannel={selectedChannel}
        />
      )}

      {membersOpen && (
        <MembersPanel
          candidates={memberCandidates}
          channelLabel={displayStorageChannelLabel(membersPanelChannel ?? selectedChannel ?? "")}
          handle={memberHandle}
          identity={identity}
          members={settledMembersPanelMembers}
          runtimeByHandle={agentRuntimeByHandle}
          onAdd={handleMemberAdd}
          onClose={() => setMembersOpen(false)}
          onHandleChange={setMemberHandle}
          onStartDirect={startDirect}
          participantsError={membersPanelError ?? (participantsState.status === "ready" ? participantsState.errorMessage : undefined)}
          state={memberAddState}
        />
      )}

      {settingsOpen && (
        <WorkspaceSettings
          bindings={bindings}
          onClose={() => setSettingsOpen(false)}
          onSaveBindings={saveKeyboardBindings}
          onThemeChange={saveThemePreference}
          resolvedTheme={resolvedTheme}
          streamState={streamState}
          themeMode={themeMode}
        />
      )}

      {inboxOpen && (
        <InboxDialog
          channels={channelState.status === "ready" ? channelState.channels : []}
          directConversations={directConversations}
          entries={inboxEntries}
          workspaceChannels={controller.workspaceData.workspaceChannels}
          onClose={() => setInboxOpen(false)}
          onSelect={openInboxChannel}
          state={inboxState}
        />
      )}

      {helpOpen && (
        <KeyboardHelp bindings={bindings} onClose={() => setHelpOpen(false)} />
      )}

    </div>
  )
}

interface ComposerProps {
  attachmentInputOpen: boolean
  attachmentPathInput: string
  attachmentPathRef: RefObject<HTMLInputElement | null>
  attachments: AttachmentPath[]
  composerRef: RefObject<HTMLTextAreaElement | null>
  draft: string
  errorMessage: string | undefined
  placeholder: string
  onAttachmentInputChange: (value: string) => void
  onAttachmentInputSubmit: () => void
  onAttach: () => void
  onChange: (value: string) => void
  onRemoveAttachment: (path: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  sending: boolean
  readOnly: boolean
  readOnlyReason: string
  sendDisabled: boolean
  sendDisabledReason: string
}

interface ChannelDropZoneProps {
  children: ReactNode
  conversationSurface?: boolean
  enabled: boolean
  onDropFiles: (files: readonly File[]) => void
}

function ChannelDropZone({ children, conversationSurface = false, enabled, onDropFiles }: ChannelDropZoneProps) {
  const [dragActive, setDragActive] = useState(false)

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (!enabled || !Array.from(event.dataTransfer.types).includes("Files")) return
    event.preventDefault()
    setDragActive(true)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!enabled || !Array.from(event.dataTransfer.types).includes("Files")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    setDragActive(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    setDragActive(false)
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    if (!enabled) return
    event.preventDefault()
    setDragActive(false)
    onDropFiles(Array.from(event.dataTransfer.files))
  }

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-conversation-surface={conversationSurface ? "true" : undefined}
      data-drop-target="channel"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {dragActive && (
        <div aria-label="Drop files to upload" className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/10 text-sm font-medium text-primary shadow-lg">
          <span className="inline-flex items-center gap-2 rounded-lg bg-background/90 px-4 py-2 shadow-sm">
            <Upload aria-hidden="true" className="size-4" />
            Drop files to upload
          </span>
        </div>
      )}
    </div>
  )
}

function Composer({
  attachmentInputOpen,
  attachmentPathInput,
  attachmentPathRef,
  attachments,
  composerRef,
  draft,
  errorMessage,
  placeholder,
  onAttachmentInputChange,
  onAttachmentInputSubmit,
  onAttach,
  onChange,
  onRemoveAttachment,
  onSubmit,
  sending,
  readOnly,
  readOnlyReason,
  sendDisabled,
  sendDisabledReason,
}: ComposerProps) {
  const attachmentBlocked = attachments.some((attachment) => attachment.status === "uploading" || attachment.status === "error" || attachment.error !== undefined)

  useComposerAutosize(composerRef, draft)

  return (
    <form
      className="shrink-0 border-t bg-background px-4 py-3 sm:px-8"
      onSubmit={(event) => {
        if (readOnly || sendDisabled) {
          event.preventDefault()
          return
        }
        onSubmit(event)
      }}
    >
      <div className="mx-auto max-w-4xl">
        {attachments.length > 0 && (
          <ul aria-label="Message attachments" className="mb-2 flex flex-wrap gap-2">
            {attachments.map((attachment) => (
              <li
                aria-busy={attachment.status === "uploading"}
                className="flex max-w-full items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                key={attachment.path}
              >
                <span className="max-w-60 truncate" title={attachment.path}>
                  {attachment.status === "uploading" ? attachment.label ?? attachment.path : attachment.path}
                </span>
                {attachment.status === "uploading" && (
                  <span className="text-muted-foreground">{attachment.progress ?? 0}%</span>
                )}
                <button
                  aria-label={`Remove attachment ${attachment.path}`}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onRemoveAttachment(attachment.path)}
                  type="button"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
                {attachment.error !== undefined && (
                  <span className="text-destructive" role="alert">{attachment.error}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {attachmentInputOpen && (
          <div className="mb-2 flex items-center gap-2">
            <label className="sr-only" htmlFor="attachment-path">Absolute attachment path</label>
            <input
              className="h-8 min-w-0 flex-1 rounded-md border bg-muted/30 px-2 text-xs outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
              id="attachment-path"
              onChange={(event) => onAttachmentInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  onAttachmentInputSubmit()
                }
              }}
              placeholder="/absolute/path/to/file"
              ref={attachmentPathRef}
              value={attachmentPathInput}
            />
            <Button onClick={onAttachmentInputSubmit} size="sm" type="button">Add</Button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Button
            aria-label="Attach a file path"
            disabled={readOnly || sendDisabled}
            onClick={onAttach}
            size="icon-sm"
            title={readOnly ? readOnlyReason : sendDisabled ? sendDisabledReason : "Attach a file path"}
            type="button"
            variant="outline"
          >
            <Paperclip aria-hidden="true" />
          </Button>
        <label className="sr-only" htmlFor="message-composer">Message</label>
        <textarea
          className="min-h-10 max-h-48 min-w-0 flex-1 resize-none overflow-y-hidden rounded-lg border bg-muted/30 px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20 motion-safe:transition-[height] motion-safe:duration-150 motion-safe:ease-out"
          id="message-composer"
          onChange={(event) => onChange(event.target.value)}
          placeholder={readOnly ? readOnlyReason : placeholder}
          readOnly={readOnly}
          ref={composerRef}
          rows={1}
          value={draft}
        />
        <Button
          disabled={readOnly || sendDisabled || sending || attachmentBlocked}
          title={readOnly ? readOnlyReason : sendDisabled ? sendDisabledReason : attachmentBlocked ? "Wait for uploads to finish and fix attachment errors before sending" : undefined}
          type="submit"
        >
          {sending ? "Sending…" : "Send"}
        </Button>
        </div>
      </div>
      {errorMessage !== undefined && (
        <p className="mx-auto mt-1 max-w-4xl text-xs text-destructive" role="alert">{errorMessage}</p>
      )}
    </form>
  )
}


function LifecycleOverlays({ controller }: { controller: AppController }) {
  const {
    closeConnectPane,
    closePaneConfirm,
    closePaneOpen,
    closePaneState,
    closePaneTarget,
    handleClosePaneSubmit,
    handleConnectPaneSubmit,
    handleStopAgentSubmit,
    connectPaneHandle,
    connectPaneState,
    connectPaneTarget,
    setClosePaneConfirm,
    setClosePaneOpen,
    setConnectPaneHandle,
    setStopAgentConfirm,
    setStopAgentOpen,
    stopAgentConfirm,
    stopAgentOpen,
    stopAgentPane,
    stopAgentState,
  } = controller
  return (
    <>
      {stopAgentOpen && stopAgentPane !== undefined && (
        <StopAgentDialog
          confirm={stopAgentConfirm}
          expected={paneStopConfirmation(stopAgentPane) ?? ""}
          onClose={() => setStopAgentOpen(false)}
          onConfirmChange={setStopAgentConfirm}
          onSubmit={handleStopAgentSubmit}
          pane={stopAgentPane}
          state={stopAgentState}
        />
      )}
      {closePaneOpen && closePaneTarget !== undefined && (
        <ClosePaneDialog
          confirm={closePaneConfirm}
          expected={closePaneTarget.label ?? ""}
          onClose={() => setClosePaneOpen(false)}
          onConfirmChange={setClosePaneConfirm}
          onSubmit={handleClosePaneSubmit}
          pane={closePaneTarget}
          state={closePaneState}
        />
      )}
      {connectPaneTarget !== undefined && (
        <ConnectPaneDialog
          handle={connectPaneHandle}
          onClose={closeConnectPane}
          onHandleChange={setConnectPaneHandle}
          onSubmit={handleConnectPaneSubmit}
          state={connectPaneState}
          target={connectPaneTarget}
        />
      )}
    </>
  )
}

interface ConnectPaneDialogProps {
  handle: string
  onClose: () => void
  onHandleChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  state: WorkspaceActionState
  target: { label: string; pane: HerdrPaneView }
}

function ConnectPaneDialog({ handle, onClose, onHandleChange, onSubmit, state, target }: ConnectPaneDialogProps) {
  return (
    <KeyboardOverlay className="max-w-md" dataDialog="connect-pane" labelledBy="connect-pane-title" onClose={onClose} scope="dialog">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold" id="connect-pane-title">Connect {target.label}</h2>
          <p className="mt-2 text-sm text-muted-foreground">This creates a Sheppard identity for the live Herdr pane. The agent can read its direct messages and channels that it joins. It cannot read other private conversations.</p>
        </div>
        <Button aria-label="Close connect pane" onClick={onClose} size="icon" type="button" variant="ghost"><X aria-hidden="true" /></Button>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">Pane <code className="rounded bg-muted px-1 py-0.5 font-mono">{target.pane.paneId}</code></p>
      <form className="mt-4 space-y-4" onSubmit={onSubmit}>
        <label className="text-sm font-medium" htmlFor="connect-pane-handle">Chat handle</label>
        <input
          autoComplete="off"
          className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
          data-autofocus
          id="connect-pane-handle"
          name="handle"
          onChange={(event) => onHandleChange(event.target.value)}
          spellCheck={false}
          value={handle}
        />
        {state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} type="button" variant="ghost">Cancel</Button>
          <Button disabled={state.status === "working" || handle.trim().length === 0} type="submit">
            <MessageCirclePlus aria-hidden="true" />
            {state.status === "working" ? "Connecting…" : "Connect to chat"}
          </Button>
        </div>
      </form>
    </KeyboardOverlay>
  )
}

interface PaneLifecycleDialogProps {
  confirm: string
  expected: string
  onClose: () => void
  onConfirmChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  pane: HerdrPaneView
  state: WorkspaceActionState
}

function StopAgentDialog({ confirm, expected, onClose, onConfirmChange, onSubmit, pane, state }: PaneLifecycleDialogProps) {
  return (
    <KeyboardOverlay className="max-w-md" dataDialog="stop-agent" labelledBy="stop-agent-title" onClose={onClose} scope="dialog">
      <h2 className="text-base font-semibold" id="stop-agent-title">Stop agent</h2>
      <p className="mt-2 text-sm text-muted-foreground">This closes pane <code className="rounded bg-muted px-1">{pane.paneId}</code> and stops the agent. Its message history remains readable. Type <code className="rounded bg-muted px-1">{expected}</code> to confirm.</p>
      <form className="mt-5 space-y-4" onSubmit={onSubmit}>
        <label className="text-sm font-medium" htmlFor="stop-agent-confirm">Confirmation</label>
        <input data-autofocus data-confirm-input={expected} className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="stop-agent-confirm" onChange={(event) => onConfirmChange(event.target.value)} value={confirm} />
        {state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose} type="button" variant="ghost">Cancel</Button><Button disabled={state.status === "working" || confirm !== expected} type="submit">{state.status === "working" ? "Stopping…" : "Stop agent"}</Button></div>
      </form>
    </KeyboardOverlay>
  )
}

function ClosePaneDialog({ confirm, expected, onClose, onConfirmChange, onSubmit, pane, state }: PaneLifecycleDialogProps) {
  return (
    <KeyboardOverlay className="max-w-md" dataDialog="close-pane" labelledBy="close-pane-title" onClose={onClose} scope="dialog">
      <h2 className="text-base font-semibold" id="close-pane-title">Close pane</h2>
      <p className="mt-2 text-sm text-muted-foreground">This closes the empty pane <code className="rounded bg-muted px-1">{pane.paneId}</code>. Type <code className="rounded bg-muted px-1">{expected}</code> to confirm.</p>
      <form className="mt-5 space-y-4" onSubmit={onSubmit}>
        <label className="text-sm font-medium" htmlFor="close-pane-confirm">Confirmation</label>
        <input data-autofocus data-confirm-input={expected} className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="close-pane-confirm" onChange={(event) => onConfirmChange(event.target.value)} value={confirm} />
        {state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
        <div className="flex justify-end gap-2"><Button onClick={onClose} type="button" variant="ghost">Cancel</Button><Button disabled={state.status === "working" || confirm !== expected} type="submit">{state.status === "working" ? "Closing…" : "Close pane"}</Button></div>
      </form>
    </KeyboardOverlay>
  )
}

interface WorkspaceCloseDialogProps {
  agentCount: number
  confirm: string
  label: string
  onClose: () => void
  onConfirmChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  paneCount: number
  state: WorkspaceActionState
}

interface ChannelDeleteDialogProps {
  canWrite: boolean
  channel: string
  confirm: string
  kind: "channel" | "direct"
  onClose: () => void
  onConfirmChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  state: WorkspaceActionState
}

function ChannelDeleteDialog({ canWrite, channel, confirm, kind, onClose, onConfirmChange, onSubmit, state }: ChannelDeleteDialogProps) {
  const direct = kind === "direct"
  const title = direct ? "Delete Conversation" : "Delete Channel"
  return (
    <KeyboardOverlay className="max-w-md" dataDialog="delete-channel" labelledBy="channel-delete-title" onClose={onClose} scope="dialog">
      <h2 className="text-base font-semibold" id="channel-delete-title">{title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{direct ? "Deletes this conversation for all participants" : `Deletes #${channel}`}, including its messages and unread state. This cannot be undone. Type <code className="rounded bg-muted px-1">{channel}</code> to confirm.</p>
      <form className="mt-5 space-y-4" onSubmit={onSubmit}>
        <label className="text-sm font-medium" htmlFor="channel-delete-confirm">{direct ? "Conversation ID" : "Channel name"}</label>
        <input autoComplete="off" data-autofocus data-confirm-input={channel} className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="channel-delete-confirm" onChange={(event) => onConfirmChange(event.target.value)} spellCheck={false} value={confirm} />
        {state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}
        <div className="flex flex-wrap justify-end gap-2"><Button onClick={onClose} type="button" variant="ghost">Cancel</Button><Button disabled={!canWrite || state.status === "working" || confirm !== channel} type="submit" variant="destructive">{state.status === "working" ? "Deleting…" : title}</Button></div>
      </form>
    </KeyboardOverlay>
  )
}

function WorkspaceCloseDialog({ agentCount, confirm, label, onClose, onConfirmChange, onSubmit, paneCount, state }: WorkspaceCloseDialogProps) {
  return (
    <KeyboardOverlay className="max-w-md" dataDialog="close-workspace" labelledBy="workspace-close-title" onClose={onClose} scope="dialog">
      <h2 className="text-base font-semibold" id="workspace-close-title">Close workspace</h2>
      <p className="mt-2 text-sm text-muted-foreground">Closes {paneCount} pane{paneCount === 1 ? "" : "s"}, including {agentCount} running agent{agentCount === 1 ? "" : "s"}. Type <code className="rounded bg-muted px-1">{label}</code> to confirm.</p>
      <form className="mt-5 space-y-4" onSubmit={onSubmit}><label className="text-sm font-medium" htmlFor="workspace-close-confirm">Confirmation</label><input data-autofocus className="h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="workspace-close-confirm" onChange={(event) => onConfirmChange(event.target.value)} value={confirm} />{state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}<div className="flex justify-end gap-2"><Button onClick={onClose} type="button" variant="ghost">Cancel</Button><Button disabled={state.status === "working" || confirm !== label} type="submit">{state.status === "working" ? "Closing…" : "Close workspace"}</Button></div></form>
    </KeyboardOverlay>
  )
}

interface WorkspaceBroadcastDialogProps {
  body: string
  onBodyChange: (value: string) => void
  onClose: () => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  recipients: WorkspaceBroadcastRecipients
  state: WorkspaceActionState
  workspaceLabel: string
}

function WorkspaceBroadcastDialog({ body, onBodyChange, onClose, onSubmit, recipients, state, workspaceLabel }: WorkspaceBroadcastDialogProps) {
  const recipientSummary = broadcastRecipientSummary(workspaceLabel, recipients)
  return (
    <KeyboardOverlay className="max-w-lg" dataDialog="workspace-broadcast" labelledBy="workspace-broadcast-title" onClose={onClose} scope="dialog">
      <h2 className="text-base font-semibold" id="workspace-broadcast-title">Broadcast to workspace</h2>
      <p className="mt-2 text-sm text-muted-foreground">{recipientSummary}</p>
      <p className="mt-1 text-xs text-muted-foreground" data-broadcast-routing>
        Chat-linked agents: {recipients.all.length} · Panes not linked to chat: {recipients.unmanaged.length}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Active recipients: {recipients.active.length === 0 ? "none" : recipients.active.join(", ")}</p>
      {recipients.stale.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Inactive chat routes: {recipients.stale.join(", ")}</p>}
      {recipients.unmanaged.length > 0 && <p className="mt-1 text-xs text-muted-foreground" data-unmanaged-agents>{unmanagedRecipientSummary(recipients)} The broadcast cannot address these panes: {recipients.unmanaged.join(", ")}.</p>}
      <form className="mt-5 space-y-4" onSubmit={onSubmit}><label className="text-sm font-medium" htmlFor="workspace-broadcast-body">Message</label><textarea data-autofocus className="min-h-28 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="workspace-broadcast-body" onChange={(event) => onBodyChange(event.target.value)} placeholder="Write a workspace broadcast" value={body} />{state.status === "error" && <p className="text-sm text-destructive" role="alert">{state.message}</p>}<div className="flex justify-end gap-2"><Button onClick={onClose} type="button" variant="ghost">Cancel</Button><Button disabled={state.status === "working"} type="submit">{state.status === "working" ? "Sending…" : "Broadcast"}</Button></div></form>
    </KeyboardOverlay>
  )
}

interface WorkspaceBroadcastRecipients {
  active: string[]
  all: string[]
  unmanaged: string[]
  stale: string[]
}

function workspaceBroadcastRecipients(workspaces: HerdrWorkspaceView[], workspaceId: string | undefined): WorkspaceBroadcastRecipients {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
  return workspace === undefined
    ? { active: [], all: [], unmanaged: [], stale: [] }
    : workspace.panes.reduce<WorkspaceBroadcastRecipients>((result, pane) => {
      if (pane.participant === null) {
        if (pane.agentKind !== null) {
          const identity = pane.label ?? pane.paneId
          if (!result.unmanaged.includes(identity)) result.unmanaged.push(identity)
        }
        return result
      }
      if (result.all.includes(pane.participant)) return result
      result.all.push(pane.participant)
      if (pane.participantRouteState === "active") result.active.push(pane.participant)
      if (pane.participantRouteState === "stale") result.stale.push(pane.participant)
      return result
    }, { active: [], all: [], unmanaged: [], stale: [] })
}

function unmanagedRecipientSummary(recipients: WorkspaceBroadcastRecipients): string {
  const count = recipients.unmanaged.length
  if (count === 0) return ""
  return `${count} Herdr agent pane${count === 1 ? "" : "s"} ${count === 1 ? "has" : "have"} no chat identity.`
}

function broadcastRecipientSummary(workspaceLabel: string, recipients: WorkspaceBroadcastRecipients): string {
  if (recipients.active.length === 0) {
    return `No active chat routes exist in ${workspaceLabel}. The message is stored, and no live notification is sent.`
  }
  if (recipients.stale.length === 0) {
    return `Sends to ${recipients.active.length} agent${recipients.active.length === 1 ? "" : "s"} in ${workspaceLabel}. They are added to a hidden workspace channel and receive the message as unread.`
  }
  return `${recipients.active.length} of ${recipients.all.length} chat routes are active. Inactive routes: ${recipients.stale.join(", ")}.`
}

interface ChannelPickerProps {
  entries: QuickSwitcherEntry[]
  onClose: () => void
  onSelect: (entry: QuickSwitcherEntry) => void
  selectedChannel: string | undefined
}

function ChannelPicker({ entries, onClose, onSelect, selectedChannel }: ChannelPickerProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = quickSwitcherMatches(entries, query)
  const activeMatch = matches[activeIndex] ?? matches[0]
  const handleLayerKeyDown = useCallback((event: KeyEventLike): boolean => {
    if (event.key === "ArrowDown") {
      if (matches.length > 0) setActiveIndex((current) => (current + 1) % matches.length)
      return true
    }
    if (event.key === "ArrowUp") {
      if (matches.length > 0) setActiveIndex((current) => (current - 1 + matches.length) % matches.length)
      return true
    }
    if (event.key === "Enter") {
      if (activeMatch !== undefined) onSelect(activeMatch)
      return true
    }
    return false
  }, [activeMatch, matches.length, onSelect])

  return (
    <KeyboardOverlay
      className="max-w-md"
      dataDialog="channel-picker"
      labelledBy="channel-picker-title"
      onClose={onClose}
      onLayerKeyDown={handleLayerKeyDown}
      scope="picker"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold" id="channel-picker-title">Switch channel</h2>
        <Button aria-label="Close channel picker" onClick={onClose} size="icon-xs" type="button" variant="ghost">
          <X aria-hidden="true" />
        </Button>
      </div>
      <label className="sr-only" htmlFor="channel-picker-input">Filter channels</label>
      <input
        data-autofocus
        className="mt-4 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
        id="channel-picker-input"
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveIndex(0)
        }}
        placeholder="Type a channel name"
        value={query}
      />
      <ul aria-label="Matching channels" className="mt-3 max-h-64 overflow-y-auto" role="listbox">
        {matches.map((entry, index) => (
          <li data-picker-group={entry.kind} data-quick-switch-kind={entry.kind} key={entry.id}>
            <button
              aria-selected={index === activeIndex}
              aria-current={entry.name === selectedChannel ? "true" : undefined}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted aria-[current=true]:font-medium data-[active=true]:bg-muted"
              data-active={index === activeIndex ? "true" : undefined}
              onClick={() => onSelect(entry)}
              role="option"
              type="button"
            >
              {entry.kind === "chat" && <Hash aria-hidden="true" className="size-4 text-muted-foreground" data-picker-glyph="hash" />}
              {entry.kind === "direct" && <MessageCircle aria-hidden="true" className="size-4 text-muted-foreground" data-picker-glyph="message-circle" />}
              {entry.kind === "agent" && <Bot aria-hidden="true" className="size-4 text-muted-foreground" data-picker-glyph="bot" />}
              {entry.kind === "workspace" && <SquareTerminal aria-hidden="true" className="size-4 text-muted-foreground" data-picker-glyph="square-terminal" />}
              {entry.kind === "page" && (entry.name === "search"
                ? <Search aria-hidden="true" className="size-4 text-muted-foreground" data-picker-glyph="search" />
                : <Paperclip aria-hidden="true" className="size-4 text-muted-foreground" data-picker-glyph="paperclip" />)}
              {entry.label}
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matching channels.</li>}
      </ul>
    </KeyboardOverlay>
  )
}

interface MembersPanelProps {
  candidates: Participant[]
  channelLabel: string
  handle: string
  identity: StoredIdentity | null
  members: Member[]
  onAdd: (handle?: string) => void
  onClose: () => void
  onHandleChange: (value: string) => void
  onStartDirect: (handle: string) => void
  participantsError?: string
  runtimeByHandle: ReadonlyMap<string, readonly AgentStatus[]>
  state: MemberAddState
}

function memberRuntimeLabel(member: Member, runtimeByHandle: ReadonlyMap<string, readonly AgentStatus[]>): string {
  if (member.kind === "human") return "Human"
  const statuses = runtimeByHandle.get(member.handle)
  if (statuses === undefined || statuses.length === 0) return "No Herdr Pane"
  return statuses.map((status) => `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`).join(" + ")
}

function MembersPanel({
  candidates,
  channelLabel,
  handle,
  identity,
  members,
  onAdd,
  onClose,
  onHandleChange,
  onStartDirect,
  participantsError,
  runtimeByHandle,
  state,
}: MembersPanelProps) {
  const [query, setQuery] = useState("")
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = candidates.filter((candidate) => candidate.handle.toLowerCase().includes(query.toLowerCase()))
  const activeCandidate = matches[activeIndex] ?? matches[0]
  const handleLayerKeyDown = useCallback((event: KeyEventLike): boolean => {
    if (event.key === "ArrowDown") {
      if (matches.length > 0) setActiveIndex((current) => (current + 1) % matches.length)
      return true
    }
    if (event.key === "ArrowUp") {
      if (matches.length > 0) setActiveIndex((current) => (current - 1 + matches.length) % matches.length)
      return true
    }
    if (event.key === "Enter" && activeCandidate !== undefined) {
      onAdd(activeCandidate.handle)
      return true
    }
    return false
  }, [activeCandidate, matches.length, onAdd])

  return (
    <KeyboardOverlay
      className="max-w-xl"
      dataDialog="members"
      labelledBy="members-panel-title"
      onClose={onClose}
      onLayerKeyDown={handleLayerKeyDown}
      scope="members"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold" id="members-panel-title">Members · {channelLabel}</h2>
        <Button aria-label="Close channel members" onClick={onClose} size="icon-xs" type="button" variant="ghost">
          <X aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Messages sent before adding do not count as unread for the new member.
      </p>
      <ul aria-label="Current channel members" className="mt-5 divide-y rounded-xl border" data-membership="member">
        {members.map((member) => {
          const runtimeLabel = memberRuntimeLabel(member, runtimeByHandle)
          return (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5" data-member-handle={member.handle} key={member.handle}>
              <MemberMark member={member} />
              <span className="min-w-0 flex-1 truncate text-sm">{member.handle}</span>
              <span className="text-xs text-muted-foreground">{member.kind}</span>
              <span
                aria-label={`Runtime ${runtimeLabel}`}
                className={member.kind === "agent" && runtimeLabel === "No Herdr Pane" ? "text-xs text-amber-700 dark:text-amber-400" : "text-xs text-muted-foreground"}
                data-agent-runtime={member.kind === "agent" ? runtimeLabel.toLocaleLowerCase().replaceAll(" ", "-") : undefined}
              >
                {runtimeLabel}
              </span>
              {member.kind === "agent" && <span className={member.routeState === "active" ? "text-xs text-emerald-700 dark:text-emerald-400" : "text-xs text-muted-foreground"}>Chat {member.routeState === "active" ? "active" : "inactive"}</span>}
              <span className="text-xs text-muted-foreground">{member.unread} unread</span>
              {member.handle !== identity?.handle && (
                <Button
                  aria-label={`Message ${member.handle} directly`}
                  onClick={() => onStartDirect(member.handle)}
                  size="icon-xs"
                  title={`Message ${member.handle} directly`}
                  type="button"
                  variant="ghost"
                >
                  <MessageCircle aria-hidden="true" />
                </Button>
              )}
            </li>
          )
        })}
        {members.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">No members.</li>}
      </ul>

      <section aria-labelledby="add-member-title" className="mt-5 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <UserPlus aria-hidden="true" className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold" id="add-member-title">Add a participant</h3>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Use the picker or type a known handle.</p>
        <label className="sr-only" htmlFor="member-picker-filter">Filter participants</label>
        <input
          className="mt-3 h-9 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
          id="member-picker-filter"
          onChange={(event) => {
            setQuery(event.target.value)
            setActiveIndex(0)
          }}
          placeholder="Filter participants"
          value={query}
        />
        <ul aria-label="Available participants" className="mt-2 max-h-40 overflow-y-auto" role="listbox">
          {matches.map((candidate, index) => (
            <li data-picker-group="participants" key={candidate.handle}>
              <button
                aria-selected={index === activeIndex}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-muted data-[active=true]:bg-muted"
                data-active={index === activeIndex ? "true" : undefined}
                onClick={() => onHandleChange(candidate.handle)}
                role="option"
                type="button"
              >
                <ParticipantMark participant={candidate} />
                <span className="min-w-0 flex-1 truncate">{candidate.handle}</span>
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="px-2 py-2 text-xs text-muted-foreground">No available participants.</li>}
        </ul>
        {participantsError !== undefined && <p className="mt-2 text-xs text-destructive" role="alert">{participantsError}</p>}
        {state.status === "error" && <p className="mt-2 text-xs text-destructive" role="alert">{state.message}</p>}
        <div className="mt-3 flex items-center gap-2">
          <input
            aria-label="Participant handle"
            className="h-9 min-w-0 flex-1 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
            onChange={(event) => onHandleChange(event.target.value)}
            placeholder="participant handle"
            value={handle}
          />
          <Button disabled={state.status === "adding"} onClick={() => onAdd()} size="sm" type="button">
            {state.status === "adding" ? "Adding…" : "Add"}
          </Button>
        </div>
      </section>
    </KeyboardOverlay>
  )
}


function MemberMark({ member }: { member: Member }) {
  return member.kind === "agent" ? (
    <AgentAvatar agentKind={member.agentKind} />
  ) : (
    <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
      {member.handle.slice(0, 1).toUpperCase()}
    </span>
  )
}

function ParticipantMark({ participant }: { participant: Participant }) {
  return participant.kind === "agent" ? (
    <AgentAvatar agentKind={participant.agentKind} />
  ) : (
    <span aria-hidden="true" className="flex size-6 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
      {participant.handle.slice(0, 1).toUpperCase()}
    </span>
  )
}

interface WorkspaceSettingsProps {
  bindings: KeyboardBindings
  onClose: () => void
  onSaveBindings: (bindings: KeyboardBindings) => void
  onThemeChange: (mode: ThemeMode) => void
  resolvedTheme: ResolvedTheme
  streamState: "connecting" | "live" | "reconnecting" | "degraded" | "offline"
  themeMode: ThemeMode
}

function WorkspaceSettings({
  bindings,
  onClose,
  onSaveBindings,
  onThemeChange,
  resolvedTheme,
  streamState,
  themeMode,
}: WorkspaceSettingsProps) {
  return (
    <KeyboardOverlay className="max-w-2xl" dataDialog="settings" labelledBy="workspace-settings-title" onClose={onClose} scope="settings">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold" id="workspace-settings-title">Workspace settings</h2>
        <Button aria-label="Close workspace settings" onClick={onClose} size="icon-xs" type="button" variant="ghost">
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <section aria-labelledby="settings-hub-title" className="rounded-xl border p-4">
          <h3 className="text-sm font-semibold" id="settings-hub-title">Hub connection</h3>
          <p className="mt-2 inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Radio aria-hidden="true" className="size-4" />
            {streamStateLabel(streamState)}
          </p>
        </section>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <ThemeSettings mode={themeMode} onChange={onThemeChange} resolvedTheme={resolvedTheme} />
        <KeyboardSettings bindings={bindings} onSave={onSaveBindings} />
      </div>
    </KeyboardOverlay>
  )
}

function ThemeSettings({ mode, onChange, resolvedTheme }: { mode: ThemeMode; onChange: (mode: ThemeMode) => void; resolvedTheme: ResolvedTheme }) {
  return (
    <section aria-labelledby="theme-settings-title" className="rounded-xl border p-4">
      <h3 className="text-sm font-semibold" id="theme-settings-title">Theme</h3>
      <p className="mt-1 text-xs text-muted-foreground">Choose the palette for this browser.</p>
      <label className="mt-3 block text-sm font-medium" htmlFor="theme-mode">Theme mode</label>
      <select
        className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
        data-theme-switcher
        id="theme-mode"
        aria-label="Theme mode"
        name="theme"
        onChange={(event) => {
          if (isThemeMode(event.target.value)) onChange(event.target.value)
        }}
        value={mode}
      >
        <option value="dark">Dark</option>
        <option value="light">Light</option>
        <option value="system">System</option>
      </select>
      <p className="mt-2 text-xs text-muted-foreground" data-theme-resolved>Using the {resolvedTheme} palette.</p>
    </section>
  )
}

interface KeyboardSettingsProps {
  bindings: KeyboardBindings
  onSave: (bindings: KeyboardBindings) => void
}

function KeyboardSettings({ bindings, onSave }: KeyboardSettingsProps) {
  const [draft, setDraft] = useState<KeyboardBindings>(() => new Map(bindings))
  const [capturing, setCapturing] = useState<ActionName | undefined>()
  const conflicts = bindingConflicts(draft)

  return (
    <section aria-labelledby="keyboard-settings-title" className="rounded-xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold" id="keyboard-settings-title">
            <Keyboard aria-hidden="true" className="size-4" />
            Keyboard
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">Click a binding, then press the new keys.</p>
        </div>
        <Button onClick={() => setDraft(defaultBindings())} size="sm" variant="outline">Reset defaults</Button>
      </div>
      <ul className="mt-4 divide-y" aria-label="Keyboard bindings">
        {ACTION_REGISTRY.map((action) => {
          const combo = draft.get(action.id) ?? ""
          const conflict = conflicts.has(combo)
          const title = bindingTitle(draft, action.id)
          return (
            <li className={conflict ? "rounded-md bg-destructive/10 text-destructive" : ""} key={action.id}>
              <button
                aria-label={`Rebind ${action.label}`}
                className="flex w-full items-center justify-between gap-3 px-2 py-2 text-left text-sm focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setCapturing(action.id)}
                onKeyDown={(event) => {
                  if (capturing !== action.id) return
                  if (isModifierOnlyKey(event.key)) return
                  event.preventDefault()
                  event.stopPropagation()
                  if (event.key === "Escape") {
                    setCapturing(undefined)
                    return
                  }
                  if (event.key === "Backspace" || event.key === "Delete") {
                    setDraft((current) => replaceBinding(current, action.id, ""))
                    setCapturing(undefined)
                    return
                  }
                  setDraft((current) => replaceBinding(current, action.id, comboFromKeyEvent(event)))
                  setCapturing(undefined)
                }}
                type="button"
              >
                <span>{action.label}</span>
                <kbd className="rounded border bg-muted px-2 py-1 text-xs" title={title}>
                  {capturing === action.id ? "Press keys…" : displayBinding(draft, action.id)}
                </kbd>
              </button>
            </li>
          )
        })}
      </ul>
      {conflicts.size > 0 && (
        <p className="mt-3 text-xs text-destructive" role="alert">
          Duplicate bindings are highlighted. Resolve them before saving.
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <Button disabled={conflicts.size > 0} onClick={() => onSave(draft)} size="sm">Save bindings</Button>
      </div>
    </section>
  )
}

function KeyboardHelp({ bindings, onClose }: { bindings: KeyboardBindings; onClose: () => void }) {
  return (
    <KeyboardOverlay className="max-w-lg" dataDialog="keyboard-help" labelledBy="keyboard-help-title" onClose={onClose} scope="help">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold" id="keyboard-help-title">Keyboard shortcuts</h2>
        <Button aria-label="Close keyboard help" onClick={onClose} size="icon-xs" type="button" variant="ghost">
          <X aria-hidden="true" />
        </Button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">Current bindings. Press Esc to close.</p>
      <ul className="mt-4 divide-y" aria-label="Current keyboard shortcuts">
        {ACTION_REGISTRY.map((action) => (
          <li className="flex items-center justify-between gap-3 py-2 text-sm" key={action.id}>
            <span>{action.label}</span>
            <kbd className="rounded border bg-muted px-2 py-1 text-xs" title={bindingTitle(bindings, action.id)}>{displayBinding(bindings, action.id)}</kbd>
          </li>
        ))}
      </ul>
    </KeyboardOverlay>
  )
}

interface InboxDialogProps {
  channels: Channel[]
  directConversations: DirectConversation[]
  entries: InboxEntry[]
  workspaceChannels: Channel[]
  onClose: () => void
  onSelect: (channel: string, kind: "chat" | "direct" | "workspace") => void
  state: InboxState
}

function InboxDialog({ channels, directConversations, entries, onClose, onSelect, state, workspaceChannels }: InboxDialogProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const channelByName = new Map(channels.map((channel) => [channel.name, channel]))
  const workspaceByName = new Map(workspaceChannels.map((channel) => [channel.name, channel]))
  const directByName = new Map(directConversations.map((conversation) => [conversation.channel, conversation]))
  const rows: Array<{
    channel: string
    kind: "chat" | "direct" | "workspace"
    label: string
    lastMessageAt: string | null
    senders: string[]
    unread: number
  }> = []
  for (const entry of entries) {
    if (entry.unread <= 0) continue
    const conversation = directByName.get(entry.channel)
    const workspace = workspaceByName.get(entry.channel)
    rows.push({
      channel: entry.channel,
      kind: conversation !== undefined ? "direct" as const : workspace !== undefined ? "workspace" as const : "chat" as const,
      label: conversation !== undefined ? directConversationLabel(conversation) : workspace !== undefined ? "Workspace broadcast" : displayStorageChannelLabel(entry.channel),
      lastMessageAt: channelByName.get(entry.channel)?.lastMessageAt ?? null,
      senders: entry.senders,
      unread: entry.unread,
    })
  }
  rows.sort((left, right) => right.unread - left.unread || (right.lastMessageAt ?? "").localeCompare(left.lastMessageAt ?? "") || left.label.localeCompare(right.label))
  const activeRow = rows[activeIndex] ?? rows[0]
  const handleLayerKeyDown = useCallback((event: KeyEventLike): boolean => {
    if (event.key === "ArrowDown") {
      if (rows.length > 0) setActiveIndex((index) => (index + 1) % rows.length)
      return true
    }
    if (event.key === "ArrowUp") {
      if (rows.length > 0) setActiveIndex((index) => (index - 1 + rows.length) % rows.length)
      return true
    }
    if (event.key === "Enter" && activeRow !== undefined) {
      onSelect(activeRow.channel, activeRow.kind)
      return true
    }
    return false
  }, [activeRow, onSelect, rows.length])
  return (
    <KeyboardOverlay className="max-w-md" dataDialog="inbox" labelledBy="inbox-title" onClose={onClose} onLayerKeyDown={handleLayerKeyDown} scope="inbox">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold" id="inbox-title">Inbox</h2>
        <Button aria-label="Close inbox" onClick={onClose} size="icon-xs" type="button" variant="ghost">
          <X aria-hidden="true" />
        </Button>
      </div>
      {state.status === "loading" && <p className="mt-4 text-sm text-muted-foreground">Loading unread state…</p>}
      {state.status === "ready" && state.errorMessage !== undefined && (
        <p className="mt-4 text-sm text-destructive" role="alert">{state.errorMessage}</p>
      )}
      {state.status === "ready" && rows.length === 0 && (
        <p className="mt-4 text-sm text-muted-foreground">No unread messages.</p>
      )}
      {state.status === "ready" && rows.length > 0 && (
        <ul className="mt-4 divide-y" aria-label="Unread channels" role="listbox">
          {rows.map((entry, index) => (
            <li data-inbox-row={entry.channel} key={entry.channel}>
              <button aria-selected={index === activeIndex} className="flex w-full items-center justify-between gap-3 rounded px-2 py-2 text-left text-sm hover:bg-muted data-[active=true]:bg-muted" data-active={index === activeIndex ? "true" : undefined} onClick={() => onSelect(entry.channel, entry.kind)} role="option" type="button">
                <span className="min-w-0">
                  <span className="block truncate">{entry.label}</span>
                  {entry.senders.length > 0 && <span className="block truncate text-xs text-muted-foreground">{entry.senders.join(", ")}</span>}
                </span>
                <span className="shrink-0 text-muted-foreground">{entry.unread} unread</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </KeyboardOverlay>
  )
}

function streamStateLabel(state: "connecting" | "live" | "reconnecting" | "degraded" | "offline"): string {
  if (state === "live") return "live"
  if (state === "reconnecting") return "reconnecting"
  if (state === "degraded") return "degraded; retrying slowly"
  if (state === "offline") return "offline"
  return "connecting"
}

function ChannelSkeleton() {
  return (
    <div aria-label="Loading channels" className="px-2">
      <div className="h-6 animate-pulse rounded-md bg-sidebar-accent" />
    </div>
  )
}

function HubUnavailableState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <div className="max-w-md rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-center">
        <p className="text-sm text-destructive" role="alert">{message}</p>
        <Button className="mt-4" onClick={onRetry} size="sm" type="button" variant="outline">Try again</Button>
      </div>
    </div>
  )
}

function WorkspaceSkeleton() {
  return (
    <div aria-label="Loading workspaces" className="px-2">
      <div className="h-6 animate-pulse rounded-md bg-sidebar-accent" />
    </div>
  )
}

function directConversationLabel(conversation: DirectConversation): string {
  return conversation.participants.length === 0
    ? "Direct conversation"
    : conversation.participants.join(", ")
}

function displayStorageChannelLabel(channel: string): string {
  if (channel.startsWith("dm-")) return "Direct conversation"
  if (channel.startsWith("ws-")) return "Workspace broadcast"
  return `#${channel}`
}

function relativeActivity(timestamp: string): string {
  const elapsed = Math.max(Date.now() - Date.parse(timestamp), 0)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

type ContextMenuRequest =
  | { kind: "channel"; channel: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "pane"; paneId: string }

const contextMenuRequestSchema = v.variant("kind", [
  v.object({ channel: v.string(), kind: v.literal("channel") }),
  v.object({ kind: v.literal("workspace"), workspaceId: v.string() }),
  v.object({ kind: v.literal("pane"), paneId: v.string() }),
])

function isContextMenuRequest(event: Event): event is CustomEvent<ContextMenuRequest> {
  if (!(event instanceof CustomEvent)) return false
  return v.safeParse(contextMenuRequestSchema, event.detail).success
}

function isChannelMenuRequest(event: Event): event is CustomEvent<Extract<ContextMenuRequest, { kind: "channel" }>> {
  return isContextMenuRequest(event) && event.detail.kind === "channel"
}

function isWorkspaceOrPaneMenuRequest(event: Event): event is CustomEvent<Exclude<ContextMenuRequest, { kind: "channel" }>> {
  return isContextMenuRequest(event) && event.detail.kind !== "channel"
}

export default App
