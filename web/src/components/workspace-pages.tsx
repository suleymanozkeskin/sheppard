import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import * as v from "valibot"
import { NOT_CONNECTED_REASON } from "@/api/auto-identify"
import {
  Bot,
  Check,
  CircleAlert,
  Copy,
  MessageCircle,
  MessageCirclePlus,
  MoreHorizontal,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Search,
  SquareTerminal,
  Trash2,
  UserPlus,
  X,
} from "lucide-react"

import { apiCall } from "@/api/runtime"
import type { AgentStatus, HerdrPaneView, HerdrTabView, HerdrWorkspaceView, Message } from "@/api/types"
import { formatApiError } from "@/api/errors"
import { AgentStatusMark } from "@/components/agent-status-mark"
import { Button } from "@/components/ui/button"
import { KeyboardOverlay } from "@/components/ui/keyboard-overlay"
import type { AppController } from "@/hooks/use-app-controller"
import { cn } from "@/lib/utils"
import type { ShellRoute, ShellRouter, WorkspaceFilter } from "@/shell-routing"
import {
  agentPaneCount,
  comparePanes,
  compareWorkspaces,
  isEmptyPane,
  matchedParticipantCount,
  unmanagedAgentCount,
  paneIdentityDetails,
  paneStopConfirmation,
  paneStatusLabel,
  workspaceLabel,
} from "@/workspace-presentation"

type WorkspaceNavigate = ShellRouter["navigate"]

interface WorkspacePageProps {
  controller: AppController
  navigate: WorkspaceNavigate
}

const statusClass = {
  blocked: "bg-amber-500",
  done: "bg-emerald-500",
  idle: "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/30",
  working: "bg-blue-500",
} satisfies Record<HerdrPaneView["agentStatus"], string>

function WorkspaceTopologyBanner({ controller }: { controller: AppController }) {
  const { workspaceData } = controller
  const state = workspaceData.workspaceState
  if (workspaceData.topologyStreamState !== "degraded" && workspaceData.topologyStreamState !== "offline") return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm" data-live-updates="unavailable">
      <span className="inline-flex items-center gap-2 text-amber-800 dark:text-amber-300">
        <CircleAlert aria-hidden="true" className="size-4" />
        Live workspace updates are unavailable. The list can be out of date.
      </span>
      <span className="inline-flex items-center gap-2">
        {state.status === "ready" && state.errorMessage !== undefined && <span className="text-xs text-destructive">{state.errorMessage}</span>}
        <Button aria-label="Refresh workspaces" onClick={workspaceData.reloadWorkspaces} size="sm" type="button" variant="ghost">
          <RefreshCw aria-hidden="true" />
          Refresh
        </Button>
      </span>
    </div>
  )
}

type TabActionState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "error"; message: string }

function tabLabel(tab: HerdrTabView): string {
  return tab.label ?? tab.id
}

function TabCloseConfirmation({
  controller,
  tab,
  onCancel,
  onClosed,
}: {
  controller: AppController
  tab: HerdrTabView
  onCancel: () => void
  onClosed: () => void
}) {
  const [confirm, setConfirm] = useState("")
  const [state, setState] = useState<TabActionState>({ status: "idle" })
  const expected = tabLabel(tab)
  const canWrite = controller.identity !== null
  const close = () => {
    if (!canWrite || confirm !== expected) return
    setState({ status: "working" })
    void apiCall(controller.api, controller.fallbackApi, (client) => client.closeTab(tab.id, { confirm })).then((result) => result.match({
      ok: () => {
        onClosed()
        controller.workspaceData.reloadWorkspaces()
      },
      err: (error) => setState({ message: formatApiError(error), status: "error" }),
    }))
  }
  return (
    <KeyboardOverlay className="max-w-md" dataDialog="close-tab" labelledBy="close-tab-heading" onClose={onCancel}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold" id="close-tab-heading">Close {expected}?</h2>
          <p className="mt-2 text-sm text-muted-foreground">This closes the tab and every pane inside it. Type the tab name to confirm.</p>
        </div>
        <Button aria-label="Cancel close tab" onClick={onCancel} size="icon" type="button" variant="ghost"><X aria-hidden="true" /></Button>
      </div>
      <label className="mt-5 block text-sm font-medium" htmlFor="close-tab-confirm">Type {expected} to continue</label>
      <input autoFocus data-autofocus data-confirm-input={expected} className="mt-2 h-10 w-full rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id="close-tab-confirm" onChange={(event) => setConfirm(event.target.value)} value={confirm} />
      {state.status === "error" && <p className="mt-3 text-sm text-destructive" role="alert">{state.message}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel} type="button" variant="ghost">Cancel</Button>
        <Button disabled={!canWrite || confirm !== expected || state.status === "working"} onClick={close} type="button" variant="destructive">Close tab</Button>
      </div>
    </KeyboardOverlay>
  )
}

