import type {
  AttachmentMeta,
  Channel,
  ChannelReceipt,
  DirectConversation,
  InboxEntry,
  Launcher,
  Member,
  ModelCatalogueSnapshot,
  ModelEntry,
  Message,
  RoleDefinition,
  SearchResult,
  SessionSource,
  SessionTurn,
  HerdrWorkspaceView,
} from "./types"

export const mockAttachments: AttachmentMeta[] = [
  {
    id: 101,
    path: "/Users/demo/notes/rollout.png",
    displayName: "rollout.png",
    byteSize: 48_210,
    mediaType: "image/png",
    previewEligible: true,
    previewKind: "image",
  },
  {
    id: 102,
    path: "/Users/demo/notes/runbook.pdf",
    displayName: "runbook.pdf",
    byteSize: 182_004,
    mediaType: "application/pdf",
    previewEligible: false,
    previewKind: null,
  },
  {
    id: 103,
    path: "/Users/demo/notes/release-notes.md",
    displayName: "release-notes.md",
    byteSize: 184,
    mediaType: "text/markdown",
    previewEligible: true,
    previewKind: "markdown",
  },
]

export const mockChannels: Channel[] = [
  {
    id: 1,
    kind: "chat",
    name: "ops",
    topic: "Deployments, incidents, and hand-offs",
    memberCount: 4,
    messageCount: 6,
    lastMessageAt: "2026-08-17T09:47:00.000Z",
  },
  {
    id: 2,
    kind: "chat",
    name: "research",
    topic: "Findings that need review",
    memberCount: 3,
    messageCount: 3,
    lastMessageAt: "2026-08-16T15:02:00.000Z",
  },
  {
    id: 3,
    kind: "chat",
    name: "handoff",
    topic: null,
    memberCount: 3,
    messageCount: 2,
    lastMessageAt: "2026-08-12T08:11:00.000Z",
  },
]

export const mockDirectChannels: Channel[] = [
  {
    id: 101,
    kind: "direct",
    name: "dm-planner-runner",
    topic: null,
    memberCount: 2,
    messageCount: 2,
    lastMessageAt: "2026-08-17T09:50:00.000Z",
  },
]

export const mockDirectConversations: DirectConversation[] = [
  {
    channel: "dm-planner-runner",
    participants: ["planner", "runner"],
    unread: 1,
  },
]

export const mockWorkspaces: HerdrWorkspaceView[] = [
  {
    id: "workspace-sheppard",
    label: "sheppard",
    panes: [
      {
        paneId: "pane-web",
        label: "web",
        agentKind: "codex",
        agentStatus: "working",
        focused: true,
        participant: "codex-reviewer",
        participantRouteState: "active",
      },
      {
        paneId: "pane-server",
        label: "server",
        agentKind: "claude",
        agentStatus: "idle",
        focused: false,
        participant: "server-worker",
        participantRouteState: "active",
      },
    ],
    tabs: [{
      id: "tab-sheppard-main",
      label: "Main",
      panes: [
        {
          paneId: "pane-web",
          label: "web",
          agentKind: "codex",
          agentStatus: "working",
          focused: true,
          participant: "codex-reviewer",
          participantRouteState: "active",
        },
        {
          paneId: "pane-server",
          label: "server",
          agentKind: "claude",
          agentStatus: "idle",
          focused: false,
          participant: "server-worker",
          participantRouteState: "active",
        },
      ],
    }],
  },
]

export const mockHarnesses = ["claude", "codex", "pi", "opencode"]

export const mockLaunchers: Launcher[] = [
  { name: "claude-personal", agentKind: "claude", argv: ["claude", "--profile", "personal"], envKeys: ["CLAUDE_CONFIG_DIR"], startTimeoutMs: 35_000 },
  { name: "claude-work", agentKind: "claude", argv: ["claude", "--profile", "work"], envKeys: ["CLAUDE_CONFIG_DIR"], startTimeoutMs: 35_000 },
  { name: "codex", agentKind: "codex", argv: ["codex"], envKeys: [], startTimeoutMs: 35_000 },
  { name: "opencode", agentKind: "opencode", argv: ["opencode"], envKeys: [], startTimeoutMs: 35_000 },
  { name: "pi", agentKind: "pi", argv: ["pi"], envKeys: [], startTimeoutMs: 35_000 },
]

