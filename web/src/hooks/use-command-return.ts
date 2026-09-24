import { createContext, useContext } from "react"

export type CommandDialog = "members" | "connect" | "stop-agent" | "settings" | "inbox" | "help"
export type CommandReturn = Readonly<{ kind: "none" }> | Readonly<{ kind: "menu"; label: string }>

export interface CommandReturnContextValue {
  readonly destination: CommandReturn
  readonly suspend: (dialog: CommandDialog, label: string, onNavigate: () => void) => void
  readonly dismiss: () => void
}

export const CommandReturnContext = createContext<CommandReturnContextValue | null>(null)

/** Optional outside the application shell. No side effects. */
export function useCommandReturn(): CommandReturnContextValue | null {
  return useContext(CommandReturnContext)
}
