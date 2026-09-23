import { Result, TaggedError } from "better-result"
import type { Channel, DirectConversation, HerdrWorkspaceView, Participant } from "@/api/types"
import type { ShellRoute } from "@/shell-routing"

import {
  COMMAND_SOURCE_LIMIT,
  commandChoice,
  commandEntry,
  type AgentLocation,
  type CommandChoice,
  type CommandEntry,
  type MessageTarget,
} from "./types"

export interface CommandCorpus {
  readonly runtimeState: "ready" | "loading" | "unavailable"
  readonly channels: readonly Channel[]
  readonly direct: readonly DirectConversation[]
  readonly participants: readonly Participant[]
  readonly workspaces: readonly HerdrWorkspaceView[]
  readonly joinedChannels: ReadonlySet<string>
}

export class CommandCatalogTooLarge extends TaggedError("CommandCatalogTooLarge")<{
  readonly message: string
}> {}

/** Uses the explicit pane-to-participant link. Multiple matches stay ambiguous. */
export function agentLocation(workspaces: readonly HerdrWorkspaceView[], handle: string): AgentLocation {
  const matches = workspaces.flatMap((workspace) =>
    workspace.panes.flatMap((pane) => (pane.participant === handle ? [{ pane, workspace }] : [])),
  )
  if (matches.length > 1) return Object.freeze({ kind: "ambiguous" })
  const match = matches[0]
  return Object.freeze(match === undefined ? { kind: "not-running" } : { kind: "running", ...match })
}

type CatalogAgentLocation = AgentLocation | Readonly<{ kind: "loading" | "unavailable" }>

function agentDescription(participant: Participant, location: CatalogAgentLocation): string {
  switch (location.kind) {
    case "loading":
      return `${participant.agentKind ?? "Agent"} · Checking workspace…`
    case "unavailable":
      return `${participant.agentKind ?? "Agent"} · Runtime unavailable`
    case "running":
      return [
        location.workspace.label ?? location.workspace.id,
        location.pane.role,
        participant.agentKind,
        location.pane.agentStatus,
      ]
        .filter(Boolean)
        .join(" · ")
    case "not-running":
      return `${participant.agentKind ?? "Agent"} · Not running · Chat ${participant.routeState}`
    case "ambiguous":
      return `${participant.agentKind ?? "Agent"} · Multiple pane links · Check the workspace`
  }
}

function composeChoice(target: MessageTarget, title: string, description: string): CommandChoice {
  return commandChoice(
    `message:${title}`,
    title,
    description,
    "message",
    { kind: "compose", target },
    "action",
    "send dm chat",
  )
}

function agentCommands(participant: Participant, location: CatalogAgentLocation): readonly CommandChoice[] {
  const handle = participant.handle
  const message = commandChoice(
    `message:${handle}`,
    `Message ${handle}`,
    "A direct message to this agent only",
    "message",
    {
      kind: "compose",
      target: { kind: "agent", handle, routeState: participant.routeState },
    },
    "action",
    "send dm chat",
  )
  const inspect = commandChoice(`open:${handle}`, "Open agent", "Session, messages, and channel activity", "agent", {
    kind: "navigate",
    route: { kind: "agent", handle },
  })
  if (location.kind !== "running") return [message, inspect]
  return [
    message,
    inspect,
    commandChoice(`focus:${handle}`, "Focus terminal", `Open this agent's tab in Herdr`, "focus", {
      kind: "focus-agent",
      handle,
    }),
    commandChoice(`prompt:${handle}`, "Prompt terminal", "Type into the terminal, separate from chat", "terminal", {
      kind: "prompt-agent",
      handle,
    }),
    commandChoice(
      `workspace:${handle}`,
      "Open workspace",
      location.workspace.label ?? location.workspace.id,
      "workspace",
      { kind: "navigate", route: { kind: "workspace", workspaceId: location.workspace.id } },
    ),
    commandChoice(`stop:${handle}`, "Stop agent…", "Stops the process; confirmation is required", "stop", {
      kind: "stop-agent",
      handle,
    }),
  ]
}