export const mockModels: ModelEntry[] = [
  { harness: "claude", name: "opus", label: "Opus" },
  { harness: "claude", name: "sonnet", label: "Sonnet" },
  { harness: "codex", name: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
]

export const mockModelCatalogue: ModelCatalogueSnapshot = {
  catalogues: [
    {
      launcher: "claude-personal",
      harness: "claude",
      status: "default-only",
      error: null,
      revision: 1,
      models: [{ default: true, description: "Uses the model configured by this launcher.", efforts: [], label: "Harness default", name: "default", resolvedModel: null }],
      executableAvailable: true,
      checkedAt: "2026-08-23T08:00:00.000Z",
      fetchedAt: "2026-08-23T08:00:00.000Z",
      freshUntil: "2026-08-23T13:00:00.000Z",
    },
    {
      launcher: "claude-work",
      harness: "claude",
      status: "ready",
      error: null,
      revision: 2,
      models: [{ default: true, description: "Work launcher model.", efforts: [{ default: true, description: "Balanced work planning.", name: "work-medium" }], label: "Work model", name: "work-model", resolvedModel: "anthropic/work-model" }],
      executableAvailable: true,
      checkedAt: "2026-08-23T08:00:00.000Z",
      fetchedAt: "2026-08-23T08:00:00.000Z",
      freshUntil: "2026-08-23T13:00:00.000Z",
    },
    {
      launcher: "codex",
      harness: "codex",
      status: "ready",
      error: null,
      revision: 1,
      models: [{
        default: true,
        efforts: [
          { default: false, description: "Faster responses with less planning.", name: "low" },
          { default: true, description: "Balanced planning and speed.", name: "medium" },
          { default: false, description: "More planning for complex tasks.", name: "high" },
        ],
        description: "A coding model discovered on this device.",
        label: "GPT-5.6 Sol",
        name: "gpt-5.6-sol",
        resolvedModel: "gpt-5.6-sol",
      }],
      executableAvailable: true,
      checkedAt: "2026-08-23T08:00:00.000Z",
      fetchedAt: "2026-08-23T08:00:00.000Z",
      freshUntil: "2026-08-23T13:00:00.000Z",
    },
    {
      launcher: "opencode",
      harness: "opencode",
      status: "ready",
      error: null,
      revision: 1,
      models: [{
        default: true,
        efforts: [{ default: true, description: "OpenCode adapter default.", name: "default" }],
        description: "A model discovered by OpenCode on this device.",
        label: "Claude Sonnet 4",
        name: "anthropic/claude-sonnet-4",
        resolvedModel: "anthropic/claude-sonnet-4",
      }],
      executableAvailable: true,
      checkedAt: "2026-08-23T08:00:00.000Z",
      fetchedAt: "2026-08-23T08:00:00.000Z",
      freshUntil: "2026-08-23T13:00:00.000Z",
    },
    {
      launcher: "pi",
      harness: "pi",
      status: "ready",
      error: null,
      revision: 1,
      models: [{
        default: true,
        efforts: [],
        description: "A model discovered by Pi on this device.",
        label: "GPT-5",
        name: "openai/gpt-5",
        resolvedModel: "openai/gpt-5",
      }],
      executableAvailable: true,
      checkedAt: "2026-08-23T08:00:00.000Z",
      fetchedAt: "2026-08-23T08:00:00.000Z",
      freshUntil: "2026-08-23T13:00:00.000Z",
    },
  ],
}

export const mockRoles: RoleDefinition[] = [
  {
    agentKind: "codex",
    briefing: "Work on the assigned task and report the result in the project channel.",
    effort: null,
    launcher: "codex",
    model: null,
    name: "worker",
    summary: "General task worker for the selected workspace.",
  },
  {
    agentKind: "claude",
    briefing: "Coordinate the workspace and report progress in the project channel.",
    effort: "medium",
    launcher: "claude-work",
    model: "sonnet",
    name: "reporter",
    summary: "Read-only operational observer. Runs continuously and posts synthesized progress updates.",
  },
  {
    agentKind: "claude",
    briefing: "Lead the workspace. Decompose the goal, delegate work, and report decisions.",
    effort: "high",
    launcher: "claude-personal",
    model: "opus",
    name: "lead",
    summary: "Orchestrates a workspace against the operator goal.",
  },
]

export const mockMessages: Message[] = [
  {
    id: 1,
    channel: "ops",
    sender: "planner",
    senderKind: "agent",
    senderAgentKind: "claude",
    body: "The release checklist is ready. Please confirm the migration window before the deploy starts.",
    attachments: [],
    createdAt: "2026-08-12T08:11:00.000Z",
  },
  {
    id: 2,
    channel: "ops",
    sender: "suleyman",
    senderKind: "human",
    senderAgentKind: null,
    body: "Migration is approved for 10:00 UTC. Keep the old route available until the smoke checks finish. Run `git status` before deployment.",
    attachments: [mockAttachments[0]],
    createdAt: "2026-08-12T09:24:00.000Z",
  },
  {
    id: 3,
    channel: "ops",
    sender: "runner",
    senderKind: "agent",
    senderAgentKind: "codex",
    body: "Smoke checks passed in staging. The production command is prepared and waiting for the final acknowledgement.",
    attachments: [],
    createdAt: "2026-08-15T14:37:00.000Z",
  },
  {
    id: 4,
    channel: "ops",
    sender: "suleyman",
    senderKind: "human",
    senderAgentKind: null,
    body: "Proceed. Record the exact message id in the hand-off after the deploy. This body is intentionally long so the mock view exercises wrapping, readable line length, and scroll behavior across a real multi-paragraph update.\n\nThe second paragraph keeps enough content to expose layout errors without depending on a live server.",
    attachments: [mockAttachments[1], mockAttachments[2]],
    createdAt: "2026-08-17T09:45:00.000Z",
  },
  {
    id: 5,
    channel: "research",
    sender: "scout",
    senderKind: "agent",
    senderAgentKind: "opencode",
    body: "The FTS query needs a channel filter when the same term appears in several conversations.",
    attachments: [],
    createdAt: "2026-08-15T11:05:00.000Z",
  },
  {
    id: 6,
    channel: "research",
    sender: "reviewer-2",
    senderKind: "agent",
    senderAgentKind: "pi",
    body: "The result snippet should link to context, not only to a single message.",
    attachments: [],
    createdAt: "2026-08-16T15:02:00.000Z",
  },
  {
    id: 7,
    channel: "research",
    sender: "suleyman",
    senderKind: "human",
    senderAgentKind: null,
    body: "Keep the search result and the context window separate in the UI.",
    attachments: [],
    createdAt: "2026-08-16T15:03:00.000Z",
  },
  {
    id: 8,
    channel: "handoff",
    sender: "planner",
    senderKind: "agent",
    senderAgentKind: "claude",
    body: "The next pane can resume from cursor 7.",
    attachments: [],
    createdAt: "2026-08-12T08:11:00.000Z",
  },
  {
    id: 9,
    channel: "handoff",
    sender: "builder-3",
    senderKind: "agent",
    senderAgentKind: "unknown",
    body: "The hand-off bundle is ready for the next pane.",
    attachments: [],
    createdAt: "2026-08-12T08:12:00.000Z",
  },
  {
    id: 10,
    channel: "ops",
    sender: "planner",
    senderKind: "agent",
    senderAgentKind: "claude",
    body: "The deploy is complete. I am checking the final hand-off details now.",
    attachments: [],
    createdAt: "2026-08-17T09:46:00.000Z",
  },
  {
    id: 11,
    channel: "ops",
    sender: "planner",
    senderKind: "agent",
    senderAgentKind: "claude",
    body: "The hand-off is ready for review.",
    attachments: [],
    createdAt: "2026-08-17T09:47:00.000Z",
  },
  {
    id: 12,
    channel: "dm-planner-runner",
    sender: "planner",
    senderKind: "agent",
    senderAgentKind: "claude",
    body: "Can you review the hand-off before the next deploy?",
    attachments: [],
    createdAt: "2026-08-17T09:49:00.000Z",
  },
  {
    id: 13,
    channel: "dm-planner-runner",
    sender: "runner",
    senderKind: "agent",
    senderAgentKind: "codex",
    body: "Yes. I will send the exact message id after the checks finish.",
    attachments: [],
    createdAt: "2026-08-17T09:50:00.000Z",
  },
]

export const mockMembers: Member[] = [
  {
    handle: "planner",
    kind: "agent",
    agentKind: "claude",
    routeState: "active",
    unread: 0,
    joinedAt: "2026-08-12T08:00:00.000Z",
  },
  {
    handle: "runner",
    kind: "agent",
    agentKind: "codex",
    routeState: "active",
    unread: 2,
    joinedAt: "2026-08-12T08:02:00.000Z",
  },
  {
    handle: "suleyman",
    kind: "human",
    agentKind: null,
    routeState: "active",
    unread: 0,
    joinedAt: "2026-08-12T08:04:00.000Z",
  },
  {
    handle: "old-runner",
    kind: "agent",
    agentKind: null,
    routeState: "stale",
    unread: 4,
    joinedAt: "2026-08-10T10:00:00.000Z",
  },
  {
    handle: "builder-3",
    kind: "agent",
    agentKind: "unknown",
    routeState: "active",
    unread: 0,
    joinedAt: "2026-08-12T08:06:00.000Z",
  },
]

export const mockReceipts = {
  ops: [
    { cursorMessageId: 3, handle: "planner", routeState: "active" },
    { cursorMessageId: 2, handle: "runner", routeState: "active" },
    { cursorMessageId: 11, handle: "suleyman", routeState: "active" },
    { cursorMessageId: 0, handle: "old-runner", routeState: "stale" },
  ],
  research: [
    { cursorMessageId: 7, handle: "planner", routeState: "active" },
    { cursorMessageId: 5, handle: "runner", routeState: "active" },
    { cursorMessageId: 7, handle: "suleyman", routeState: "active" },
  ],
  handoff: [
    { cursorMessageId: 9, handle: "planner", routeState: "active" },
    { cursorMessageId: 9, handle: "runner", routeState: "active" },
    { cursorMessageId: 9, handle: "suleyman", routeState: "active" },
  ],
  "dm-planner-runner": [
    { cursorMessageId: 12, handle: "planner", routeState: "active" },
    { cursorMessageId: 13, handle: "runner", routeState: "active" },
  ],
} satisfies Record<string, ChannelReceipt[]>

export const mockInbox: InboxEntry[] = [
  {
    channel: "ops",
    cursorId: 9,
    unread: 2,
    senders: ["runner"],
    routeState: "active",
    pushEnabled: true,
  },
  {
    channel: "research",
    unread: 0,
    senders: [],
    routeState: "active",
    pushEnabled: false,
  },
  {
    channel: "handoff",
    unread: 1,
    senders: ["planner"],
    routeState: "stale",
    pushEnabled: true,
  },
]

/**
 * A session the panel can render without a harness running.
 *
 * The turns include a tool call and its result so the collapsed-by-default
 * rendering is exercised, and end on an assistant utterance so the glance line
 * has something real to show.
 */
export function mockSessionTurns(handle: string): SessionTurn[] {
  return [
    { kind: "turn", role: "user", text: `You are ${handle}. Inspect src/server.ts and start on the viewer batch.`, tool: null, at: "2026-08-19T08:00:00.000Z", sidechain: false },
    { kind: "turn", role: "assistant", text: "Inspecting the server entry point first.", tool: null, at: "2026-08-19T08:00:04.000Z", sidechain: false },
    { kind: "tool", role: null, text: "{\"file_path\":\"src/server.ts\"}", tool: { name: "Read", outcome: "unknown" }, at: "2026-08-19T08:00:04.000Z", sidechain: false },
    { kind: "tool", role: null, text: "1  import { serve } from \"bun\";", tool: { name: "result", outcome: "ok" }, at: "2026-08-19T08:00:05.000Z", sidechain: false },
    { kind: "turn", role: "assistant", text: "The viewer batch is unclaimed. Taking it and starting on the panel.", tool: null, at: "2026-08-19T08:00:09.000Z", sidechain: false },
  ]
}

/** Keyed on harness so every state the endpoint can answer is reachable here. */
export function mockSessionSource(agentKind: string | null): SessionSource {
  const harness = agentKind
  if (harness === "claude" || harness === "codex") {
    return { state: "ready", harness, sessionPath: `/sessions/${harness}/9f2c.jsonl`, glance: null, reason: null }
  }
  if (harness === null) return { state: "absent", harness, sessionPath: null, glance: null, reason: null }
  return { state: "unsupported", harness, sessionPath: null, glance: null, reason: null }
}

/** The last thing the agent said. Tool output is never promoted into it. */
export function lastSpokenText(turns: readonly SessionTurn[]): string | null {
  return turns.findLast((turn) => turn.kind === "turn" && turn.role === "assistant")?.text ?? null
}

export const mockSearchResults: SearchResult[] = [
  {
    messageId: 5,
    channel: "research",
    sender: "scout",
    snippet: "...FTS query needs a channel filter...",
    createdAt: "2026-08-15T11:05:00.000Z",
    attachmentCount: 0,
  },
  {
    messageId: 6,
    channel: "research",
    sender: "reviewer-2",
    snippet: "...result snippet should link to context...",
    createdAt: "2026-08-16T15:02:00.000Z",
    attachmentCount: 0,
  },
]
