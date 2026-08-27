export const SIDEBAR_FAMILIES = ["channels", "direct", "workspaces", "agents"] as const
export type SidebarFamily = (typeof SIDEBAR_FAMILIES)[number]

export const SIDEBAR_ROW_HEIGHT_PX = 24
export const SIDEBAR_SECTION_HEADER_HEIGHT_PX = 28
export const SIDEBAR_HEAD_HEIGHT_PX = 96
export const SIDEBAR_SECTION_GAP_PX = 8
export const SIDEBAR_BODY_PADDING_PX = 16

const sidebarCaps = {
  channels: 0.4,
  direct: 0.2,
  workspaces: 0.4,
  agents: 0,
} satisfies Record<SidebarFamily, number>

export interface SidebarDemand {
  channels: number
  direct: number
  workspaces: number
  agents: number
}

export interface SidebarBudget {
  bodyHeight: number
  rowAreaHeight: number
  slots: number
  grants: Record<SidebarFamily, number>
}

export function sidebarBudget(viewportHeight: number, demand: SidebarDemand): SidebarBudget {
  const bodyHeight = Math.max(0, Math.floor(viewportHeight) - SIDEBAR_HEAD_HEIGHT_PX)
  const sectionChromeHeight = SIDEBAR_SECTION_HEADER_HEIGHT_PX * SIDEBAR_FAMILIES.length
    + SIDEBAR_SECTION_GAP_PX * (SIDEBAR_FAMILIES.length - 1)
    + SIDEBAR_BODY_PADDING_PX
  const rowAreaHeight = Math.max(0, bodyHeight - sectionChromeHeight)
  const slots = Math.floor(rowAreaHeight / SIDEBAR_ROW_HEIGHT_PX)
  const cappedGrant = (family: SidebarFamily): number => Math.min(
    Math.max(0, demand[family]),
    Math.floor(slots * sidebarCaps[family]),
  )
  const grants = {
    channels: cappedGrant("channels"),
    direct: cappedGrant("direct"),
    workspaces: cappedGrant("workspaces"),
    agents: cappedGrant("agents"),
  }

  let free = slots - SIDEBAR_FAMILIES.reduce((total, family) => total + grants[family], 0)
  for (const family of SIDEBAR_FAMILIES) {
    if (free === 0) break
    const unmet = Math.max(0, demand[family] - grants[family])
    const extra = Math.min(free, unmet)
    grants[family] += extra
    free -= extra
  }

  return { bodyHeight, rowAreaHeight, slots, grants }
}

export interface SidebarRowSlice<Row> {
  hidden: Row[]
  visible: Row[]
  hasOverflow: boolean
}

export function sliceSidebarRows<Row>(rows: readonly Row[], grant: number): SidebarRowSlice<Row> {
  const capacity = Math.max(0, Math.floor(grant))
  if (rows.length <= capacity) return { hidden: [], visible: [...rows], hasOverflow: false }

  const visibleCount = Math.max(0, capacity - 1)
  const visible = rows.slice(0, visibleCount)
  return { hidden: rows.slice(visibleCount), visible, hasOverflow: capacity > 0 }
}

export interface SidebarWorkspaceBlock<Row> {
  id: string
  panes: readonly Row[]
}

export interface SidebarWorkspaceSlice<Row> {
  hiddenPanes: Row[]
  hiddenWorkspaces: number
  visible: Array<{ id: string; panes: Row[] }>
  hasOverflow: boolean
}

export function workspaceDemand<Row>(workspaces: readonly SidebarWorkspaceBlock<Row>[]): number {
  return workspaces.reduce((total, workspace) => total + 1 + workspace.panes.length, 0)
}

export function sliceWorkspaceRows<Row>(
  workspaces: readonly SidebarWorkspaceBlock<Row>[],
  grant: number,
): SidebarWorkspaceSlice<Row> {
  const capacity = Math.max(0, Math.floor(grant))
  if (workspaceDemand(workspaces) <= capacity) {
    return {
      hiddenPanes: [],
      hiddenWorkspaces: 0,
      visible: workspaces.map((workspace) => ({ id: workspace.id, panes: [...workspace.panes] })),
      hasOverflow: false,
    }
  }

  const contentCapacity = Math.max(0, capacity - 1)
  const visible: Array<{ id: string; panes: Row[] }> = []
  let used = 0
  let nextWorkspace = 0
  let hiddenPanes: Row[] = []

  for (const workspace of workspaces) {
    if (used >= contentCapacity) break
    used += 1
    const paneCount = Math.min(workspace.panes.length, contentCapacity - used)
    visible.push({ id: workspace.id, panes: workspace.panes.slice(0, paneCount) })
    used += paneCount
    nextWorkspace += 1
    if (paneCount < workspace.panes.length) {
      hiddenPanes = workspace.panes.slice(paneCount)
      break
    }
  }

  const remainingWorkspaces = workspaces.slice(nextWorkspace)
  return {
    hiddenPanes: [...hiddenPanes, ...remainingWorkspaces.flatMap((workspace) => [...workspace.panes])],
    hiddenWorkspaces: remainingWorkspaces.length,
    visible,
    hasOverflow: capacity > 0,
  }
}

export function sumUnread(values: readonly number[]): number {
  return values.reduce((total, value) => total + Math.max(0, value), 0)
}

export function overflowLabel(
  family: SidebarFamily,
  hiddenCount: number,
  hiddenUnread = 0,
  hiddenPanes = 0,
): string {
  switch (family) {
    case "channels":
    case "direct": {
      const unread = hiddenUnread > 0 ? ` · ${hiddenUnread} unread` : ""
      return `${hiddenCount} more${unread}`
    }
    case "workspaces": {
      const workspaceLabel = hiddenCount === 1 ? "workspace" : "workspaces"
      const paneLabel = hiddenPanes === 1 ? "pane" : "panes"
      const workspacePart = hiddenCount > 0 ? `${hiddenCount} more ${workspaceLabel}` : ""
      const panePart = hiddenPanes > 0 ? `${hiddenPanes} ${paneLabel}` : ""
      return [workspacePart, panePart].filter((part) => part.length > 0).join(" · ")
    }
    case "agents":
      return ""
  }
}