function agentEntries(corpus: CommandCorpus): readonly CommandEntry[] {
  const participants = new Map(
    corpus.participants.flatMap((participant) =>
      participant.kind === "agent" ? [[participant.handle, participant] as const] : [],
    ),
  )
  for (const workspace of corpus.workspaces) {
    for (const pane of workspace.panes) {
      if (pane.participant === null || participants.has(pane.participant)) continue
      if (pane.participantRouteState === null) continue
      participants.set(pane.participant, {
        agentKind: pane.agentKind,
        handle: pane.participant,
        kind: "agent",
        routeState: pane.participantRouteState,
      })
    }
  }
  return [...participants.values()]
    .toSorted((a, b) => a.handle.localeCompare(b.handle))
    .map((participant) => {
      const location =
        corpus.runtimeState === "ready"
          ? agentLocation(corpus.workspaces, participant.handle)
          : { kind: corpus.runtimeState }
      const choice = commandChoice(
        `agent:${participant.handle}`,
        participant.handle,
        agentDescription(participant, location),
        "agent",
        {
          kind: "navigate",
          route: { kind: "agent", handle: participant.handle },
        },
        "agent",
        `agent worker ${location.kind === "running" ? (location.pane.title ?? "") : ""}`,
      )
      return commandEntry(
        { ...choice, mark: { kind: "harness", agentKind: participant.agentKind } },
        agentCommands(participant, location),
      )
    })
}

function unconnectedEntries(workspaces: readonly HerdrWorkspaceView[]): readonly CommandEntry[] {
  return workspaces.flatMap((workspace) =>
    workspace.panes.flatMap((pane) => {
      if (pane.agentKind === null || pane.participant !== null) return []
      const label = pane.label ?? pane.agentKind
      const description = `${workspace.label ?? workspace.id} · ${pane.agentKind} · ${pane.agentStatus} · Not connected to chat`
      const connect = commandChoice(
        `connect:${pane.paneId}`,
        "Connect to chat…",
        "Keep the running agent; connect its chat identity",
        "connect",
        { kind: "connect", pane, label },
      )
      const open = commandChoice(
        `workspace:${pane.paneId}`,
        "Open workspace",
        workspace.label ?? workspace.id,
        "workspace",
        { kind: "navigate", route: { kind: "workspace", workspaceId: workspace.id } },
      )
      return [
        commandEntry(
          commandChoice(
            `pane:${pane.paneId}`,
            label,
            description,
            "agent",
            connect.action,
            "agent",
            `${pane.paneId} ${pane.title ?? ""} ${pane.role ?? ""}`,
          ),
          [connect, open],
        ),
      ]
    }),
  )
}

function channelEntries(corpus: CommandCorpus): readonly CommandEntry[] {
  return corpus.channels
    .filter((channel) => channel.kind === "chat")
    .map((channel) => {
      const target: MessageTarget = {
        kind: "channel",
        channel: channel.name,
        membership: corpus.joinedChannels.has(channel.name) ? "joined" : "not-joined",
      }
      const message = composeChoice(target, `Message #${channel.name}`, "Send to all members of this channel")
      const open = commandChoice(
        `channel:${channel.name}`,
        `#${channel.name}`,
        channel.topic ?? "Shared channel",
        "channel",
        { kind: "navigate", route: { kind: "channel", channel: channel.name } },
        "chat",
        "channel",
      )
      const actions =
        target.membership === "joined"
          ? [message]
          : [
              commandChoice(
                `join:${channel.name}`,
                `Join #${channel.name}`,
                "Join to send messages and track unread work",
                "plus",
                { kind: "join-channel", channel: channel.name },
              ),
            ]
      const members = commandChoice(
        `members:${channel.name}`,
        "Manage members",
        `See members and connect agents to #${channel.name}`,
        "agent",
        { kind: "members", channel: channel.name },
      )
      return commandEntry(open, [...actions, members])
    })
}