function WorkspaceTabs({ controller, navigate, workspace }: { controller: AppController; navigate: WorkspaceNavigate; workspace: HerdrWorkspaceView }) {
  const tabs = workspace.tabs
  const [selectedTabId, setSelectedTabId] = useState<string | undefined>()
  const [newLabel, setNewLabel] = useState("")
  const [renamingTabId, setRenamingTabId] = useState<string | undefined>()
  const [renameLabel, setRenameLabel] = useState("")
  const [closeTab, setCloseTab] = useState<HerdrTabView | undefined>()
  const [actionState, setActionState] = useState<TabActionState>({ status: "idle" })
  const canWrite = controller.identity !== null
  const activeTabId = tabs.some((tab) => tab.id === selectedTabId) ? selectedTabId : tabs[0]?.id
  const activeTab = tabs.find((tab) => tab.id === activeTabId)

  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canWrite) return
    const label = newLabel.trim()
    setActionState({ status: "working" })
    void apiCall(controller.api, controller.fallbackApi, (client) => client.createTab(label.length === 0 ? { workspaceId: workspace.id } : { label, workspaceId: workspace.id })).then((result) => result.match({
      ok: ({ tab }) => {
        setNewLabel("")
        setSelectedTabId(tab.id)
        setActionState({ status: "idle" })
        controller.workspaceData.reloadWorkspaces()
      },
      err: (error) => setActionState({ message: formatApiError(error), status: "error" }),
    }))
  }

  const rename = (tab: HerdrTabView) => {
    if (!canWrite) return
    setActionState({ status: "working" })
    void apiCall(controller.api, controller.fallbackApi, (client) => client.renameTab(tab.id, { label: renameLabel })).then((result) => result.match({
      ok: () => {
        setRenamingTabId(undefined)
        setRenameLabel("")
        setActionState({ status: "idle" })
        controller.workspaceData.reloadWorkspaces()
      },
      err: (error) => setActionState({ message: formatApiError(error), status: "error" }),
    }))
  }

  const focus = (tab: HerdrTabView) => {
    if (!canWrite) return
    setActionState({ status: "working" })
    void apiCall(controller.api, controller.fallbackApi, (client) => client.focusTab(tab.id)).then((result) => result.match({
      ok: () => {
        setSelectedTabId(tab.id)
        setActionState({ status: "idle" })
        controller.workspaceData.reloadWorkspaces()
      },
      err: (error) => setActionState({ message: formatApiError(error), status: "error" }),
    }))
  }

  const selectTab = (tab: HerdrTabView) => {
    setSelectedTabId(tab.id)
    if (canWrite) focus(tab)
  }

  const startRename = (tab: HerdrTabView) => {
    setRenamingTabId(tab.id)
    setRenameLabel(tab.label ?? "")
    setActionState({ status: "idle" })
  }

  return (
    <section aria-labelledby={`workspace-tabs-heading-${workspace.id}`} className="rounded-xl border p-4" data-workspace-tabs={workspace.id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" id={`workspace-tabs-heading-${workspace.id}`}>Tabs</h2>
          <p className="mt-1 text-xs text-muted-foreground">Tabs group panes in herdr. Focus a tab to send new work there.</p>
        </div>
        <form className="flex flex-wrap items-center gap-2" onSubmit={create}>
          <label className="sr-only" htmlFor={`new-tab-${workspace.id}`}>New tab name</label>
          <input className="h-9 w-40 rounded-lg border bg-background px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={!canWrite || actionState.status === "working"} id={`new-tab-${workspace.id}`} onChange={(event) => setNewLabel(event.target.value)} placeholder="New tab name" value={newLabel} />
          <Button disabled={!canWrite || actionState.status === "working"} size="sm" type="submit" variant="outline"><Plus aria-hidden="true" />Create tab</Button>
        </form>
      </div>
      {actionState.status === "error" && <p className="mt-3 text-sm text-destructive" role="alert">{actionState.message}</p>}
      {tabs.length === 0 && <p className="mt-4 rounded-lg bg-muted/40 px-3 py-3 text-sm text-muted-foreground">No tabs are reported for this workspace.</p>}
      {tabs.length > 0 && (
        <div aria-label="Workspace tabs" className="mt-4 flex flex-wrap gap-2" role="tablist">
          {tabs.map((tab) => {
            const selected = tab.id === activeTabId
            const renaming = tab.id === renamingTabId
            return (
              <div data-tab-id={tab.id} key={tab.id} role="presentation">
                <div className={cn("flex min-w-0 items-center gap-1 rounded-lg border px-2 py-1", selected && "border-primary bg-primary/5")}>
                  {renaming ? (
                    <>
                      <label className="sr-only" htmlFor={`rename-tab-${tab.id}`}>Rename {tabLabel(tab)}</label>
                      <input autoFocus className="h-8 w-32 rounded border bg-background px-2 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" id={`rename-tab-${tab.id}`} onChange={(event) => setRenameLabel(event.target.value)} value={renameLabel} />
                      <Button aria-label={`Save name for ${tabLabel(tab)}`} disabled={!canWrite || actionState.status === "working"} onClick={() => rename(tab)} size="icon" type="button" variant="ghost"><Check aria-hidden="true" /></Button>
                      <Button aria-label={`Cancel rename for ${tabLabel(tab)}`} onClick={() => setRenamingTabId(undefined)} size="icon" type="button" variant="ghost"><X aria-hidden="true" /></Button>
                    </>
                  ) : (
                    <>
                      <button aria-controls="workspace-active-tab-panel" aria-selected={selected} className="min-w-0 truncate px-2 py-1 text-sm font-medium" id={`workspace-tab-${tab.id}`} onClick={() => selectTab(tab)} role="tab" type="button">{tabLabel(tab)} <span className="ml-1 text-xs font-normal text-muted-foreground">{tab.panes.length}</span></button>
                      <Button aria-label={`Rename ${tabLabel(tab)}`} className={selected ? undefined : "hidden"} disabled={!canWrite || actionState.status === "working"} onClick={() => startRename(tab)} size="icon-xs" title="Rename tab" type="button" variant="ghost"><Pencil aria-hidden="true" /></Button>
                      <Button aria-label={`Close ${tabLabel(tab)}`} className={selected ? undefined : "hidden"} disabled={!canWrite || actionState.status === "working"} onClick={() => setCloseTab(tab)} size="icon-xs" title="Close tab" type="button" variant="ghost"><X aria-hidden="true" /></Button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {activeTab !== undefined && (
        <section aria-labelledby={`workspace-tab-${activeTab.id}`} className="mt-3" id="workspace-active-tab-panel" role="tabpanel">
          <WorkspacePaneList controller={controller} navigate={navigate} panes={activeTab.panes} workspace={workspace} />
        </section>
      )}
      {closeTab !== undefined && <TabCloseConfirmation controller={controller} onCancel={() => setCloseTab(undefined)} onClosed={() => setCloseTab(undefined)} tab={closeTab} />}
    </section>
  )
}

function WorkspaceActionButtons({ controller, workspace }: { controller: AppController; workspace: HerdrWorkspaceView }) {
  const canWrite = controller.identity !== null
  const reporterAvailable = controller.roles.some((role) => role.name === "reporter")
  const label = workspaceLabel(workspace)
  return (
    <div className="flex flex-wrap gap-2" data-workspace-actions>
      <Button disabled={!canWrite} onClick={() => controller.openWorkspaceBroadcast(workspace.id)} title={canWrite ? "Broadcast to workspace" : NOT_CONNECTED_REASON} type="button" variant="outline">
        <Radio aria-hidden="true" />
        Broadcast
      </Button>
      <Button disabled={!canWrite} onClick={() => controller.openSpawnAgent(workspace.id)} title={canWrite ? "Spawn an agent in this workspace" : NOT_CONNECTED_REASON} type="button" variant="outline">
        <Bot aria-hidden="true" />
        Spawn agent
      </Button>
      {reporterAvailable && (
        <Button disabled={!canWrite} onClick={() => controller.openAddReporter(workspace.id)} title={canWrite ? "Add a reporter to this workspace" : NOT_CONNECTED_REASON} type="button" variant="ghost">
          <UserPlus aria-hidden="true" />
          Add reporter
        </Button>
      )}
      <Button disabled={!canWrite} onClick={() => controller.openCloseWorkspace(workspace.id)} title={canWrite ? `Close ${label}` : NOT_CONNECTED_REASON} type="button" variant="ghost">
        <Trash2 aria-hidden="true" />
        Close
      </Button>
    </div>
  )
}

function PaneStatus({ pane }: { pane: HerdrPaneView }) {
  const empty = paneStatusLabel(pane) === "empty pane"
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span aria-hidden="true" className={cn("size-2 rounded-full", empty ? "border border-current bg-transparent" : statusClass[pane.agentStatus])} />
      <span>{paneStatusLabel(pane)}{pane.agentKind !== null && pane.participant === null ? " · not connected to chat" : ""}</span>
    </span>
  )
}

function PaneActions({ controller, identity, navigate, pane }: { controller: AppController; identity: string; navigate: WorkspaceNavigate; pane: HerdrPaneView }) {
  const participant = pane.participant
  const direct = participant === null
    ? undefined
    : controller.directConversations.find((conversation) => conversation.participants.includes(participant))
  const openMessage = () => {
    if (participant === null) return
    if (direct === undefined) {
      controller.startDirect(participant)
      return
    }
    controller.selectChannel(direct.channel, "direct")
    controller.setFocusedMessageId(undefined)
    navigate({ channel: direct.channel, kind: "conversation" })
  }
  const canWrite = controller.identity !== null
  const canStop = pane.agentKind !== null && pane.participant !== null
  const canClose = pane.agentKind === null && pane.label !== null && pane.label.length > 0
  return (
    <div className="flex shrink-0 items-center gap-1">
      {pane.agentKind !== null && pane.participant === null && (
        <Button aria-label={`Connect ${identity} to Sheppard chat`} disabled={!canWrite} onClick={() => controller.openConnectPane(pane, identity)} size="sm" title={canWrite ? "Create a pane-scoped chat identity" : NOT_CONNECTED_REASON} type="button" variant="ghost">
          <MessageCirclePlus aria-hidden="true" />
          Connect
        </Button>
      )}
      {pane.participant !== null && (
        <Button aria-label={`Message ${pane.participant}`} disabled={!canWrite} onClick={openMessage} size="sm" title={canWrite ? "Open a direct conversation" : NOT_CONNECTED_REASON} type="button" variant="ghost">
          <MessageCircle aria-hidden="true" />
          Message
        </Button>
      )}
      {canStop && (
        <Button disabled={!canWrite} onClick={() => controller.openStopAgent(pane)} size="sm" title={canWrite ? "Stop agent" : NOT_CONNECTED_REASON} type="button" variant="ghost">
          Stop
        </Button>
      )}
      {canClose && (
        <Button disabled={!canWrite} onClick={() => controller.openClosePane(pane)} size="sm" title={canWrite ? "Close empty pane" : NOT_CONNECTED_REASON} type="button" variant="ghost">
          Close
        </Button>
      )}
    </div>
  )
}

function WorkspacePaneRow({ controller, navigate, pane, workspace }: { controller: AppController; navigate: WorkspaceNavigate; pane: HerdrPaneView; workspace: HerdrWorkspaceView }) {
  const identityDetails = paneIdentityDetails(pane, workspace)
  const identity = identityDetails.label
  const openAgent = () => {
    if (pane.participant !== null) {
      navigate({ handle: pane.participant, kind: "agent" })
      return
    }
    if (pane.agentKind !== null) controller.openConnectPane(pane, identity)
  }
  return (
    <li
      className={cn("grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t px-3 py-2", pane.focused && "border-s-2 border-s-primary bg-primary/5", pane.agentKind !== null && "hover:bg-muted/30")}
      data-agent-row={pane.participant ?? undefined}
      data-identity-source={identityDetails.source}
      data-pane-id={pane.paneId}
      data-pane-status={paneStatusLabel(pane)}
      title={pane.title ?? undefined}
    >
      <button aria-label={pane.agentKind === null ? undefined : pane.participant === null ? `Connect ${identity} to Sheppard chat` : `Open agent ${pane.participant}`} className={cn("flex min-w-0 items-center gap-3 text-left", pane.agentKind !== null && "cursor-pointer")} disabled={pane.agentKind === null} onClick={openAgent} type="button">
        {pane.agentKind === null
          ? <span aria-label="empty pane" className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground" role="img"><SquareTerminal aria-hidden="true" className="size-3.5" /></span>
          : <AgentStatusMark size={20} status={pane.agentStatus} />}
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate text-sm font-medium", identityDetails.source === "pane-id" && "font-mono text-xs text-muted-foreground")}>{identity}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1"><span className="font-mono text-[11px] text-muted-foreground">pane {pane.paneId}</span><PaneStatus pane={pane} />{pane.role !== undefined && pane.role !== null && <span className="text-xs text-muted-foreground" data-pane-role={pane.role}>role {pane.role}</span>}{pane.focused && <span className="text-xs text-primary">focused</span>}</span>
        </span>
        <span className="hidden text-xs text-muted-foreground md:inline">{pane.agentKind ?? "No agent"}</span>
      </button>
      <PaneActions controller={controller} identity={identity} navigate={navigate} pane={pane} />
    </li>
  )
}

function WorkspacePaneList({ controller, navigate, panes: sourcePanes, workspace }: { controller: AppController; navigate: WorkspaceNavigate; panes?: readonly HerdrPaneView[]; workspace: HerdrWorkspaceView }) {
  const panes = (sourcePanes ?? workspace.panes).toSorted(comparePanes)
  return (
    <ul aria-label={`Panes in ${workspaceLabel(workspace)}`} className="overflow-hidden rounded-xl border" data-workspace-panes={workspace.id}>
      {panes.map((pane) => <WorkspacePaneRow controller={controller} navigate={navigate} pane={pane} workspace={workspace} key={pane.paneId} />)}
      {panes.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">No panes are open in this workspace.</li>}
    </ul>
  )
}

const WORKSPACE_DIRECTORY_AGENT_LIMIT = 6

const workspaceStatusOrder = ["working", "blocked", "idle", "done", "unknown"] as const satisfies readonly AgentStatus[]

function workspaceStatusCounts(workspace: HerdrWorkspaceView) {
  const counts = {
    blocked: 0,
    done: 0,
    idle: 0,
    unknown: 0,
    working: 0,
  } satisfies Record<AgentStatus, number>
  for (const pane of workspace.panes) {
    if (pane.agentKind !== null) counts[pane.agentStatus] += 1
  }
  return counts
}

function WorkspaceRuntimeSummary({ workspace }: { workspace: HerdrWorkspaceView }) {
  const counts = workspaceStatusCounts(workspace)
  const agentPanes = agentPaneCount(workspace)
  const notLinked = unmanagedAgentCount(workspace)
  if (agentPanes === 0) return <span className="text-xs text-muted-foreground">No agent panes</span>
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {workspaceStatusOrder.flatMap((status) => counts[status] === 0 ? [] : [
        <span className="inline-flex items-center gap-1.5" data-workspace-status={status} key={status}>
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", statusClass[status])} />
          <span className="tabular-nums">{counts[status]} {status}</span>
        </span>,
      ])}
      {notLinked > 0 && <span className="text-amber-700 dark:text-amber-400">{notLinked} not linked to chat</span>}
    </span>
  )
}

function copyWorkspaceId(value: string): void {
  const clipboard = globalThis.navigator?.clipboard
  if (clipboard === undefined) return
  void clipboard.writeText(value).catch(() => undefined)
}

const contextMenuRequestSchema = v.variant("kind", [
  v.object({ kind: v.literal("channel"), channel: v.string() }),
  v.object({ kind: v.literal("workspace"), workspaceId: v.string() }),
  v.object({ kind: v.literal("pane"), paneId: v.string() }),
])

function isContextMenuRequest(event: Event, kind: "pane" | "workspace", id: string): boolean {
  if (!(event instanceof CustomEvent)) return false
  const parsed = v.safeParse(contextMenuRequestSchema, event.detail)
  if (!parsed.success) return false
  switch (parsed.output.kind) {
    case "channel":
      return false
    case "pane":
      return kind === "pane" && parsed.output.paneId === id
    case "workspace":
      return kind === "workspace" && parsed.output.workspaceId === id
  }
}

function WorkspaceDirectoryMenu({ controller, onClose, workspace }: { controller: AppController; onClose: () => void; workspace: HerdrWorkspaceView }) {
  const canWrite = controller.identity !== null
  const reporterAvailable = controller.roles.some((role) => role.name === "reporter")
  const label = workspaceLabel(workspace)
  useEffect(() => {
    if (!globalThis.document || globalThis.document.activeElement === null) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    }
    globalThis.addEventListener("keydown", handleKeyDown)
    return () => globalThis.removeEventListener("keydown", handleKeyDown)
  }, [onClose])
  return (
    <div aria-label={`${label} actions`} className="absolute right-2 top-10 z-20 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg" data-workspace-menu role="menu">
      {reporterAvailable && (
        <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" data-menu-item="add-reporter" disabled={!canWrite} onClick={() => { controller.openAddReporter(workspace.id); onClose() }} role="menuitem" title={canWrite ? "Add reporter" : NOT_CONNECTED_REASON} type="button">
          <UserPlus aria-hidden="true" className="size-4" />
          Add reporter
        </button>
      )}
      <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" data-menu-item="copy-workspace-id" onClick={() => { copyWorkspaceId(workspace.id); onClose() }} role="menuitem" type="button">
        <Copy aria-hidden="true" className="size-4" />
        Copy workspace id
      </button>
      <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" data-menu-item="close-workspace" disabled={!canWrite} onClick={() => { controller.openCloseWorkspace(workspace.id); onClose() }} role="menuitem" title={canWrite ? `Close ${label}` : NOT_CONNECTED_REASON} type="button">
        <Trash2 aria-hidden="true" className="size-4" />
        Close workspace
      </button>
    </div>
  )
}

function WorkspaceDirectoryActions({ controller, onMenuClose, onMenuOpen, workspace, menuOpen }: { controller: AppController; menuOpen: boolean; onMenuClose: () => void; onMenuOpen: () => void; workspace: HerdrWorkspaceView }) {
  const canWrite = controller.identity !== null
  const label = workspaceLabel(workspace)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === false) onMenuClose()
    }
    globalThis.addEventListener("pointerdown", closeOnPointerDown)
    return () => globalThis.removeEventListener("pointerdown", closeOnPointerDown)
  }, [menuOpen, onMenuClose])
  return (
    <div className="relative flex shrink-0 items-center gap-1" data-workspace-actions ref={rootRef}>
      <Button aria-label={`Broadcast to ${label}`} disabled={!canWrite} onClick={() => controller.openWorkspaceBroadcast(workspace.id)} size="icon-sm" title={canWrite ? "Broadcast to workspace" : NOT_CONNECTED_REASON} type="button" variant="ghost">
        <Radio aria-hidden="true" />
      </Button>
      <Button aria-label={`Spawn agent in ${label}`} disabled={!canWrite} onClick={() => controller.openSpawnAgent(workspace.id)} size="icon-sm" title={canWrite ? "Spawn an agent in this workspace" : NOT_CONNECTED_REASON} type="button" variant="ghost">
        <Bot aria-hidden="true" />
      </Button>
      <Button aria-expanded={menuOpen} aria-haspopup="menu" aria-label={`More actions for ${label}`} data-menu-trigger="workspace" onClick={menuOpen ? onMenuClose : onMenuOpen} size="icon-sm" title="Workspace actions" type="button" variant="ghost">
        <MoreHorizontal aria-hidden="true" />
      </Button>
      {menuOpen && <WorkspaceDirectoryMenu controller={controller} onClose={onMenuClose} workspace={workspace} />}
    </div>
  )
}

function WorkspaceDirectoryAgentMenu({ controller, identity, onClose, pane }: { controller: AppController; identity: string; onClose: () => void; pane: HerdrPaneView }) {
  const canWrite = controller.identity !== null
  const participant = pane.participant
  const stopAvailable = pane.agentKind !== null && paneStopConfirmation(pane) !== null
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault()
        onClose()
      }
    }
    globalThis.addEventListener("keydown", handleKeyDown)
    return () => globalThis.removeEventListener("keydown", handleKeyDown)
  }, [onClose])
  return (
    <div aria-label={`${identity} actions`} className="absolute right-2 top-7 z-20 min-w-48 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg" data-agent-menu role="menu">
      {participant === null
        ? (
          <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" data-menu-item="connect-pane" disabled={!canWrite} onClick={() => { controller.openConnectPane(pane, identity); onClose() }} role="menuitem" title={canWrite ? "Create a pane-scoped chat identity" : NOT_CONNECTED_REASON} type="button">
            <MessageCirclePlus aria-hidden="true" className="size-4" />
            Connect to Sheppard
          </button>
        )
        : (
          <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" data-menu-item="message" onClick={() => { controller.startDirect(participant); onClose() }} role="menuitem" type="button">
            <MessageCircle aria-hidden="true" className="size-4" />
            Message
          </button>
        )}
      {stopAvailable && (
        <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50" data-menu-item="stop-agent" disabled={!canWrite} onClick={() => { controller.openStopAgent(pane); onClose() }} role="menuitem" title={canWrite ? "Stop agent" : NOT_CONNECTED_REASON} type="button">
          <CircleAlert aria-hidden="true" className="size-4" />
          Stop agent
        </button>
      )}
      <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" data-menu-item={pane.participant === null ? "copy-pane-id" : "copy-handle"} onClick={() => { copyWorkspaceId(pane.participant ?? pane.paneId); onClose() }} role="menuitem" type="button">
        <Copy aria-hidden="true" className="size-4" />
        {pane.participant === null ? "Copy pane id" : "Copy handle"}
      </button>
      {pane.participant !== null && (
        <button className="flex min-h-9 w-full items-center gap-2 rounded-md px-3 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none" data-menu-item="copy-pane-id" onClick={() => { copyWorkspaceId(pane.paneId); onClose() }} role="menuitem" type="button">
          <Copy aria-hidden="true" className="size-4" />
          Copy pane id
        </button>
      )}
    </div>
  )
}

