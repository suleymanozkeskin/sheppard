import { useMemo } from "react"
import { Bot, ChevronRight, MessageCircle, MessageCirclePlus, SquareTerminal } from "lucide-react"

import type { HerdrPaneView, HerdrWorkspaceView } from "@/api/types"
import { Button } from "@/components/ui/button"
import { AgentStatusMark } from "@/components/agent-status-mark"
import type { AppController } from "@/hooks/use-app-controller"
import { paneIdentity, paneStatusLabel, workspaceLabel as formatWorkspaceLabel } from "@/workspace-presentation"
import type { ShellRouter } from "@/shell-routing"

export { AgentWorkbench as AgentDetailPage } from "./agents/agent-workbench"

interface AgentEntry {
  identity: string
  pane: HerdrPaneView
  workspace: HerdrWorkspaceView
}

const statusPriority = {
  working: 0,
  blocked: 1,
  idle: 2,
  done: 3,
  unknown: 4,
} satisfies Record<HerdrPaneView["agentStatus"], number>

function collectAgents(workspaces: readonly HerdrWorkspaceView[]): AgentEntry[] {
  return workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) =>
    pane.agentKind === null ? [] : [{ identity: paneIdentity(pane, workspace), pane, workspace }],
  )).toSorted((left, right) =>
    statusPriority[left.pane.agentStatus] - statusPriority[right.pane.agentStatus]
      || left.identity.localeCompare(right.identity)
      || left.pane.paneId.localeCompare(right.pane.paneId),
  )
}

function AgentMeta({ entry }: { entry: AgentEntry }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{formatWorkspaceLabel(entry.workspace)}</span>
      <span>pane {entry.pane.paneId}</span>
      {entry.pane.role !== undefined && entry.pane.role !== null && <span data-agent-role={entry.pane.role}>role {entry.pane.role}</span>}
    </div>
  )
}

function AgentEntryCard({ entry, onConnect, onMessage, onOpen, onOpenWorkspace }: { entry: AgentEntry; onConnect: () => void; onMessage: () => void; onOpen: () => void; onOpenWorkspace: () => void }) {
  const linked = entry.pane.participant !== null
  const routeState = entry.pane.participantRouteState
  return (
    <li className="overflow-hidden rounded-xl border bg-card transition-colors hover:bg-muted/40" data-agent-row={entry.identity}>
      <button aria-label={linked ? `Open agent ${entry.identity}` : `Connect ${entry.identity} to Sheppard chat`} className="flex min-h-16 w-full min-w-0 items-center gap-3 px-4 py-3 text-left" onClick={onOpen} type="button">
        <AgentStatusMark size={20} status={entry.pane.agentStatus} />
        <span className="min-w-0 flex-1" data-agent-identity>
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="truncate font-medium">{entry.identity}</span>
            <span className="text-sm text-muted-foreground">{entry.pane.agentKind}</span>
          </span>
          <AgentMeta entry={entry} />
        </span>
        <span className="shrink-0 text-right text-xs">
          <span className="block font-medium capitalize text-foreground">{paneStatusLabel(entry.pane)}</span>
          <span className="mt-1 block text-muted-foreground">
            {linked ? routeState === "active" ? "Chat connected" : "Chat unavailable" : "Not connected"}
          </span>
        </span>
        {linked
          ? <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          : <SquareTerminal aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
      </button>
      <div className="flex items-center justify-end gap-1 border-t px-3 py-1.5">
        {linked
          ? <Button onClick={onMessage} size="sm" type="button" variant="ghost"><MessageCircle aria-hidden="true" />Message</Button>
          : <Button onClick={onConnect} size="sm" type="button" variant="ghost"><MessageCirclePlus aria-hidden="true" />Connect to chat</Button>}
        <Button onClick={onOpenWorkspace} size="sm" type="button" variant="ghost">Workspace</Button>
      </div>
    </li>
  )
}

export function AgentsDirectoryPage({ controller, navigate }: { controller: AppController; navigate: ShellRouter["navigate"] }) {
  const agents = useMemo(() => collectAgents(controller.workspaceData.settledWorkspaces), [controller.workspaceData.settledWorkspaces])
  return (
    <div className="w-full space-y-5 p-4 sm:p-6" data-directory="agents">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Herdr pane status and chat link state are shown separately.</p>
        <Button onClick={() => navigate({ kind: "launchers" })} size="sm" type="button" variant="ghost">Manage launchers</Button>
      </div>

      {controller.workspaceData.workspaceState.status === "loading" && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground" role="status">Loading agents…</p>}
      {controller.workspaceData.workspaceState.status === "error" && <p className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive" role="alert">{controller.workspaceData.workspaceState.message}</p>}
      {controller.workspaceData.workspaceState.status === "ready" && agents.length === 0 && (
        <div className="rounded-xl border border-dashed p-8 text-center">
          <Bot aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">Herdr reports no agent panes.</p>
        </div>
      )}
      {controller.workspaceData.workspaceState.status === "ready" && agents.length > 0 && (
        <ul aria-label="Agent directory" className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3" role="list">
          {agents.map((entry) => (
            <AgentEntryCard
              entry={entry}
              key={`${entry.workspace.id}:${entry.pane.paneId}`}
              onConnect={() => controller.openConnectPane(entry.pane, entry.identity)}
              onMessage={() => { if (entry.pane.participant !== null) controller.startDirect(entry.pane.participant) }}
              onOpen={() => entry.pane.participant === null
                ? controller.openConnectPane(entry.pane, entry.identity)
                : navigate({ handle: entry.pane.participant, kind: "agent" })}
              onOpenWorkspace={() => navigate({ kind: "workspace", workspaceId: entry.workspace.id })}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
