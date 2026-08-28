import * as v from "valibot"

const integer = v.pipe(v.number(), v.integer())
const nonNegativeAttachmentCount = v.pipe(v.number(), v.integer(), v.minValue(0))
const nullableString = v.nullable(v.string())

const attachmentSchema = v.object({
  id: integer,
  path: v.string(),
  displayName: v.string(),
  byteSize: v.nullable(integer),
  mediaType: nullableString,
  previewEligible: v.boolean(),
  previewKind: v.nullable(v.picklist(["image", "markdown"])),
})

export const messageSchema = v.object({
  id: integer,
  channel: v.string(),
  sender: v.string(),
  senderKind: v.picklist(["agent", "human"]),
  senderAgentKind: v.nullable(v.string()),
  body: v.string(),
  attachments: v.array(attachmentSchema),
  createdAt: v.string(),
})

export const channelSchema = v.object({
  id: integer,
  kind: v.picklist(["chat", "direct", "workspace"]),
  name: v.string(),
  topic: nullableString,
  memberCount: integer,
  messageCount: integer,
  lastMessageAt: nullableString,
})

const memberSchema = v.object({
  handle: v.string(),
  kind: v.picklist(["agent", "human"]),
  agentKind: v.nullable(v.string()),
  routeState: v.picklist(["active", "stale"]),
  unread: integer,
  joinedAt: v.string(),
})

const channelReceiptSchema = v.object({
  handle: v.string(),
  cursorMessageId: integer,
  routeState: v.picklist(["active", "stale"]),
})

export const receiptUpdateSchema = v.object({
  channel: v.string(),
  handle: v.string(),
  cursorMessageId: integer,
})

const participantSchema = v.object({
  handle: v.string(),
  kind: v.picklist(["agent", "human"]),
  agentKind: v.nullable(v.string()),
  routeState: v.picklist(["active", "stale"]),
})

const directConversationSchema = v.object({
  channel: v.string(),
  participants: v.array(v.string()),
  unread: integer,
  // Optional until every fixture ships it; the wire always carries it.
  lastMessageAt: v.optional(nullableString),
})

const inboxEntrySchema = v.object({
  channel: v.string(),
  cursorId: v.optional(integer),
  unread: integer,
  senders: v.array(v.string()),
  routeState: v.picklist(["active", "stale"]),
  pushEnabled: v.boolean(),
})

const searchResultSchema = v.object({
  messageId: integer,
  channel: v.string(),
  sender: v.string(),
  snippet: v.string(),
  createdAt: v.string(),
  attachmentCount: nonNegativeAttachmentCount,
})

export const agentProvisionSchema = v.object({
  handle: v.string(),
  token: v.string(),
})

export const humanRegistrationSchema = v.object({
  handle: v.string(),
})

export const channelListSchema = v.object({
  channels: v.array(channelSchema),
})

export const deleteChannelResultSchema = v.object({
  name: v.string(),
})

export const directListSchema = v.object({
  conversations: v.array(directConversationSchema),
})

export const directResultSchema = v.object({
  channel: v.string(),
  messageId: integer,
})

const herdrPaneSchema = v.object({
  paneId: v.string(),
  label: nullableString,
  // Optional until every fixture ships it; the wire always carries it.
  title: v.optional(nullableString),
  agentKind: nullableString,
  // Optional for older topology fixtures; native role attribution is present on the live wire.
  role: v.optional(nullableString),
  agentStatus: v.picklist(["idle", "working", "blocked", "done", "unknown"]),
  focused: v.boolean(),
  participant: nullableString,
  participantRouteState: v.nullable(v.picklist(["active", "stale"])),
})

const herdrTabSchema = v.object({
  id: v.string(),
  label: nullableString,
  panes: v.array(herdrPaneSchema),
})

export const herdrWorkspaceSchema = v.object({
  id: v.string(),
  label: nullableString,
  panes: v.array(herdrPaneSchema),
  tabs: v.array(herdrTabSchema),
})

export const workspaceListSchema = v.object({
  workspaces: v.array(herdrWorkspaceSchema),
})

export const directoryListSchema = v.object({
  currentPath: v.string(),
  parentPath: nullableString,
  directories: v.array(v.object({ name: v.string(), path: v.string() })),
  truncated: v.boolean(),
})

const agentDetailParticipantSchema = v.object({
  handle: v.string(),
  kind: v.literal("agent"),
  agentKind: nullableString,
  role: v.optional(nullableString),
  routeState: v.picklist(["active", "stale"]),
  lastSeenAt: nullableString,
})

const agentRecentMessagesSchema = v.object({
  channel: v.string(),
  messageIds: v.array(integer),
})

export const agentDetailSchema = v.object({
  participant: agentDetailParticipantSchema,
  routeState: v.picklist(["active", "stale"]),
  pane: v.nullable(herdrPaneSchema),
  recentMessageIds: v.array(agentRecentMessagesSchema),
  // The AGENT'S unread per membership. Optional until every fixture ships it.
  channels: v.optional(v.array(v.object({ channel: v.string(), unread: integer }))),
})

const sessionTurnSchema = v.object({
  kind: v.picklist(["turn", "tool"]),
  role: v.nullable(v.picklist(["user", "assistant"])),
  text: v.string(),
  tool: v.nullable(v.object({
    name: v.string(),
    outcome: v.picklist(["ok", "error", "unknown"]),
  })),
  at: nullableString,
  sidechain: v.boolean(),
})

const sessionCandidateSchema = v.object({
  sessionId: v.string(),
  path: v.string(),
  startedAt: nullableString,
  sizeBytes: integer,
  cwd: nullableString,
  firstUserText: nullableString,
})

