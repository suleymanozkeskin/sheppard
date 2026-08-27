import { describe, expect, test } from "bun:test"

import type { Channel, DirectConversation, HerdrWorkspaceView, Participant } from "@/api/types"
import { quickSwitcherEntries, quickSwitcherMatches } from "@/quick-switcher"

const channel: Channel = {
  id: 1,
  kind: "chat",
  lastMessageAt: null,
  memberCount: 0,
  messageCount: 0,
  name: "north-channel",
  topic: null,
}

const directConversation: DirectConversation = {
  channel: "dm-delta",
  participants: ["delta-agent"],
  unread: 0,
}

const participant: Participant = {
  agentKind: "codex",
  handle: "bravo-agent",
  kind: "agent",
  routeState: "active",
}

const workspace: HerdrWorkspaceView = {
  id: "workspace-charlie",
  label: "charlie-workspace",
  panes: [],
  tabs: [],
}

describe("quick switcher corpus", () => {
  const entries = quickSwitcherEntries({
    channels: [channel],
    directConversations: [directConversation],
    participants: [participant],
    workspaces: [workspace],
  })

  test("finds each object kind by its own name", () => {
    const matches = [
      ["north-channel", "chat"],
      ["dm-delta", "direct"],
      ["bravo-agent", "agent"],
      ["charlie-workspace", "workspace"],
    ] as const

    for (const [query, kind] of matches) {
      expect(quickSwitcherMatches(entries, query).map((entry) => entry.kind)).toEqual([kind])
    }
  })

  test("adds pane agents when the participant list is incomplete", () => {
    const paneAgentEntries = quickSwitcherEntries({
      channels: [],
      directConversations: [],
      participants: [],
      workspaces: [{
        ...workspace,
        panes: [{
          agentKind: "claude",
          agentStatus: "working",
          focused: true,
          label: "terminal",
          paneId: "pane-1",
          participant: "echo-agent",
          participantRouteState: "active",
        }],
      }],
    })

    expect(paneAgentEntries).toEqual([{
      id: "page:search",
      kind: "page",
      label: "Search",
      name: "search",
      searchText: "search messages",
    }, {
      id: "page:attachments",
      kind: "page",
      label: "Attachments",
      name: "attachments",
      searchText: "attachments files",
    }, {
      id: "agent:echo-agent",
      kind: "agent",
      label: "echo-agent",
      name: "echo-agent",
      searchText: "echo-agent claude",
    }, {
      id: "workspace:workspace-charlie",
      kind: "workspace",
      label: "charlie-workspace",
      name: "workspace-charlie",
      searchText: "workspace-charlie charlie-workspace",
    }])
  })
})
