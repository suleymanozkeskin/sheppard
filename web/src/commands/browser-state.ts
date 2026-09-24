import type { CommandFilter } from "./types"

export interface CommandBrowserPosition {
  readonly query: string
  readonly filter: CommandFilter
  readonly active: number
}

export const INITIAL_BROWSER_POSITION: CommandBrowserPosition = Object.freeze({ query: "", filter: "all", active: 0 })

export function commandOptionId(index: number): string {
  return `command-option-${index}`
}