export const agentSessionSchema = v.object({
  turns: v.array(sessionTurnSchema),
  nextBefore: v.nullable(integer),
  source: v.object({
    // Five distinct states. A decoder that accepted a missing one would let the
    // panel fall back to rendering emptiness for a read that never happened.
    state: v.picklist(["ready", "absent", "ambiguous", "unsupported", "error"]),
    harness: nullableString,
    sessionPath: nullableString,
    glance: nullableString,
    reason: nullableString,
  }),
  mapping: v.nullable(v.object({
    confidence: v.picklist(["exact", "inferred", "ambiguous"]),
    candidates: v.array(sessionCandidateSchema),
  })),
})

export const agentSessionSelectionSchema = v.object({
  state: v.literal("ready"),
  sessionId: v.string(),
})

export const createWorkspaceResultSchema = v.object({
  workspace: herdrWorkspaceSchema,
})

export const closeWorkspaceResultSchema = v.object({
  workspaceId: v.string(),
})

export const workspaceBroadcastResultSchema = v.object({
  channel: v.string(),
  messageId: integer,
  recipients: v.array(v.string()),
})

export const createTabResultSchema = v.object({
  tab: v.object({
    id: v.string(),
    workspaceId: v.string(),
    label: nullableString,
  }),
})

export const renameTabResultSchema = v.object({
  tabId: v.string(),
  label: nullableString,
})

export const focusTabResultSchema = v.object({ tabId: v.string() })
export const promptAgentResultSchema = v.object({ delivered: v.boolean() })
export const connectAgentResultSchema = v.object({ handle: v.string(), paneId: v.string() })
export const closeTabResultSchema = v.object({ tabId: v.string() })

export const harnessListSchema = v.object({
  harnesses: v.array(v.string()),
})

export const launcherSchema = v.object({
  name: v.string(),
  agentKind: v.string(),
  argv: v.array(v.string()),
  envKeys: v.array(v.string()),
  startTimeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(300_000)),
})

export const launcherListSchema = v.object({
  launchers: v.array(launcherSchema),
})

export const deleteLauncherResultSchema = v.object({
  name: v.string(),
})

export const rolePresetSchema = v.object({
  name: v.string(),
  summary: v.string(),
  native: v.optional(v.boolean()),
  agentKind: v.optional(v.nullable(v.string())),
  launcher: v.optional(v.nullable(v.string())),
  model: v.optional(v.nullable(v.string())),
  effort: v.optional(v.nullable(v.string())),
})

export const roleListSchema = v.object({
  roles: v.array(rolePresetSchema),
})

export const roleDefinitionSchema = v.object({
  name: v.string(),
  summary: v.string(),
  native: v.optional(v.boolean()),
  agentKind: v.optional(v.nullable(v.string())),
  launcher: v.optional(v.nullable(v.string())),
  model: v.optional(v.nullable(v.string())),
  effort: v.optional(v.nullable(v.string())),
  briefing: v.string(),
})

export const roleDetailSchema = v.union([
  roleDefinitionSchema,
  v.object({
    role: roleDefinitionSchema,
  }),
])

const modelEntrySchema = v.object({
  harness: v.string(),
  name: v.string(),
  label: v.optional(v.string()),
})

export const modelListSchema = v.object({
  models: v.array(modelEntrySchema),
})

export const modelSchema = modelEntrySchema

const deviceModelEffortSchema = v.object({
  name: v.string(),
  description: nullableString,
  default: v.boolean(),
})

const deviceModelEntrySchema = v.object({
  name: v.string(),
  resolvedModel: nullableString,
  label: v.string(),
  description: nullableString,
  default: v.boolean(),
  efforts: v.array(deviceModelEffortSchema),
})

const deviceCatalogueSchema = v.object({
  launcher: v.string(),
  harness: v.string(),
  status: v.picklist(["ready", "default-only", "stale", "unavailable", "unsupported"]),
  error: nullableString,
  revision: integer,
  models: v.array(deviceModelEntrySchema),
  executableAvailable: v.nullable(v.boolean()),
  checkedAt: nullableString,
  fetchedAt: nullableString,
  freshUntil: nullableString,
})

export const modelCatalogueSchema = v.object({
  catalogues: v.array(deviceCatalogueSchema),
})

export const deleteRoleResultSchema = v.object({
  name: v.string(),
})

export const spawnAgentResultSchema = v.object({
  paneId: v.string(),
  handle: v.string(),
})

export const stopAgentResultSchema = v.object({
  paneId: v.string(),
})

export const joinResultSchema = v.object({
  channel: v.string(),
  cursorId: integer,
})

export const addedMemberSchema = v.object({
  channel: v.string(),
  handle: v.string(),
  cursorId: integer,
})

export const removedMemberSchema = v.object({
  channel: v.string(),
  handle: v.string(),
})

export const uploadResultSchema = v.object({
  path: v.string(),
})

export const fetchResultSchema = v.object({
  messages: v.array(messageSchema),
  throughId: integer,
})

export const ackResultSchema = v.object({
  cursorId: integer,
})

export const messageListSchema = v.object({
  messages: v.array(messageSchema),
})

export const memberListSchema = v.object({
  members: v.array(memberSchema),
})

export const channelReceiptListSchema = v.array(channelReceiptSchema)

export const participantListSchema = v.object({
  participants: v.array(participantSchema),
})

export const inboxListSchema = v.object({
  entries: v.array(inboxEntrySchema),
})

export const searchListSchema = v.object({
  results: v.array(searchResultSchema),
  truncated: v.boolean(),
})

const attachmentListRowSchema = v.object({
  attachment: attachmentSchema,
  channel: v.string(),
  messageId: integer,
  sender: v.string(),
  createdAt: v.string(),
})

export const attachmentListSchema = v.object({
  rows: v.array(attachmentListRowSchema),
  truncated: v.boolean(),
})
