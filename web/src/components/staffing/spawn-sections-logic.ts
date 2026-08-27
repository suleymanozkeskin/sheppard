import { createElement, type ReactNode } from "react"
import { Bot, Crown, FlaskConical, Globe2, Hammer, ListChecks, Palette, Radio } from "lucide-react"

import type { HerdrWorkspaceView, RolePreset } from "@/api/types"
import type { ComboboxOption } from "@/components/ui/combobox"
import { NO_ROLE_VALUE } from "./spawn-state"

const DEFAULT_ROLE_APPEARANCE = {
  iconClassName: "text-indigo-700 dark:text-indigo-300",
  iconSurfaceClassName: "bg-indigo-500/10 ring-indigo-500/20",
  panelClassName: "border-t-indigo-500/70",
  selectedClassName: "border-l-indigo-500 bg-indigo-500/10",
}

export function roleAppearance(roleName: string) {
  switch (roleName) {
    case "lead": return { iconClassName: "text-amber-700 dark:text-amber-300", iconSurfaceClassName: "bg-amber-500/10 ring-amber-500/20", panelClassName: "border-t-amber-500/70", selectedClassName: "border-l-amber-500 bg-amber-500/10" }
    case "planner": return { iconClassName: "text-violet-700 dark:text-violet-300", iconSurfaceClassName: "bg-violet-500/10 ring-violet-500/20", panelClassName: "border-t-violet-500/70", selectedClassName: "border-l-violet-500 bg-violet-500/10" }
    case "reporter": return { iconClassName: "text-cyan-700 dark:text-cyan-300", iconSurfaceClassName: "bg-cyan-500/10 ring-cyan-500/20", panelClassName: "border-t-cyan-500/70", selectedClassName: "border-l-cyan-500 bg-cyan-500/10" }
    case "tester": return { iconClassName: "text-emerald-700 dark:text-emerald-300", iconSurfaceClassName: "bg-emerald-500/10 ring-emerald-500/20", panelClassName: "border-t-emerald-500/70", selectedClassName: "border-l-emerald-500 bg-emerald-500/10" }
    case "ui-ux-designer": return { iconClassName: "text-pink-700 dark:text-pink-300", iconSurfaceClassName: "bg-pink-500/10 ring-pink-500/20", panelClassName: "border-t-pink-500/70", selectedClassName: "border-l-pink-500 bg-pink-500/10" }
    case "web-searcher": return { iconClassName: "text-sky-700 dark:text-sky-300", iconSurfaceClassName: "bg-sky-500/10 ring-sky-500/20", panelClassName: "border-t-sky-500/70", selectedClassName: "border-l-sky-500 bg-sky-500/10" }
    case "worker": return { iconClassName: "text-orange-700 dark:text-orange-300", iconSurfaceClassName: "bg-orange-500/10 ring-orange-500/20", panelClassName: "border-t-orange-500/70", selectedClassName: "border-l-orange-500 bg-orange-500/10" }
    default: return DEFAULT_ROLE_APPEARANCE
  }
}

export function roleIcon(roleName: string): ReactNode {
  const className = `size-5 ${roleAppearance(roleName).iconClassName}`
  switch (roleName) {
    case "lead": return createElement(Crown, { "aria-hidden": "true", className })
    case "reporter": return createElement(Radio, { "aria-hidden": "true", className })
    case "planner": return createElement(ListChecks, { "aria-hidden": "true", className })
    case "web-searcher": return createElement(Globe2, { "aria-hidden": "true", className })
    case "tester": return createElement(FlaskConical, { "aria-hidden": "true", className })
    case "ui-ux-designer": return createElement(Palette, { "aria-hidden": "true", className })
    case "worker": return createElement(Hammer, { "aria-hidden": "true", className })
    default: return createElement(Bot, { "aria-hidden": "true", className })
  }
}

export function workspaceOptions(workspaces: readonly HerdrWorkspaceView[]): ComboboxOption[] {
  return workspaces.map((workspace) => ({ label: workspace.label ?? workspace.id, sublabel: workspace.id, value: workspace.id }))
}

export function roleOptions(roles: readonly RolePreset[]): ComboboxOption[] {
  return [...roles.toSorted((left, right) => left.name.localeCompare(right.name)).map((role) => ({ label: role.name, leading: roleIcon(role.name), sublabel: role.summary, value: role.name })), { label: "No role", leading: createElement(Bot, { "aria-hidden": "true", className: "size-5" }), sublabel: "Choose fields manually", value: NO_ROLE_VALUE }]
}
