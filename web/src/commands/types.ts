import type { HerdrPaneView, HerdrWorkspaceView, RouteState } from "@/api/types"
import type { ShellRoute } from "@/shell-routing"
import type { ThemeMode } from "@/theme"

export const COMMAND_QUERY_LIMIT = 160
export const COMMAND_RESULT_LIMIT = 40
export const COMMAND_RECENT_LIMIT = 6
export const COMMAND_MESSAGE_LIMIT = 65_536
export const COMMAND_SOURCE_LIMIT = 5_000

export type CommandFilter = "all" | "agent" | "chat" | "workspace" | "action"
export type CommandGroup = "context" | "recent" | "action" | "agent" | "chat" | "direct" | "workspace" | "page"
export type CommandGlyph = "agent" | "channel" | "message" | "workspace" | "spawn" | "search" | "file" | "settings" | "role" | "terminal" | "focus" | "stop" | "connect" | "inbox" | "theme" | "keyboard" | "plus"

export type MessageTarget =
  | Readonly<{ kind: "agent"; handle: string; routeState: RouteState }>
  | Readonly<{ kind: "channel"; channel: string; membership: "joined" | "not-joined" }>
  | Readonly<{ kind: "direct"; channel: string; label: string }>
  | Readonly<{ kind: "broadcast"; workspaceId: string; label: string; recipients: readonly string[] }>

export type SpawnLocation = Readonly<{ kind: "choose" }> | Readonly<{ kind: "workspace"; workspaceId: string }>

export type CommandAction =
  | Readonly<{ kind: "navigate"; route: ShellRoute }>
  | Readonly<{ kind: "compose"; target: MessageTarget }>
  | Readonly<{ kind: "recipients" }>
  | Readonly<{ kind: "spawn"; location: SpawnLocation }>
  | Readonly<{ kind: "focus-agent"; handle: string }>
  | Readonly<{ kind: "prompt-agent"; handle: string }>
  | Readonly<{ kind: "stop-agent"; handle: string }>
  | Readonly<{ kind: "connect"; pane: HerdrPaneView; label: string }>
  | Readonly<{ kind: "join-channel"; channel: string }>
  | Readonly<{ kind: "shell"; name: "inbox" | "settings" | "help" | "create-channel" | "create-workspace" }>
  | Readonly<{ kind: "theme"; mode: ThemeMode }>

export type CommandAvailability = Readonly<{ kind: "available" }> | Readonly<{ kind: "unavailable"; reason: string }>

export interface CommandChoice {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly keywords: string
  readonly group: CommandGroup
  readonly glyph: CommandGlyph
  readonly action: CommandAction
  readonly availability: CommandAvailability
}

export interface CommandEntry extends CommandChoice {
  readonly alternatives: readonly CommandChoice[]
}

export type AgentLocation =
  | Readonly<{ kind: "running"; pane: HerdrPaneView; workspace: HerdrWorkspaceView }>
  | Readonly<{ kind: "not-running" }>
  | Readonly<{ kind: "ambiguous" }>

export const AVAILABLE: CommandAvailability = Object.freeze({ kind: "available" })

/** Constructs an immutable display choice. It does not execute its action. */
export function commandChoice(id: string, title: string, description: string, glyph: CommandGlyph, action: CommandAction, group: CommandGroup = "action", keywords = "", availability: CommandAvailability = AVAILABLE): CommandChoice {
  return Object.freeze({ id, title, description, glyph, action, group, keywords, availability })
}

export function commandEntry(choice: CommandChoice, alternatives: readonly CommandChoice[] = []): CommandEntry {
  return Object.freeze({ ...choice, alternatives: Object.freeze([...alternatives]) })
}

export function messageTargetLabel(target: MessageTarget): string {
  switch (target.kind) {
    case "agent": return target.handle
    case "channel": return `#${target.channel}`
    case "direct": return target.label
    case "broadcast": return target.label
  }
}

export function messageTargetKey(target: MessageTarget): string {
  switch (target.kind) {
    case "agent": return `agent:${target.handle}`
    case "channel": return `channel:${target.channel}`
    case "direct": return `direct:${target.channel}`
    case "broadcast": return `broadcast:${target.workspaceId}`
  }
}
