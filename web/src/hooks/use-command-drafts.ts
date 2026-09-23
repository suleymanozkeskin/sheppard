import { createContext, useContext, useSyncExternalStore } from "react"
import type { CommandDraftStore } from "@/commands/draft-store"

export const CommandDraftContext = createContext<CommandDraftStore | null>(null)

export function useCommandDrafts() {
  const store = useContext(CommandDraftContext)
  if (store === null) throw new Error("Command draft views require CommandDraftProvider")
  const drafts = useSyncExternalStore(store.subscribe, store.snapshot)
  return { store, drafts }
}
