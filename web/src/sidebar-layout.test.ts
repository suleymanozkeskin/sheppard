import { describe, expect, test } from "bun:test"

import {
  overflowLabel,
  SIDEBAR_ROW_HEIGHT_PX,
  sidebarBudget,
  sliceSidebarRows,
  sliceWorkspaceRows,
  workspaceDemand,
} from "./sidebar-layout"

describe("sidebar row budget", () => {
  test("uses 24px slots and distributes the 40/20/40 caps", () => {
    const budget = sidebarBudget(900, { channels: 100, direct: 100, workspaces: 100, agents: 0 })

    expect(SIDEBAR_ROW_HEIGHT_PX).toBe(24)
    expect(budget.slots).toBe(27)
    expect(budget.grants).toEqual({ channels: 12, direct: 5, workspaces: 10, agents: 0 })
  })

  test("gives unused slots to the first unmet family", () => {
    const budget = sidebarBudget(900, { channels: 15, direct: 4, workspaces: 3, agents: 0 })

    expect(budget.grants).toEqual({ channels: 15, direct: 4, workspaces: 3, agents: 0 })
  })

  test("keeps an overflow slot when a family is truncated", () => {
    const slice = sliceSidebarRows(["quiet", "unread", "old"], 2)

    expect(slice.visible).toEqual(["quiet"])
    expect(slice.hidden).toEqual(["unread", "old"])
    expect(slice.hasOverflow).toBe(true)
    expect(overflowLabel("channels", slice.hidden.length, 4)).toBe("2 more · 4 unread")
  })

  test("retains workspace parents and counts hidden panes separately", () => {
    const workspaces = [
      { id: "one", panes: ["a", "b"] },
      { id: "two", panes: ["c"] },
      { id: "three", panes: ["d", "e"] },
    ]

    expect(workspaceDemand(workspaces)).toBe(8)
    const slice = sliceWorkspaceRows(workspaces, 4)

    expect(slice.visible).toEqual([{ id: "one", panes: ["a", "b"] }])
    expect(slice.hiddenWorkspaces).toBe(2)
    expect(slice.hiddenPanes).toEqual(["c", "d", "e"])
    expect(overflowLabel("workspaces", slice.hiddenWorkspaces, 0, slice.hiddenPanes.length))
      .toBe("2 more workspaces · 3 panes")
  })
})
