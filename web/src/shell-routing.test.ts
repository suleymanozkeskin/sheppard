import { describe, expect, test } from "bun:test"

import { shellParentRoute, shellRouteFromLocation, shellRoutePath, type ShellRoute } from "./shell-routing"

describe("shell routes", () => {
  test("round trips control-plane pages", () => {
    const routes: ShellRoute[] = [
      { kind: "current" },
      { kind: "workspaces" },
      { kind: "workspace", workspaceId: "Personal Projects" },
      { kind: "channels" },
      { kind: "channels", membership: "joined", query: "release notes" },
      { kind: "channel", channel: "release-notes" },
      { kind: "channel", channel: "research", messageId: 6 },
      { kind: "direct" },
      { kind: "conversation", channel: "dm-abc123" },
      { kind: "conversation", channel: "dm-abc123", messageId: 7 },
      { kind: "agents" },
      { kind: "agent", handle: "codex-reviewer" },
      { kind: "launchers" },
      { kind: "create-launcher" },
      { kind: "edit-launcher", name: "claude-personal" },
      { kind: "staffing" },
      { kind: "create-role" },
      { kind: "edit-role", name: "lead" },
      { kind: "create-model" },
      { kind: "create-workspace" },
      { kind: "create-channel" },
      { kind: "create-direct" },
      { kind: "spawn-agent" },
      { kind: "spawn-agent", workspaceId: "w1:main" },
      { kind: "spawn-agent", mode: "add-reporter", role: "reporter", workspaceId: "w1:main" },
    ]

    for (const route of routes) {
      const path = shellRoutePath(route)
      const [pathname, search = ""] = path.split("?")
      expect(shellRouteFromLocation({ pathname, search: search.length === 0 ? "" : `?${search}` })).toEqual(route)
    }
  })

  test("accepts a query workspace id for a standalone spawn page", () => {
    expect(shellRouteFromLocation({ pathname: "/agents/new", search: "?workspaceId=w1" })).toEqual({
      kind: "spawn-agent",
      workspaceId: "w1",
    })
  })

  test("uses the current view for unknown paths", () => {
    expect(shellRouteFromLocation({ pathname: "/not-a-page", search: "" })).toEqual({ kind: "current" })
  })

  test("gives every nested page an explicit parent", () => {
    expect(shellParentRoute({ kind: "workspace", workspaceId: "w1" })).toEqual({ kind: "workspaces" })
    expect(shellParentRoute({ channel: "ops", kind: "channel" })).toEqual({ kind: "channels" })
    expect(shellParentRoute({ channel: "dm-1", kind: "conversation" })).toEqual({ kind: "direct" })
    expect(shellParentRoute({ handle: "worker", kind: "agent" })).toEqual({ kind: "agents" })
    expect(shellParentRoute({ kind: "current" })).toBeUndefined()
  })
})
