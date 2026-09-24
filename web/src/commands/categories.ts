import type { CommandCategoryIntent } from "./navigation-keys"
import type { CommandFilter } from "./types"

export const COMMAND_CATEGORIES = Object.freeze([
  Object.freeze({ value: "all", label: "All", prefix: "" }),
  Object.freeze({ value: "agent", label: "Agents", prefix: "@" }),
  Object.freeze({ value: "chat", label: "Channels", prefix: "#" }),
  Object.freeze({ value: "workspace", label: "Workspaces", prefix: "" }),
  Object.freeze({ value: "action", label: "Actions", prefix: ">" }),
] as const)

/** Moves in the fixed category list, wrapping at either end. No I/O or command execution. */
export function moveCommandCategory(filter: CommandFilter, intent: CommandCategoryIntent): CommandFilter {
  const index = COMMAND_CATEGORIES.findIndex((category) => category.value === filter)
  if (index < 0) throw new Error(`Command category ${filter} has no entry in its fixed list`)
  const last = COMMAND_CATEGORIES.length - 1
  let next: number
  switch (intent) {
    case "next-category":
      next = (index + 1) % COMMAND_CATEGORIES.length
      break
    case "previous-category":
      next = (index + last) % COMMAND_CATEGORIES.length
      break
    case "first-category":
      next = 0
      break
    case "last-category":
      next = last
      break
    default: {
      const unhandled: never = intent
      throw new Error(`Command categories have no handler for intent ${unhandled}`)
    }
  }
  const category = COMMAND_CATEGORIES[next]
  if (category === undefined) throw new Error("Command category movement produced an index outside its fixed list")
  return category.value
}
