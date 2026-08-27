import type { Channel, DirectConversation, HerdrWorkspaceView, Participant } from "@/api/types"

export type QuickSwitcherKind = "chat" | "direct" | "agent" | "workspace" | "page"

export interface QuickSwitcherEntry {
  id: string
  kind: QuickSwitcherKind
  label: string
  name: string
  searchText: string
}

export interface QuickSwitcherCorpus {
  channels: readonly Channel[]
  directConversations: readonly DirectConversation[]
  participants: readonly Participant[]
  workspaces: readonly HerdrWorkspaceView[]
}

function directConversationLabel(conversation: DirectConversation): string {
  return conversation.participants.length === 0
    ? "Direct conversation"
    : conversation.participants.join(", ")
}

function workspaceLabel(workspace: HerdrWorkspaceView): string {
  return workspace.label ?? workspace.id
}

function corpusAgents(corpus: QuickSwitcherCorpus): Participant[] {
  const agents = new Map(
    corpus.participants
      .filter((participant) => participant.kind === "agent")
      .map((participant) => [participant.handle, participant]),
  )
  for (const workspace of corpus.workspaces) {
    for (const pane of workspace.panes) {
      if (pane.participant === null || agents.has(pane.participant)) continue
      agents.set(pane.participant, {
        agentKind: pane.agentKind,
        handle: pane.participant,
        kind: "agent",
        routeState: pane.participantRouteState ?? "active",
      })
    }
  }
  return [...agents.values()]
}

export function quickSwitcherEntries(corpus: QuickSwitcherCorpus): QuickSwitcherEntry[] {
  return [
    {
      id: "page:search",
      kind: "page" as const,
      label: "Search",
      name: "search",
      searchText: "search messages",
    },
    {
      id: "page:attachments",
      kind: "page" as const,
      label: "Attachments",
      name: "attachments",
      searchText: "attachments files",
    },
    ...corpus.channels.map((channel) => ({
      id: `channel:${channel.id}`,
      kind: "chat" as const,
      label: channel.name,
      name: channel.name,
      searchText: channel.name,
    })),
    ...corpus.directConversations.map((conversation) => ({
      id: `direct:${conversation.channel}`,
      kind: "direct" as const,
      label: directConversationLabel(conversation),
      name: conversation.channel,
      searchText: `${conversation.channel} ${directConversationLabel(conversation)}`,
    })),
    ...corpusAgents(corpus).map((participant) => ({
      id: `agent:${participant.handle}`,
      kind: "agent" as const,
      label: participant.handle,
      name: participant.handle,
      searchText: `${participant.handle} ${participant.agentKind ?? ""}`,
    })),
    ...corpus.workspaces.map((workspace) => ({
      id: `workspace:${workspace.id}`,
      kind: "workspace" as const,
      label: workspaceLabel(workspace),
      name: workspace.id,
      searchText: `${workspace.id} ${workspaceLabel(workspace)}`,
    })),
  ]
}

export function quickSwitcherMatches(entries: readonly QuickSwitcherEntry[], query: string): QuickSwitcherEntry[] {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  return entries.filter((entry) => entry.searchText.toLocaleLowerCase().includes(normalizedQuery))
}