function WorkspaceDirectoryAgentRow({ controller, navigate, pane, workspace }: { controller: AppController; navigate: WorkspaceNavigate; pane: HerdrPaneView; workspace: HerdrWorkspaceView }) {
  const identityDetails = paneIdentityDetails(pane, workspace)
  const identity = identityDetails.label
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const handleMenuRequest = (event: Event): void => {
      if (isContextMenuRequest(event, "pane", pane.paneId)) setMenuOpen(true)
    }
    globalThis.addEventListener("msgr:context-menu", handleMenuRequest)
    return () => globalThis.removeEventListener("msgr:context-menu", handleMenuRequest)
  }, [pane.paneId])
  useEffect(() => {
    if (!menuOpen) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === false) setMenuOpen(false)
    }
    globalThis.addEventListener("pointerdown", closeOnPointerDown)
    return () => globalThis.removeEventListener("pointerdown", closeOnPointerDown)
  }, [menuOpen])
  const open = () => {
    if (pane.participant !== null) {
      navigate({ handle: pane.participant, kind: "agent" })
      return
    }
    controller.openConnectPane(pane, identity)
  }
  return (
    <li
      className={cn("group relative flex h-9 min-w-0 items-center border-t px-3 text-xs", pane.focused && "bg-primary/5")}
      data-agent-row={pane.participant ?? pane.paneId}
      data-identity-source={identityDetails.source}
      data-pane-id={pane.paneId}
      data-pane-status={paneStatusLabel(pane)}
      ref={rootRef}
    >
      <button aria-label={pane.participant === null ? `Connect ${identity} to Sheppard chat` : `Open agent ${pane.participant}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1" data-agent-open={pane.paneId} onClick={open} type="button">
        <AgentStatusMark size={20} status={pane.agentStatus} />
        <span className={cn("min-w-0 flex-1 truncate font-medium", identityDetails.source === "pane-id" && "font-mono text-[11px]")}>{identity}</span>
        <span className="max-w-24 shrink-0 truncate text-muted-foreground">{paneStatusLabel(pane)}</span>
      </button>
      <Button aria-expanded={menuOpen} aria-haspopup="menu" aria-label={`More actions for ${identity}`} className="shrink-0" data-menu-trigger="pane" onClick={() => setMenuOpen((current) => !current)} size="icon-sm" title="Agent actions" type="button" variant="ghost">
        <MoreHorizontal aria-hidden="true" />
      </Button>
      {menuOpen && <WorkspaceDirectoryAgentMenu controller={controller} identity={identity} onClose={() => setMenuOpen(false)} pane={pane} />}
    </li>
  )
}

function WorkspaceCard({ controller, navigate, workspace }: { controller: AppController; navigate: WorkspaceNavigate; workspace: HerdrWorkspaceView }) {
  const label = workspaceLabel(workspace)
  const leadHandle = workspace.panes.find((pane) => pane.role === "lead" && pane.participant !== null)?.participant
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    const handleMenuRequest = (event: Event): void => {
      if (isContextMenuRequest(event, "workspace", workspace.id)) setMenuOpen(true)
    }
    globalThis.addEventListener("msgr:context-menu", handleMenuRequest)
    return () => globalThis.removeEventListener("msgr:context-menu", handleMenuRequest)
  }, [workspace.id])
  const agentPanes = useMemo(
    () => workspace.panes.filter((pane) => pane.agentKind !== null).toSorted(comparePanes),
    [workspace.panes],
  )
  const visiblePanes = agentPanes.slice(0, WORKSPACE_DIRECTORY_AGENT_LIMIT)
  const overflowPanes = agentPanes.slice(WORKSPACE_DIRECTORY_AGENT_LIMIT)
  const emptyPanes = workspace.panes.filter(isEmptyPane).length
  return (
    <article className="relative flex h-full min-h-0 flex-col rounded-xl border bg-card shadow-sm [content-visibility:auto] [contain-intrinsic-size:auto_22rem]" data-workspace-block={workspace.id} data-workspace-card={workspace.id} data-workspace-id={workspace.id}>
      <div className="flex min-w-0 items-start gap-2 p-3" data-workspace-header>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><SquareTerminal aria-hidden="true" className="size-4" /></span>
        <button aria-label={`Open workspace ${label}`} className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1" data-workspace-open={workspace.id} onClick={() => navigate({ kind: "workspace", workspaceId: workspace.id })} type="button">
          <span className="block truncate text-sm font-semibold">{label}</span>
          <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{workspace.id}</span>
        </button>
        <WorkspaceDirectoryActions controller={controller} menuOpen={menuOpen} onMenuClose={() => setMenuOpen(false)} onMenuOpen={() => setMenuOpen(true)} workspace={workspace} />
      </div>
      <dl className="grid grid-cols-3 border-y bg-muted/10 text-center">
        <div className="min-w-0 border-r px-2 py-2"><dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">Tabs</dt><dd className="mt-0.5 text-sm font-semibold tabular-nums">{workspace.tabs.length}</dd></div>
        <div className="min-w-0 border-r px-2 py-2"><dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">Agents</dt><dd className="mt-0.5 text-sm font-semibold tabular-nums">{agentPanes.length}</dd></div>
        <div className="min-w-0 px-2 py-2"><dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">Empty</dt><dd className="mt-0.5 text-sm font-semibold tabular-nums">{emptyPanes}</dd></div>
      </dl>
      <div className="flex min-h-10 items-center px-3 py-2">
        <WorkspaceRuntimeSummary workspace={workspace} />
        {leadHandle !== undefined && <span className="ml-auto max-w-32 truncate rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" data-workspace-lead title={`Lead: ${leadHandle}`}>Lead: {leadHandle}</span>}
      </div>
      <div className="mt-auto border-t bg-muted/5" data-workspace-block-body>
        <div className="flex h-8 items-center justify-between px-3">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Agents</h3>
          <span className="text-[10px] tabular-nums text-muted-foreground">{agentPanes.length}</span>
        </div>
        {visiblePanes.length > 0 && (
          <ul aria-label={`Agents in ${label}`} className="overflow-visible" data-workspace-agent-list>
            {visiblePanes.map((pane) => <WorkspaceDirectoryAgentRow controller={controller} key={pane.paneId} navigate={navigate} pane={pane} workspace={workspace} />)}
          </ul>
        )}
        {overflowPanes.length > 0 && (
          <button aria-label={`Open workspace ${label} with ${overflowPanes.length} more agent panes`} className="flex h-8 w-full items-center border-t px-3 text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground focus-visible:bg-muted/30 focus-visible:outline-none" data-overflow-panes={overflowPanes.length} onClick={() => navigate({ kind: "workspace", workspaceId: workspace.id })} type="button">
            {overflowPanes.length} more agent pane{overflowPanes.length === 1 ? "" : "s"}
          </button>
        )}
        {visiblePanes.length === 0 && <p className="border-t px-3 py-4 text-xs text-muted-foreground">No agents are running.</p>}
      </div>
      <button className="flex h-10 items-center justify-center border-t text-xs font-medium hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => navigate({ kind: "workspace", workspaceId: workspace.id })} type="button">
        Manage workspace
      </button>
    </article>
  )
}

interface WorkspaceDirectoryStateProps extends WorkspacePageProps {
  workspaces: readonly HerdrWorkspaceView[]
}

function WorkspaceDirectoryState({ controller, navigate, workspaces }: WorkspaceDirectoryStateProps) {
  const { workspaceData } = controller
  if (workspaceData.workspaceState.status === "loading" && workspaceData.workspaces.length === 0) {
    return <p className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground" role="status">Loading workspaces…</p>
  }
  if (workspaceData.workspaceState.status === "error") {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5" role="alert">
        <p className="inline-flex items-center gap-2 text-sm text-destructive"><CircleAlert aria-hidden="true" className="size-4" />{workspaceData.workspaceState.message}</p>
        <Button className="mt-4" onClick={workspaceData.reloadWorkspaces} size="sm" type="button" variant="outline">Try again</Button>
      </div>
    )
  }
  if (workspaceData.workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <SquareTerminal aria-hidden="true" className="mx-auto size-7 text-muted-foreground" />
        <h2 className="mt-3 text-base font-semibold">No herdr workspaces are open.</h2>
        <p className="mt-1 text-sm text-muted-foreground">Create a workspace to open panes and control agents.</p>
        <Button className="mt-5" disabled={controller.identity === null} onClick={() => navigate({ kind: "create-workspace" })} title={controller.identity === null ? NOT_CONNECTED_REASON : undefined} type="button" variant="outline">
          <Plus aria-hidden="true" />
          Create workspace
        </Button>
      </div>
    )
  }
  if (workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center">
        <Search aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
        <p className="mt-3 text-sm text-muted-foreground">No workspaces match your search.</p>
        <Button className="mt-4" onClick={() => navigate({ kind: "workspaces" }, true)} size="sm" type="button" variant="outline">Clear Search</Button>
      </div>
    )
  }
  return (
    <div aria-label="Open workspaces" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] items-stretch gap-3" role="list">
      {workspaces.map((workspace) => (
        <div className="h-full" key={workspace.id} role="listitem">
          <WorkspaceCard controller={controller} navigate={navigate} workspace={workspace} />
        </div>
      ))}
    </div>
  )
}

export function WorkspacesDirectoryPage({ controller, navigate, route }: WorkspacePageProps & { route: Extract<ShellRoute, { kind: "workspaces" }> }) {
  const workspaces = controller.workspaceData.settledWorkspaces
  const query = route.query ?? ""
  const filter = route.filter
  const orderedWorkspaces = useMemo(() => workspaces.toSorted(compareWorkspaces), [workspaces])
  const visibleWorkspaces = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return orderedWorkspaces.filter((workspace) => {
      const queryMatches = normalizedQuery.length === 0
        || workspaceLabel(workspace).toLocaleLowerCase().includes(normalizedQuery)
        || workspace.id.toLocaleLowerCase().includes(normalizedQuery)
      if (!queryMatches) return false
      switch (filter) {
        case "with-agents":
          return agentPaneCount(workspace) > 0
        case "needs-attention":
          return workspaceStatusCounts(workspace).blocked > 0 || unmanagedAgentCount(workspace) > 0
        case undefined:
          return true
      }
    })
  }, [filter, orderedWorkspaces, query])
  let paneCount = 0
  let agentCount = 0
  for (const workspace of orderedWorkspaces) {
    paneCount += workspace.panes.length
    agentCount += agentPaneCount(workspace)
  }
  const updateRoute = (nextQuery: string, nextFilter: WorkspaceFilter | undefined): void => {
    const nextRoute: Extract<ShellRoute, { kind: "workspaces" }> = { kind: "workspaces" }
    if (nextQuery.length > 0) nextRoute.query = nextQuery
    if (nextFilter !== undefined) nextRoute.filter = nextFilter
    navigate(nextRoute, true)
  }
  return (
    <div className="w-full space-y-4 p-3 sm:p-4 lg:p-5" data-directory="workspaces" data-directory-list="workspaces">
      <WorkspaceTopologyBanner controller={controller} />
      <div className="grid gap-3 xl:grid-cols-[minmax(22rem,0.7fr)_minmax(24rem,1fr)] xl:items-end">
        <dl className="grid grid-cols-3 overflow-hidden rounded-xl border bg-card">
          <div className="min-w-0 border-r px-3 py-2.5"><dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">Workspaces</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{orderedWorkspaces.length}</dd></div>
          <div className="min-w-0 border-r px-3 py-2.5"><dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">Agents</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{agentCount}</dd></div>
          <div className="min-w-0 px-3 py-2.5"><dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">Panes</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{paneCount}</dd></div>
        </dl>
        <label className="block min-w-0 text-xs font-medium text-muted-foreground" htmlFor="workspace-directory-search">
          Search workspaces
          <span className="mt-1 flex h-10 items-center gap-2 rounded-lg border bg-background px-3 text-foreground focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <input
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:appearance-none"
              id="workspace-directory-search"
              name="workspace-query"
              onChange={(event) => updateRoute(event.target.value, filter)}
              placeholder="Search by name or ID…"
              spellCheck={false}
              type="search"
              value={query}
            />
            {query.length > 0 && <Button aria-label="Clear workspace search" onClick={() => updateRoute("", filter)} size="icon-xs" title="Clear workspace search" type="button" variant="ghost"><X aria-hidden="true" /></Button>}
          </span>
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-3">
        <div className="inline-flex rounded-lg border bg-muted/20 p-0.5" aria-label="Filter workspaces">
          <Button aria-pressed={filter === undefined} className="h-8 px-3 text-xs aria-pressed:bg-background aria-pressed:shadow-sm" onClick={() => updateRoute(query, undefined)} size="sm" type="button" variant="ghost">All</Button>
          <Button aria-pressed={filter === "with-agents"} className="h-8 px-3 text-xs aria-pressed:bg-background aria-pressed:shadow-sm" onClick={() => updateRoute(query, "with-agents")} size="sm" type="button" variant="ghost">With agents</Button>
          <Button aria-pressed={filter === "needs-attention"} className="h-8 px-3 text-xs aria-pressed:bg-background aria-pressed:shadow-sm" onClick={() => updateRoute(query, "needs-attention")} size="sm" type="button" variant="ghost">Needs attention</Button>
        </div>
        <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground" role="status">Showing {visibleWorkspaces.length} of {orderedWorkspaces.length}</p>
      </div>
      <WorkspaceDirectoryState controller={controller} navigate={navigate} workspaces={visibleWorkspaces} />
    </div>
  )
}

type HistoryState =
  | { status: "loading" }
  | { status: "ready"; messages: Message[] }
  | { status: "error"; message: string }

function WorkspaceHistory({ controller, navigate, workspace, workspaceChannel }: { controller: AppController; navigate: WorkspaceNavigate; workspace: HerdrWorkspaceView; workspaceChannel: string | undefined }) {
  const [state, setState] = useState<HistoryState>({ status: "loading" })
  const { api, fallbackApi } = controller
  useEffect(() => {
    let mounted = true
    if (workspaceChannel === undefined) {
      setState({ messages: [], status: "ready" })
      return () => { mounted = false }
    }
    setState({ status: "loading" })
    void apiCall(api, fallbackApi, (client) => client.listMessages(workspaceChannel)).then((result) => {
      if (!mounted) return
      result.match({
        ok: ({ messages }) => setState({ messages: messages.slice(-8), status: "ready" }),
        err: (error) => setState({ message: formatApiError(error), status: "error" }),
      })
    })
    return () => { mounted = false }
  }, [api, fallbackApi, workspaceChannel])

  const openHistory = useCallback(() => {
    if (workspaceChannel === undefined) return
    controller.selectChannel(workspaceChannel, "workspace")
    controller.setFocusedMessageId(undefined)
    navigate({ kind: "current" })
  }, [controller, navigate, workspaceChannel])

  return (
    <section aria-labelledby="workspace-history-heading" className="rounded-xl border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold" id="workspace-history-heading">Broadcast history</h2>
          <p className="mt-1 text-xs text-muted-foreground">Messages sent to {workspaceLabel(workspace)} appear in its workspace channel.</p>
        </div>
        {workspaceChannel !== undefined && <Button onClick={openHistory} size="sm" type="button" variant="outline"><MessageCircle aria-hidden="true" />Open history</Button>}
      </div>
      {state.status === "loading" && <p className="mt-4 text-sm text-muted-foreground" role="status">Loading broadcast history…</p>}
      {state.status === "error" && <p className="mt-4 text-sm text-destructive" role="alert">{state.message}</p>}
      {state.status === "ready" && state.messages.length === 0 && <p className="mt-4 rounded-lg bg-muted/40 px-3 py-3 text-sm text-muted-foreground">No broadcasts have been sent from this workspace.</p>}
      {state.status === "ready" && state.messages.length > 0 && (
        <ol aria-label="Recent workspace broadcasts" className="mt-4 space-y-2">
          {state.messages.map((message) => (
            <li className="rounded-lg bg-muted/40 px-3 py-2" key={message.id}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{message.sender}</span>
                <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleString()}</time>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm">{message.body}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function WorkspaceDetailPage({ controller, navigate, workspaceId }: WorkspacePageProps & { workspaceId: string }) {
  const { workspaceData } = controller
  const workspace = workspaceData.settledWorkspaces.find((candidate) => candidate.id === workspaceId)
  if (workspaceData.workspaceState.status === "loading" && workspace === undefined) {
    return <div className="flex min-h-full items-center justify-center p-6"><p className="text-sm text-muted-foreground" role="status">Loading workspace…</p></div>
  }
  if (workspace === undefined) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center p-6 text-center">
        <CircleAlert aria-hidden="true" className="size-8 text-muted-foreground" />
        <h2 className="mt-4 text-base font-semibold">Workspace unavailable</h2>
        <p className="mt-2 text-sm text-muted-foreground">This workspace is no longer available.</p>
      </div>
    )
  }
  const workspaceChannel = controller.workspaceHistoryChannels.get(workspace.id) ?? workspaceData.workspaceChannelsById.get(workspace.id)
  return (
    <div className="w-full space-y-4 p-4 sm:p-6" data-workspace-view={workspace.id}>
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-xl border p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><SquareTerminal aria-hidden="true" /></span>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Workspace</p>
            <h2 className="mt-1 truncate text-xl font-semibold">{workspaceLabel(workspace)}</h2>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{workspace.id}</p>
            <p className="mt-2 text-sm text-muted-foreground">{workspace.panes.length} panes · {matchedParticipantCount(workspace)} chat links · {unmanagedAgentCount(workspace)} not linked to chat</p>
          </div>
        </div>
        <WorkspaceActionButtons controller={controller} workspace={workspace} />
      </div>
      <WorkspaceTopologyBanner controller={controller} />
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.55fr)]">
        <section aria-labelledby="workspace-panes-heading">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-semibold" id="workspace-panes-heading">Panes and agents</h2>
            <span className="text-xs text-muted-foreground">{agentPaneCount(workspace)} agent pane{agentPaneCount(workspace) === 1 ? "" : "s"}</span>
          </div>
          <WorkspaceTabs controller={controller} navigate={navigate} workspace={workspace} />
        </section>
        <WorkspaceHistory controller={controller} navigate={navigate} workspace={workspace} workspaceChannel={workspaceChannel} />
      </div>
    </div>
  )
}
