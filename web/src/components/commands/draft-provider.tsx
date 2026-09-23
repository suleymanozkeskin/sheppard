import { useEffect, useState, type ReactNode } from "react"
import { CommandDraftStore } from "@/commands/draft-store"
import { CommandDraftContext, useCommandDrafts } from "@/hooks/use-command-drafts"

export function CommandDraftProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new CommandDraftStore())
  return (
    <CommandDraftContext value={store}>
      {children}
      <DraftUnloadWarning />
    </CommandDraftContext>
  )
}

function DraftUnloadWarning() {
  const { drafts } = useCommandDrafts()
  const hasDrafts = drafts.size > 0
  useEffect(() => {
    if (!hasDrafts) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [hasDrafts])
  return null
}
