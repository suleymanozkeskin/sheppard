import { Result } from "better-result"

import { INITIAL_BROWSER_POSITION, type CommandBrowserPosition } from "./browser-state"
import type { MessageTarget, SpawnLocation } from "./types"

export type CommandScreen =
  | Readonly<{ kind: "browse" }>
  | Readonly<{ kind: "recipients" }>
  | Readonly<{ kind: "actions"; id: string; title: string }>
  | Readonly<{ kind: "compose"; target: MessageTarget }>
  | Readonly<{ kind: "spawn"; location: SpawnLocation }>
  | Readonly<{ kind: "prompt"; handle: string }>
  | Readonly<{ kind: "join"; channel: string }>

export type CommandChildScreen = Exclude<CommandScreen, { kind: "browse" }>

export interface CommandFrame {
  readonly screen: CommandScreen
  readonly position: CommandBrowserPosition
}

export interface CommandNavigation {
  readonly current: CommandFrame
  readonly parents: readonly CommandFrame[]
}

export const COMMAND_DEPTH_LIMIT = 8
export const ROOT_NAVIGATION: CommandNavigation = Object.freeze({
  current: Object.freeze({ screen: { kind: "browse" as const }, position: INITIAL_BROWSER_POSITION }),
  parents: Object.freeze([]),
})

export type CommandNavigationError = Readonly<{ kind: "depth-limit"; message: string }>

/** Pure transition. A full history is unchanged; Back permits another entry. No I/O or draft changes. */
export function enterCommand(
  navigation: CommandNavigation,
  screen: CommandChildScreen,
): Result<CommandNavigation, CommandNavigationError> {
  if (navigation.parents.length + 1 >= COMMAND_DEPTH_LIMIT)
    return Result.err({
      kind: "depth-limit",
      message: "The command menu reached its depth limit. Go back before opening another level.",
    })
  return Result.ok({
    current: { screen, position: INITIAL_BROWSER_POSITION },
    parents: [...navigation.parents, navigation.current],
  })
}

export type CommandBack = Readonly<{ kind: "close" }> | Readonly<{ kind: "parent"; navigation: CommandNavigation }>

/** Pure transition. Root exits the menu; a child returns to its exact parent. Drafts are not changed. */
export function leaveCommand(navigation: CommandNavigation): CommandBack {
  const parent = navigation.parents.at(-1)
  if (parent === undefined) return { kind: "close" }
  return { kind: "parent", navigation: { current: parent, parents: navigation.parents.slice(0, -1) } }
}

/** Replaces a completed step, such as joining a channel. Back never repeats that step. */
export function replaceCommand(navigation: CommandNavigation, screen: CommandChildScreen): CommandNavigation {
  return { ...navigation, current: { screen, position: INITIAL_BROWSER_POSITION } }
}

export function commandScreenLabel(screen: CommandScreen): string {
  switch (screen.kind) {
    case "browse":
      return "Commands"
    case "actions":
      return screen.title
    case "recipients":
      return "Send a message"
    case "spawn":
      return "Spawn agent"
    case "prompt":
      return "Terminal input"
    case "join":
      return `Join #${screen.channel}`
    case "compose":
      return "Write a message"
  }
  const unhandled: never = screen
  throw new Error(`Command screen has no label: ${JSON.stringify(unhandled)}`)
}