function directEntries(conversations: readonly DirectConversation[]): readonly CommandEntry[] {
  return conversations.map((conversation) => {
    const label = conversation.participants.join(", ")
    const target: MessageTarget = { kind: "direct", channel: conversation.channel, label }
    return commandEntry(
      commandChoice(
        `direct:${conversation.channel}`,
        label,
        `${conversation.participants.length === 1 ? "Direct message" : "Group conversation"} · ${conversation.unread} unread`,
        "message",
        {
          kind: "navigate",
          route: { kind: "conversation", channel: conversation.channel },
        },
        "direct",
        conversation.channel,
      ),
      [composeChoice(target, `Message ${label}`, "Send to everyone in this conversation")],
    )
  })
}

function workspaceEntries(workspaces: readonly HerdrWorkspaceView[]): readonly CommandEntry[] {
  return workspaces.map((workspace) => {
    const label = workspace.label ?? workspace.id
    const recipients = workspace.panes.flatMap((pane) => (pane.participant === null ? [] : [pane.participant]))
    const broadcast = composeChoice(
      { kind: "broadcast", workspaceId: workspace.id, label, recipients },
      `Broadcast to ${label}`,
      `${recipients.length} connected agents; the recipient list is shown before send`,
    )
    const spawn = commandChoice(`spawn:${workspace.id}`, "Spawn agent…", `Start an agent in ${label}`, "spawn", {
      kind: "spawn",
      location: { kind: "workspace", workspaceId: workspace.id },
    })
    return commandEntry(
      commandChoice(
        `workspace:${workspace.id}`,
        label,
        `${workspace.panes.filter((pane) => pane.agentKind !== null).length} agents · ${workspace.panes.length} panes`,
        "workspace",
        {
          kind: "navigate",
          route: { kind: "workspace", workspaceId: workspace.id },
        },
        "workspace",
        workspace.id,
      ),
      [spawn, broadcast],
    )
  })
}

/** Builds discovery from current snapshots. It performs no API call or mutation. */
export function commandCatalog(corpus: CommandCorpus): Result<readonly CommandEntry[], CommandCatalogTooLarge> {
  let size = corpus.channels.length + corpus.direct.length + corpus.participants.length + corpus.workspaces.length
  if (size <= COMMAND_SOURCE_LIMIT) {
    for (const workspace of corpus.workspaces) {
      size += workspace.panes.length
      if (size > COMMAND_SOURCE_LIMIT) break
    }
  }
  if (size > COMMAND_SOURCE_LIMIT)
    return Result.err(
      new CommandCatalogTooLarge({
        message: `The fleet exceeds the command menu limit of ${COMMAND_SOURCE_LIMIT} items. Use a directory page to find your target.`,
      }),
    )
  const liveWorkspaces = corpus.runtimeState === "ready" ? corpus.workspaces : []
  return Result.ok(
    Object.freeze([
      ...agentEntries(corpus),
      ...unconnectedEntries(liveWorkspaces),
      ...channelEntries(corpus),
      ...directEntries(corpus.direct),
      ...workspaceEntries(liveWorkspaces),
    ]),
  )
}

export function recipientCatalog(entries: readonly CommandEntry[]): readonly CommandEntry[] {
  return entries.flatMap((entry) =>
    entry.alternatives.flatMap((choice) => {
      if (
        choice.action.kind !== "join-channel" &&
        (choice.action.kind !== "compose" || choice.action.target.kind === "broadcast")
      )
        return []
      return [
        commandEntry({
          ...choice,
          id: entry.id,
          title: entry.title,
          description: entry.description,
          group: entry.group,
          keywords: entry.keywords,
          glyph: entry.glyph,
        }),
      ]
    }),
  )
}

/** Page context is explicit. A previously selected channel is not page context. */
export function contextCommands(entries: readonly CommandEntry[], route: ShellRoute): readonly CommandEntry[] {
  let id: string
  switch (route.kind) {
    case "agent":
      id = `agent:${route.handle}`
      break
    case "channel":
      id = `channel:${route.channel}`
      break
    case "conversation":
      id = `direct:${route.channel}`
      break
    case "workspace":
      id = `workspace:${route.workspaceId}`
      break
    default:
      return []
  }
  const entry = entries.find((candidate) => candidate.id === id)
  return (
    entry?.alternatives.flatMap((choice) =>
      choice.action.kind !== "navigate" && choice.action.kind !== "stop-agent"
        ? [commandEntry({ ...choice, group: "context" })]
        : [],
    ) ?? []
  )
}
