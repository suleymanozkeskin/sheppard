import { useEffect, useState, type ReactNode } from "react"

import { CommandReturnContext, type CommandDialog } from "@/hooks/use-command-return"
import type { AppController } from "@/hooks/use-app-controller"
import type { ShellRoute, ShellRouter } from "@/shell-routing"

type ReturnState =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "dialog"
      dialog: CommandDialog
      origin: ShellRoute
      label: string
      onNavigate: () => void
    }>

function dialogOpen(controller: AppController, dialog: CommandDialog): boolean {
  switch (dialog) {
    case "members":
      return controller.membersOpen
    case "connect":
      return controller.connectPaneTarget !== undefined
    case "stop-agent":
      return controller.stopAgentOpen
    case "settings":
      return controller.settingsOpen
    case "inbox":
      return controller.inboxOpen
    case "help":
      return controller.helpOpen
  }
  const unhandled: never = dialog
  throw new Error(`Command dialog has no open state: ${JSON.stringify(unhandled)}`)
}

/** Dialog dismissal resumes the menu. Page navigation ends the command flow. Does not retry writes. */
export function CommandReturnProvider({
  controller,
  router,
  children,
}: {
  controller: AppController
  router: ShellRouter
  children: ReactNode
}) {
  const [state, setState] = useState<ReturnState>({ kind: "none" })
  const route = router.route
  const open = state.kind === "dialog" && dialogOpen(controller, state.dialog)
  const setMenuOpen = controller.setChannelPickerOpen
  useEffect(() => {
    if (state.kind === "none") return
    // The router replaces its route on navigation, including a selection of the current page.
    if (route !== state.origin) {
      state.onNavigate()
      setState({ kind: "none" })
      return
    }
    if (open) return
    setState({ kind: "none" })
    setMenuOpen(true)
  }, [open, route, setMenuOpen, state])
  return (
    <CommandReturnContext
      value={{
        destination: state.kind === "none" ? { kind: "none" } : { kind: "menu", label: state.label },
        suspend: (dialog, label, onNavigate) => {
          setState({ kind: "dialog", dialog, origin: route, label, onNavigate })
          setMenuOpen(false)
        },
        dismiss: () => {
          setState({ kind: "none" })
          setMenuOpen(false)
        },
      }}
    >
      {children}
    </CommandReturnContext>
  )
}
