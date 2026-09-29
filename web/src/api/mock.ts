import { Result } from "better-result"

import { KEEP_AWAKE_DEFAULTS, draftFromLimits, parseLimitsDraft } from "../keep-awake"
import { PAIRING_CODE_LENGTH, displayPairingCode, parsePairingCode } from "../remote-access"
import { AUTO_IDENTIFY_HANDLE } from "./auto-identify"
import { ApiConflictError, ApiHttpError, ApiNotFoundError, type Operation } from "./errors"
import {
  lastSpokenText,
  mockAttachments,
  mockChannels,
  mockDirectChannels,
  mockDirectConversations,
  mockInbox,
  mockHarnesses,
  mockLaunchers,
  mockMembers,
  mockModelCatalogue,
  mockModels,
  mockMessages,
  mockRoles,
  mockReceipts,
  mockSearchResults,
  mockSessionSource,
  mockSessionTurns,
  mockWorkspaces,
} from "./fixtures"
import type {
  AckRequest,
  AckResult,
  AddedMember,
  AttachmentMeta,
  AgentDetail,
  AgentProvision,
  AgentSession,
  AgentSessionSelection,
  AgentSessionSelectionRequest,
  ApiResult,
  AttachmentList,
  AttachmentListKind,
  AttachmentListQuery,
  AttachmentListRow,
  Channel,
  ChannelReceipt,
  ChannelList,
  ConnectAgentRequest,
  ConnectAgentResult,
  ContextQuery,
  CreateAgentRequest,
  CreateChannelRequest,
  DeleteChannelRequest,
  DeleteChannelResult,
  CreateDirectRequest,
  CreateHumanRequest,
  DeviceCatalogue,
  DirectList,
  DirectResult,
  DirectoryList,
  FetchResult,
  HarnessList,
  HistoryQuery,
  HumanRegistration,
  InboxList,
  JoinResult,
  Member,
  KeepAwakeLimits,
  KeepAwakePolicy,
  KeepAwakePolicyList,
  KeepAwakeSetting,
  KeepAwakeSettingResult,
  PairedDevice,
  PairingCode,
  RedeemPairingRequest,
  CallerIdentity,
  ResumableAgentList,
  ResumeAgentRequest,
  ResumedAgent,
  ResumeState,
  RemoteAccessStatus,
  RemoteSession,
  RevokedRemoteSession,
  KeepAwakeTarget,
  SetAgentKeepAwakeRequest,
  SetChannelKeepAwakeRequest,
  MemberList,
  Message,
  MessageList,
  ModelCatalogueRefreshRequest,
  ModelCatalogueSnapshot,
  MsgrApi,
  ParticipantList,
  RemovedMember,
  SearchList,
  SearchQuery,
  SessionQuery,
  SendMessageRequest,
  UploadProgressHandler,
  UploadResult,
  CloseWorkspaceRequest,
  CloseWorkspaceResult,
  CreateWorkspaceRequest,
  CreateLauncherRequest,
  CloseTabRequest,
  CloseTabResult,
  CreateTabRequest,
  CreateTabResult,
  CreateModelRequest,
  CreateRoleRequest,
  FocusTabResult,
  HerdrWorkspaceView,
  Launcher,
  LauncherList,
  ModelEntry,
  ModelList,
  DeleteLauncherResult,
  RenameTabRequest,
  RenameTabResult,
  UpdateLauncherRequest,
  WorkspaceBroadcastRequest,
  WorkspaceBroadcastResult,
  WorkspaceList,
  RoleList,
  RolePreset,
  RoleDefinition,
  RoleDetail,
  DeleteRoleResult,
  SpawnAgentRequest,
  SpawnAgentResult,
  PromptAgentRequest,
  PromptAgentResult,
  StopAgentRequest,
  StopAgentResult,
  UpdateRoleRequest,
  UpdateRoleRuntimeRequest,
} from "./types"

const DEFAULT_START_TIMEOUT_MS = 35_000

function cloneAttachment(attachment: (typeof mockAttachments)[number]): (typeof mockAttachments)[number] {
  return { ...attachment }
}

function attachmentListKind(attachment: AttachmentMeta): AttachmentListKind {
  if (attachment.previewKind === "image") return "image"
  if (attachment.previewKind === "markdown") return "markdown"
  return "other"
}

function cloneMessage(message: Message): Message {
  return {
    ...message,
    attachments: message.attachments.map(cloneAttachment),
  }
}

function directChannelName(participants: readonly string[]): string {
  let hash = 2_166_136_261
  for (const participant of participants.join("\u0000")) {
    const codePoint = participant.codePointAt(0) ?? 0
    hash = Math.imul(hash ^ codePoint, 16_777_619)
  }
  return `dm-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function launcherValidationError(
  name: string,
  agentKind: string,
  argv: readonly string[],
  startTimeoutMs: number | undefined,
): string | undefined {
  if (name.length === 0 || agentKind.length === 0) return "name and agentKind are required"
  if (argv.length === 0 || argv.some((entry) => entry.length === 0)) return "argv must contain non-empty entries"
  if (argv.some(hasControlCharacter)) return "argv must not contain control characters"
  if (argv[0] !== agentKind) return "argv[0] must equal agentKind"
  if (startTimeoutMs !== undefined && (!Number.isInteger(startTimeoutMs) || startTimeoutMs <= 0 || startTimeoutMs > 300_000)) {
    return "startTimeoutMs must be an integer from 1 through 300000"
  }
  return undefined
}

function initialLauncherCatalogue(launcher: Launcher): DeviceCatalogue {
  const supported = mockHarnesses.includes(launcher.agentKind) && (launcher.agentKind !== "claude" || launcher.argv.length === 1)
  return {
    launcher: launcher.name,
    harness: launcher.agentKind,
    status: supported ? "unavailable" : "unsupported",
    error: supported ? "The launcher catalogue has not been refreshed." : "This launcher has no device catalogue adapter.",
    revision: 1,
    models: [],
    executableAvailable: null,
    checkedAt: null,
    fetchedAt: null,
    freshUntil: null,
  }
}

const MOCK_REMOTE_HOST = "mock-mac.tail0000.ts.net"
/** Pairing codes in the mock expire like the hub's: five minutes. */
const MOCK_PAIRING_TTL_MS = 5 * 60_000
const MOCK_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function mockPairingCode(): string {
  return Array.from({ length: PAIRING_CODE_LENGTH }, () =>
    MOCK_CODE_ALPHABET[Math.floor(Math.random() * MOCK_CODE_ALPHABET.length)]).join("")
}

function remoteRefusal(
  code: "NotFound" | "PairingRefused" | "ValidationFailed",
  error: string,
  status: 400 | 401 | 404,
  operation: Operation,
): ApiHttpError {
  return new ApiHttpError({ body: JSON.stringify({ code, error }), message: error, status, operation })
}

function keepAwakeRefusal(
  code: "NotFound" | "NotAMember" | "ValidationFailed",
  error: string,
  status: 400 | 404,
  operation: Operation = "setKeepAwake",
): ApiHttpError {
  return new ApiHttpError({ body: JSON.stringify({ code, error }), message: error, status, operation })
}

export class MockMsgrApi implements MsgrApi {
  public readonly prompts: Array<{ paneId: string; text: string }> = []
  private readonly channels: Channel[] = mockChannels.map((channel) => ({ ...channel }))
  private readonly directChannels: Channel[] = mockDirectChannels.map((channel) => ({ ...channel }))
  private readonly workspaceChannels: Channel[] = []
  private readonly launchers: Launcher[] = mockLaunchers.map((launcher) => ({ ...launcher, argv: [...launcher.argv] }))
  private readonly launcherEnvironment = new Map<string, Record<string, string>>(
    mockLaunchers.map((launcher) => [launcher.name, Object.fromEntries(launcher.envKeys.map((key) => [key, ""]))]),
  )
  private readonly models: ModelEntry[] = mockModels.map((model) => ({ ...model }))
  private readonly modelCatalogue: ModelCatalogueSnapshot = {
    catalogues: mockModelCatalogue.catalogues.map((catalogue) => ({
      ...catalogue,
      models: catalogue.models.map((model) => ({
        ...model,
        efforts: model.efforts.map((effort) => ({ ...effort })),
      })),
    })),
  }
  private readonly roles: RoleDefinition[] = mockRoles.map((role) => ({ ...role }))
  private readonly workspaces: HerdrWorkspaceView[] = mockWorkspaces.map((workspace) => ({
    ...workspace,
    panes: workspace.panes.map((pane) => ({ ...pane })),
    tabs: workspace.tabs.map((tab) => ({
      ...tab,
      panes: tab.panes.map((pane) => ({ ...pane })),
    })),
  }))
  private readonly directConversations = mockDirectConversations.map((conversation) => ({
    ...conversation,
    participants: [...conversation.participants],
  }))
  private readonly messages: Message[] = mockMessages.map(cloneMessage)
  private readonly members = mockMembers.map((member) => ({ ...member }))
  private readonly memberHandles = new Set(this.members.map((member) => member.handle))
  private readonly memberHandlesByChannel = new Map(
    [...this.channels, ...this.directChannels].map((channel) => [
      channel.name,
      new Set(
        this.directConversations.find((conversation) => conversation.channel === channel.name)?.participants ??
          this.members.slice(0, channel.memberCount).map((member) => member.handle),
      ),
    ]),
  )
  private readonly receiptCursorsByChannel = new Map(
    Object.entries(mockReceipts).map(([channel, receipts]) => [
      channel,
      new Map(receipts.map((receipt) => [receipt.handle, receipt.cursorMessageId])),
    ]),
  )
  private readonly uploadedAttachments = new Map<string, AttachmentMeta>()
  private readonly uploadedContents = new Map<number, string>()
  private readonly keepAwakePolicies = new Map<string, KeepAwakePolicy>([
    // A stopped channel policy whose coordinator asked the human a question, so
    // the demo shows the alarm that opens the question's direct message.
    ["channel:research", {
      id: 1,
      target: { kind: "channel", channelId: 2, channel: "research", coordinatorId: 1, coordinator: "planner" },
      limits: KEEP_AWAKE_DEFAULTS,
      state: {
        kind: "needs-human",
        cause: {
          kind: "agent-requested",
          handle: "planner",
          alert: {
            kind: "message",
            channelId: 101,
            channel: "dm-planner-runner",
            messageId: 12,
            excerpt: "Can you review the hand-off before the next deploy?",
          },
        },
        since: "2026-08-17T09:49:00.000Z",
      },
      humanMarkId: 0,
    }],
  ])
  private nextKeepAwakeId = 2
  private readonly pairingCodes = new Map<string, string>()
  private readonly remoteSessions: RemoteSession[] = []
  private nextRemoteSessionId = 1

  private findChannel(name: string): Result<Channel, ApiNotFoundError> {
    const channel = [...this.channels, ...this.directChannels, ...this.workspaceChannels].find((candidate) => candidate.name === name)
    return channel === undefined
      ? Result.err(
          new ApiNotFoundError({
            message: `Channel #${name} was not found`,
            resource: name,
          }),
        )
      : Result.ok(channel)
  }

  public async createAgent(request: CreateAgentRequest): ApiResult<AgentProvision> {
    const existing = this.members.find((member) => member.handle === request.handle)
    return existing === undefined
      ? Result.ok({ handle: request.handle, token: `mock-token-${request.handle}` })
      : Result.err(
          new ApiConflictError({
            message: `Handle ${request.handle} is already registered`,
            resource: request.handle,
          }),
        )
  }

  public async createHuman(request: CreateHumanRequest): ApiResult<HumanRegistration> {
    const existing = this.members.find((member) => member.handle === request.handle)
    return existing === undefined
      ? Result.ok({ handle: request.handle })
      : Result.err(
          new ApiConflictError({
            message: `Handle ${request.handle} is already registered`,
            resource: request.handle,
          }),
        )
  }

  public async createChannel(request: CreateChannelRequest): ApiResult<Channel> {
    const existing = this.channels.find((channel) => channel.name === request.name)
    if (existing !== undefined) {
      return Result.err(
        new ApiConflictError({
          message: `Channel #${request.name} already exists`,
          resource: request.name,
        }),
      )
    }
    const channel: Channel = {
      id: this.channels.length + 1,
      kind: "chat",
      name: request.name,
      topic: request.topic ?? null,
      memberCount: 0,
      messageCount: 0,
      lastMessageAt: null,
    }
    this.channels.push(channel)
    return Result.ok({ ...channel })
  }

  public async deleteChannel(name: string, request: DeleteChannelRequest): ApiResult<DeleteChannelResult> {
    const channelIndex = this.channels.findIndex((channel) => channel.name === name)
    const channel = channelIndex < 0 ? undefined : this.channels[channelIndex]
    if (channel === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Channel #${name} was not found`, resource: name }))
    }
    if (request.confirm !== name) {
      return Result.err(new ApiHttpError({
        body: JSON.stringify({ code: "ValidationFailed", error: "confirm does not match the channel name" }),
        message: "The channel name confirmation does not match",
        operation: "deleteChannel",
        status: 400,
      }))
    }
    this.channels.splice(channelIndex, 1)
    this.memberHandlesByChannel.delete(name)
    this.receiptCursorsByChannel.delete(name)
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      if (this.messages[index]?.channel === name) this.messages.splice(index, 1)
    }
    return Result.ok({ name })
  }

  public async createDirect(request: CreateDirectRequest): ApiResult<DirectResult> {
    const participants: string[] = []
    const seenParticipants = new Set<string>()
    for (const rawHandle of request.to) {
      const handle = rawHandle.trim()
      if (handle.length > 0 && !seenParticipants.has(handle)) {
        seenParticipants.add(handle)
        participants.push(handle)
      }
    }
    const unknownHandle = participants.find((handle) => !this.memberHandles.has(handle))
    if (unknownHandle !== undefined) {
      return Result.err(
        new ApiNotFoundError({
          message: `Participant ${unknownHandle} was not found`,
          resource: unknownHandle,
        }),
      )
    }
    if (participants.length === 0 || request.body.trim().length === 0) {
      return Result.err(
        new ApiHttpError({
          body: "to and body are required",
          message: "A direct message needs at least one recipient and a body",
          status: 400,
        }),
      )
    }

    const sortedParticipants = participants.toSorted((left, right) => left.localeCompare(right))
    const channelName = directChannelName(sortedParticipants)
    let channel = this.directChannels.find((candidate) => candidate.name === channelName)
    if (channel === undefined) {
      channel = {
        id: 100 + this.directChannels.length + 1,
        kind: "direct",
        name: channelName,
        topic: null,
        memberCount: sortedParticipants.length + 1,
        messageCount: 0,
        lastMessageAt: null,
      }
      this.directChannels.push(channel)
      this.memberHandlesByChannel.set(channelName, new Set(sortedParticipants))
      this.directConversations.push({ channel: channelName, participants: sortedParticipants, unread: 0 })
    }
    const attachments = (request.attachments ?? []).map((path) => this.findAttachment(path))
    const missingAttachment = attachments.find((attachment) => attachment === undefined)
    if (missingAttachment !== undefined) {
      return Result.err(
        new ApiNotFoundError({
          message: "The attachment is not present in the mock fixture",
          resource: "attachment",
        }),
      )
    }
    const message = this.appendMessage(channel, request, attachments)
    return Result.ok({ channel: channel.name, messageId: message.id })
  }

  public async listChannels(kind: "chat" | "workspace" = "chat"): ApiResult<ChannelList> {
    const channels = kind === "workspace" ? this.workspaceChannels : this.channels
    return Result.ok({ channels: channels.map((channel) => ({ ...channel })) })
  }

  public async listDirect(): ApiResult<DirectList> {
    return Result.ok({
      conversations: this.directConversations.map((conversation) => ({
        ...conversation,
        participants: [...conversation.participants],
      })),
    })
  }

  public async listWorkspaces(): ApiResult<WorkspaceList> {
    return Result.ok({
      workspaces: this.workspaces.map((workspace) => ({
        ...workspace,
        panes: workspace.panes.map((pane) => ({ ...pane })),
        tabs: workspace.tabs.map((tab) => ({
          ...tab,
          panes: tab.panes.map((pane) => ({ ...pane })),
        })),
      })),
    })
  }

  public async createTab(request: CreateTabRequest): ApiResult<CreateTabResult> {
    const workspace = this.workspaces.find((candidate) => candidate.id === request.workspaceId)
    if (workspace === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Workspace ${request.workspaceId} was not found`, resource: request.workspaceId }))
    }
    const tab: HerdrWorkspaceView["tabs"][number] = {
      id: `${workspace.id}:tab-${workspace.tabs.length + 1}`,
      label: request.label?.trim() || null,
      panes: [],
    }
    workspace.tabs.push(tab)
    return Result.ok({ tab: { id: tab.id, label: tab.label, workspaceId: workspace.id } })
  }

  public async renameTab(id: string, request: RenameTabRequest): ApiResult<RenameTabResult> {
    const match = this.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => ({ tab, workspace }))).find(({ tab }) => tab.id === id)
    if (match === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Tab ${id} was not found`, resource: id }))
    }
    match.tab.label = request.label.trim() || null
    return Result.ok({ label: match.tab.label, tabId: id })
  }

  public async focusTab(id: string): ApiResult<FocusTabResult> {
    const exists = this.workspaces.some((workspace) => workspace.tabs.some((tab) => tab.id === id))
    return exists
      ? Result.ok({ tabId: id })
      : Result.err(new ApiNotFoundError({ message: `Tab ${id} was not found`, resource: id }))
  }

  public async closeTab(id: string, request: CloseTabRequest): ApiResult<CloseTabResult> {
    for (const workspace of this.workspaces) {
      const index = workspace.tabs.findIndex((tab) => tab.id === id)
      const tab = workspace.tabs[index]
      if (tab === undefined) continue
      const expected = tab.label ?? tab.id
      if (request.confirm !== expected) {
        return Result.err(new ApiHttpError({ body: "confirm does not match tab label", message: "Tab confirmation does not match", status: 400, operation: "closeTab" }))
      }
      workspace.tabs.splice(index, 1)
      const paneIds = new Set(tab.panes.map((pane) => pane.paneId))
      workspace.panes = workspace.panes.filter((pane) => !paneIds.has(pane.paneId))
      return Result.ok({ tabId: id })
    }
    return Result.err(new ApiNotFoundError({ message: `Tab ${id} was not found`, resource: id }))
  }

  public async getAgentDetail(handle: string): ApiResult<AgentDetail> {
    const participant = this.members.find((member) => member.handle === handle && member.kind === "agent")
    if (participant === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Agent ${handle} was not found`, resource: handle }))
    }
    const pane = this.workspaces
      .flatMap((workspace) => workspace.panes)
      .find((candidate) => candidate.participant === handle) ?? null
    const messageIdsByChannel = new Map<string, number[]>()
    for (const message of this.messages) {
      if (message.sender !== handle) continue
      const messageIds = messageIdsByChannel.get(message.channel) ?? []
      messageIds.push(message.id)
      messageIdsByChannel.set(message.channel, messageIds)
    }
    const recentMessageIds = [...messageIdsByChannel]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([channel, messageIds]) => ({ channel, messageIds: messageIds.toSorted((left, right) => right - left).slice(0, 20) }))
    return Result.ok({
      participant: {
        handle: participant.handle,
        kind: "agent",
        agentKind: participant.agentKind,
        routeState: participant.routeState,
        lastSeenAt: null,
      },
      routeState: participant.routeState,
      pane,
      recentMessageIds,
      resume: this.resumeStateFor(handle, participant.routeState),
    })
  }

  public async getAgentSession(paneId: string, query: SessionQuery = {}): ApiResult<AgentSession> {
    const pane = this.workspaces.flatMap((workspace) => workspace.panes).find((candidate) => candidate.paneId === paneId)
    if (pane === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Pane ${paneId} was not found`, resource: paneId }))
    }
    // The mock answers every state the real endpoint can, keyed on the harness,
    // so the panel's states are all reachable without a running harness.
    const source = mockSessionSource(pane.agentKind)
    if (source.state !== "ready") return Result.ok({ turns: [], nextBefore: null, source, mapping: null })
    const turns = mockSessionTurns(pane.participant ?? "the agent")
    const limit = query.limit ?? turns.length
    return Result.ok({
      turns: turns.slice(-limit),
      nextBefore: null,
      source: { ...source, glance: lastSpokenText(turns) },
      mapping: { confidence: "exact", candidates: [] },
    })
  }

  public async selectAgentSession(paneId: string, request: AgentSessionSelectionRequest): ApiResult<AgentSessionSelection> {
    const pane = this.workspaces.flatMap((workspace) => workspace.panes).find((candidate) => candidate.paneId === paneId)
    if (pane === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Pane ${paneId} was not found`, resource: paneId }))
    }
    return Result.ok({ state: "ready", sessionId: request.sessionId })
  }

  public async createWorkspace(request: CreateWorkspaceRequest): ApiResult<HerdrWorkspaceView> {
    const workspace: HerdrWorkspaceView = {
      id: `workspace-${this.workspaces.length + 1}`,
      label: request.label?.trim() || null,
      panes: [],
      tabs: [{ id: `workspace-${this.workspaces.length + 1}:tab-1`, label: "Main", panes: [] }],
    }
    this.workspaces.push(workspace)
    return Result.ok({ ...workspace, panes: [] })
  }

  public async listDirectories(path?: string): ApiResult<DirectoryList> {
    const currentPath = path ?? "/workspace/projects"
    const parentPath = currentPath === "/"
      ? null
      : currentPath.replace(/\/[^/]+$/u, "") || "/"
    const directories = currentPath === "/workspace/projects"
      ? ["sheppard", "herdr-contribute"].map((name) => ({ name, path: `${currentPath}/${name}` }))
      : currentPath.endsWith("/sheppard")
        ? ["src", "tests", "web"].map((name) => ({ name, path: `${currentPath}/${name}` }))
        : []
    return Result.ok({ currentPath, parentPath, directories, truncated: false })
  }

  public async closeWorkspace(id: string, request: CloseWorkspaceRequest): ApiResult<CloseWorkspaceResult> {
    const index = this.workspaces.findIndex((workspace) => workspace.id === id)
    const workspace = this.workspaces[index]
    if (workspace === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Workspace ${id} was not found`, resource: id }))
    }
    const expected = workspace.label ?? workspace.id
    if (request.confirm !== expected) {
      return Result.err(new ApiHttpError({ body: "confirm does not match workspace label", message: "Workspace confirmation does not match", status: 400 }))
    }
    this.workspaces.splice(index, 1)
    return Result.ok({ workspaceId: id })
  }

  public async broadcastWorkspace(id: string, request: WorkspaceBroadcastRequest): ApiResult<WorkspaceBroadcastResult> {
    const workspace = this.workspaces.find((candidate) => candidate.id === id)
    if (workspace === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Workspace ${id} was not found`, resource: id }))
    }
    const label = workspace.label ?? workspace.id
    const sanitized = label.toLocaleLowerCase().replaceAll(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "")
    const channelName = `ws-${(sanitized.length === 0 ? "workspace" : sanitized).slice(0, 29)}`
    let channel = this.workspaceChannels.find((candidate) => candidate.name === channelName)
    if (channel === undefined) {
      channel = {
        id: 10_000 + this.workspaceChannels.length + 1,
        kind: "workspace",
        name: channelName,
        topic: `Broadcasts for ${label}`,
        memberCount: 0,
        messageCount: 0,
        lastMessageAt: null,
      }
      this.workspaceChannels.push(channel)
      this.memberHandlesByChannel.set(channelName, new Set())
    }
    const recipients = workspace.panes.flatMap((pane) => pane.participant === null ? [] : [pane.participant])
    const message = this.appendMessage(channel, { body: request.body }, [])
    return Result.ok({ channel: channelName, messageId: message.id, recipients: [...new Set(recipients)] })
  }

  public async listHarnesses(): ApiResult<HarnessList> {
    return Result.ok({ harnesses: [...mockHarnesses] })
  }

  public async listLaunchers(): ApiResult<LauncherList> {
    return Result.ok({
      launchers: this.launchers
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((launcher) => this.launcherView(launcher)),
    })
  }

  private launcherView(launcher: Launcher): Launcher {
    return {
      ...launcher,
      argv: [...launcher.argv],
      envKeys: Object.keys(this.launcherEnvironment.get(launcher.name) ?? {}).toSorted(),
    }
  }

  public async createLauncher(request: CreateLauncherRequest): ApiResult<Launcher> {
    if (this.launchers.some((launcher) => launcher.name === request.name)) {
      return Result.err(new ApiConflictError({ message: `Launcher ${request.name} already exists`, resource: request.name }))
    }
    const invalid = launcherValidationError(request.name, request.agentKind, request.argv, request.startTimeoutMs)
    if (invalid !== undefined) {
      return Result.err(new ApiHttpError({ body: JSON.stringify({ code: "ValidationFailed", error: invalid }), message: invalid, operation: "createLauncher", status: 400 }))
    }
    const launcher = {
      agentKind: request.agentKind,
      argv: [...request.argv],
      envKeys: Object.keys(request.env ?? {}).toSorted(),
      name: request.name,
      startTimeoutMs: request.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS,
    }
    this.launcherEnvironment.set(request.name, { ...request.env })
    this.launchers.push(launcher)
    this.modelCatalogue.catalogues.push(initialLauncherCatalogue(launcher))
    return Result.ok(this.launcherView(launcher))
  }

  public async updateLauncher(name: string, request: UpdateLauncherRequest): ApiResult<Launcher> {
    const launcher = this.launchers.find((candidate) => candidate.name === name)
    if (launcher === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Launcher ${name} was not found`, resource: name }))
    }
    const invalid = launcherValidationError(name, request.agentKind, request.argv, request.startTimeoutMs)
    if (invalid !== undefined) {
      return Result.err(new ApiHttpError({ body: JSON.stringify({ code: "ValidationFailed", error: invalid }), message: invalid, operation: "updateLauncher", status: 400 }))
    }
    launcher.agentKind = request.agentKind
    launcher.argv = [...request.argv]
    launcher.startTimeoutMs = request.startTimeoutMs ?? launcher.startTimeoutMs
    const environment = this.launcherEnvironment.get(name) ?? {}
    for (const key of request.envPatch?.remove ?? []) delete environment[key]
    Object.assign(environment, request.envPatch?.set ?? {})
    this.launcherEnvironment.set(name, environment)
    const catalogue = this.modelCatalogue.catalogues.find((candidate) => candidate.launcher === name)
    if (catalogue === undefined) {
      this.modelCatalogue.catalogues.push(initialLauncherCatalogue(launcher))
    } else {
      const revision = catalogue.revision + 1
      Object.assign(catalogue, initialLauncherCatalogue(launcher), { revision })
    }
    return Result.ok(this.launcherView(launcher))
  }

  public async deleteLauncher(name: string): ApiResult<DeleteLauncherResult> {
    const index = this.launchers.findIndex((launcher) => launcher.name === name)
    if (index < 0) {
      return Result.err(new ApiNotFoundError({ message: `Launcher ${name} was not found`, resource: name }))
    }
    this.launchers.splice(index, 1)
    this.launcherEnvironment.delete(name)
    this.modelCatalogue.catalogues = this.modelCatalogue.catalogues.filter((catalogue) => catalogue.launcher !== name)
    return Result.ok({ name })
  }

  public async listRoles(): ApiResult<RoleList> {
    return Result.ok({ roles: this.roles.map(({ briefing: _briefing, ...role }) => ({ ...role })) })
  }

  public async getRole(name: string): ApiResult<RoleDetail> {
    const role = this.roles.find((candidate) => candidate.name === name)
    return role === undefined
      ? Result.err(new ApiNotFoundError({ message: `Role ${name} was not found`, resource: name }))
      : Result.ok({ role: { ...role } })
  }

  public async createRole(request: CreateRoleRequest): ApiResult<RoleDefinition> {
    if (this.roles.some((role) => role.name === request.name)) {
      return Result.err(new ApiConflictError({ message: `Role ${request.name} already exists`, resource: request.name }))
    }
    const role: RoleDefinition = { ...request }
    this.roles.push(role)
    return Result.ok({ ...role })
  }

  public async updateRole(name: string, request: UpdateRoleRequest): ApiResult<RoleDefinition> {
    const role = this.roles.find((candidate) => candidate.name === name)
    if (role === undefined) return Result.err(new ApiNotFoundError({ message: `Role ${name} was not found`, resource: name }))
    Object.assign(role, request)
    return Result.ok({ ...role })
  }

  public async updateRoleRuntime(name: string, request: UpdateRoleRuntimeRequest): ApiResult<RolePreset> {
    const role = this.roles.find((candidate) => candidate.name === name)
    if (role === undefined) return Result.err(new ApiNotFoundError({ message: `Role ${name} was not found`, resource: name }))
    Object.assign(role, request)
    const { briefing: _briefing, ...preset } = role
    return Result.ok(preset)
  }

  public async deleteRole(name: string): ApiResult<DeleteRoleResult> {
    const index = this.roles.findIndex((role) => role.name === name)
    if (index < 0) return Result.err(new ApiNotFoundError({ message: `Role ${name} was not found`, resource: name }))
    this.roles.splice(index, 1)
    return Result.ok({ name })
  }

  public async listModels(): ApiResult<ModelList> {
    return Result.ok({ models: this.models.map((model) => ({ ...model })) })
  }

  public async listModelCatalogue(): ApiResult<ModelCatalogueSnapshot> {
    return Result.ok({
      catalogues: this.modelCatalogue.catalogues.map((catalogue) => ({
        ...catalogue,
        models: catalogue.models.map((model) => ({
          ...model,
        efforts: model.efforts.map((effort) => ({ ...effort })),
        })),
      })),
    })
  }

  public async refreshModelCatalogue(request: ModelCatalogueRefreshRequest): ApiResult<ModelCatalogueSnapshot> {
    const catalogue = this.modelCatalogue.catalogues.find((candidate) => candidate.launcher === request.launcher)
    if (catalogue === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Launcher ${request.launcher} was not found`, resource: request.launcher }))
    }
    catalogue.checkedAt = new Date().toISOString()
    catalogue.fetchedAt = catalogue.checkedAt
    catalogue.status = catalogue.status === "unavailable" ? "ready" : catalogue.status
    return this.listModelCatalogue()
  }

  public async createModel(request: CreateModelRequest): ApiResult<ModelEntry> {
    if (this.models.some((model) => model.harness === request.harness && model.name === request.name)) {
      return Result.err(new ApiConflictError({ message: `Model ${request.name} already exists for ${request.harness}`, resource: request.name }))
    }
    const model: ModelEntry = { harness: request.harness, label: request.label, name: request.name }
    this.models.push(model)
    return Result.ok({ ...model })
  }

  public async spawnAgent(request: SpawnAgentRequest): ApiResult<SpawnAgentResult> {
    const workspace = this.workspaces.find((candidate) => candidate.id === request.workspaceId)
    if (workspace === undefined) {
      return Result.err(new ApiNotFoundError({ message: `Workspace ${request.workspaceId} was not found`, resource: request.workspaceId }))
    }
    const launcher = this.launchers.find((candidate) => candidate.name === request.launcher)
    if (launcher === undefined) {
      return Result.err(new ApiHttpError({ body: JSON.stringify({ code: "ValidationFailed", error: "launcher is not available" }), message: "Launcher is not available", operation: "spawnAgent", status: 400, value: request.launcher }))
    }
    const agentKind = launcher.agentKind
    const requested = request.handle.trim()
    let handle = requested
    let suffix = 2
    while (this.memberHandles.has(handle)) {
      handle = `${requested}-${suffix}`
      suffix += 1
    }
    const paneId = `${request.workspaceId}:pane-${workspace.panes.length + 1}`
    workspace.panes.push({
      paneId,
      label: handle,
      agentKind,
      agentStatus: "working",
      focused: false,
      participant: handle,
      participantRouteState: "active",
      previousIdentity: { kind: "none" },
    })
    const firstTab = workspace.tabs[0]
    if (firstTab !== undefined) {
      firstTab.panes.push({ ...workspace.panes[workspace.panes.length - 1] })
    }
    this.memberHandles.add(handle)
    this.members.push({
      handle,
      kind: "agent",
      agentKind,
      routeState: "active",
      unread: 0,
      joinedAt: "2026-08-17T10:00:00.000Z",
    })
    return Result.ok({ paneId, handle })
  }

  public async promptAgent(paneId: string, request: PromptAgentRequest): ApiResult<PromptAgentResult> {
    const hosting = this.workspaces.some((workspace) => workspace.panes.some((pane) => pane.paneId === paneId))
    if (!hosting) {
      return Result.err(new ApiHttpError({ body: JSON.stringify({ code: "NotFound", error: "No pane named " + paneId }), message: "Pane not found", status: 404, operation: "promptAgent" }))
    }
    this.prompts.push({ paneId, text: request.text })
    return Result.ok({ delivered: true })
  }

  public async listKeepAwake(): ApiResult<KeepAwakePolicyList> {
    return Result.ok({ policies: [...this.keepAwakePolicies.values()].sort((left, right) => left.id - right.id) })
  }

  public async getAgentKeepAwake(handle: string): ApiResult<KeepAwakeSettingResult> {
    const agent = this.keepAwakeAgent(handle, "getKeepAwake")
    if (agent.isErr()) return agent
    return Result.ok({ setting: this.keepAwakeSetting(`agent:${handle}`) })
  }

  public async setAgentKeepAwake(handle: string, request: SetAgentKeepAwakeRequest): ApiResult<KeepAwakeSettingResult> {
    const agent = this.keepAwakeAgent(handle, "setKeepAwake")
    if (agent.isErr()) return agent
    const limits = this.keepAwakeLimits(request)
    if (limits.isErr()) return limits
    const participantId = this.members.findIndex((member) => member.handle === handle) + 1
    return Result.ok({
      setting: this.storeKeepAwake(`agent:${handle}`, { kind: "agent", participantId, handle }, limits.value),
    })
  }

  public async clearAgentKeepAwake(handle: string): ApiResult<KeepAwakeSettingResult> {
    const agent = this.keepAwakeAgent(handle, "clearKeepAwake")
    if (agent.isErr()) return agent
    this.keepAwakePolicies.delete(`agent:${handle}`)
    return Result.ok({ setting: { kind: "off" } })
  }

  public async getChannelKeepAwake(name: string): ApiResult<KeepAwakeSettingResult> {
    const channel = this.findChannel(name)
    if (channel.isErr()) return channel
    return Result.ok({ setting: this.keepAwakeSetting(`channel:${name}`) })
  }

  public async setChannelKeepAwake(name: string, request: SetChannelKeepAwakeRequest): ApiResult<KeepAwakeSettingResult> {
    const channel = this.findChannel(name)
    if (channel.isErr()) return channel
    if (channel.value.kind === "direct") {
      return Result.err(keepAwakeRefusal("ValidationFailed", "name must name a channel, not a direct conversation", 400))
    }
    const coordinator = this.keepAwakeAgent(request.coordinator, "setKeepAwake")
    if (coordinator.isErr()) return coordinator
    if (!(this.memberHandlesByChannel.get(name)?.has(request.coordinator) ?? false)) {
      return Result.err(keepAwakeRefusal("NotAMember", `Not a member of "${name}"`, 400))
    }
    const limits = this.keepAwakeLimits(request)
    if (limits.isErr()) return limits
    const coordinatorId = this.members.findIndex((member) => member.handle === request.coordinator) + 1
    return Result.ok({
      setting: this.storeKeepAwake(
        `channel:${name}`,
        { kind: "channel", channelId: channel.value.id, channel: name, coordinatorId, coordinator: request.coordinator },
        limits.value,
      ),
    })
  }

  public async clearChannelKeepAwake(name: string): ApiResult<KeepAwakeSettingResult> {
    const channel = this.findChannel(name)
    if (channel.isErr()) return channel
    this.keepAwakePolicies.delete(`channel:${name}`)
    return Result.ok({ setting: { kind: "off" } })
  }

  /**
   * Resume states by handle. `old-runner` resumes with its matched launcher.
   * `archived-reviewer` has no pane of its own here and asks for a launcher.
   */
  private readonly resumeStates = new Map<string, ResumeState>([
    ["old-runner", { kind: "resumable", harness: "claude", sessionId: "5f0c7c2e", launcher: { kind: "matched", launcher: "claude-personal" } }],
    ["archived-reviewer", {
      kind: "resumable",
      harness: "claude",
      sessionId: "9a1d44b0",
      launcher: { kind: "choose", launchers: ["claude-personal", "claude-work"] },
    }],
  ])

  private resumeStateFor(handle: string, routeState: "active" | "stale"): ResumeState {
    if (routeState === "active") return { kind: "connected" }
    return this.resumeStates.get(handle) ?? { kind: "no-session" }
  }

  public async listResumableAgents(): ApiResult<ResumableAgentList> {
    return Result.ok({
      agents: [...this.resumeStates]
        .filter(([, resume]) => resume.kind === "resumable")
        .map(([handle, resume]) => ({ handle, resume })),
    })
  }

  public async resumeAgent(handle: string, request: ResumeAgentRequest): ApiResult<ResumedAgent> {
    const resume = this.resumeStates.get(handle)
    if (resume === undefined || resume.kind !== "resumable") {
      return Result.err(new ApiHttpError({
        body: JSON.stringify({ code: "ValidationFailed", error: `handle cannot resume: ${resume?.kind ?? "no-session"}` }),
        message: "Resume failed",
        status: 400,
        operation: "resumeAgent",
      }))
    }
    if (resume.launcher.kind === "choose" && (request.launcher === undefined || !resume.launcher.launchers.includes(request.launcher))) {
      return Result.err(new ApiHttpError({
        body: JSON.stringify({ code: "ValidationFailed", error: `launcher must be one of ${resume.launcher.launchers.join(", ")}` }),
        message: "Resume failed",
        status: 400,
        operation: "resumeAgent",
      }))
    }
    this.resumeStates.set(handle, { kind: "connected" })
    return Result.ok({ handle, paneId: `mock:resumed-${handle}`, sessionId: resume.sessionId })
  }

  public async getMe(): ApiResult<CallerIdentity> {
    return Result.ok({ handle: AUTO_IDENTIFY_HANDLE, kind: "human" })
  }

  public async getRemoteAccess(): ApiResult<RemoteAccessStatus> {
    return Result.ok({
      access: {
        kind: "on",
        host: MOCK_REMOTE_HOST,
        origin: `https://${MOCK_REMOTE_HOST}`,
        ownerLogin: "owner@example.com",
        enabledAt: "2026-01-01T00:00:00.000Z",
      },
      sessions: [...this.remoteSessions],
    })
  }

  public async createPairingCode(): ApiResult<PairingCode> {
    const code = mockPairingCode()
    const expiresAt = new Date(Date.now() + MOCK_PAIRING_TTL_MS).toISOString()
    this.pairingCodes.set(code, expiresAt)
    return Result.ok({ code: displayPairingCode(code), expiresAt, url: `https://${MOCK_REMOTE_HOST}/pair#code=${code}` })
  }

  public async redeemPairingCode(request: RedeemPairingRequest): ApiResult<PairedDevice> {
    const parsed = parsePairingCode(request.code)
    if (parsed.kind === "invalid") {
      return Result.err(remoteRefusal("ValidationFailed", parsed.message, 400, "redeemPairingCode"))
    }
    const expiresAt = this.pairingCodes.get(parsed.code)
    this.pairingCodes.delete(parsed.code)
    if (expiresAt === undefined || Date.parse(expiresAt) <= Date.now()) {
      return Result.err(remoteRefusal("PairingRefused", "The pairing code is not valid or has expired", 401, "redeemPairingCode"))
    }
    this.remoteSessions.push({
      id: this.nextRemoteSessionId++,
      handle: "human",
      createdAt: new Date().toISOString(),
      lastSeen: { kind: "not-seen" },
    })
    return Result.ok({ handle: "human" })
  }

  public async revokeRemoteSession(id: number): ApiResult<RevokedRemoteSession> {
    const index = this.remoteSessions.findIndex((session) => session.id === id)
    if (index < 0) return Result.err(remoteRefusal("NotFound", "Remote session not found", 404, "revokeRemoteSession"))
    this.remoteSessions.splice(index, 1)
    return Result.ok({ revoked: id })
  }

  private keepAwakeSetting(key: string): KeepAwakeSetting {
    const policy = this.keepAwakePolicies.get(key)
    return policy === undefined ? { kind: "off" } : { kind: "on", policy }
  }

  private keepAwakeAgent(handle: string, operation: Operation): Result<Member, ApiHttpError> {
    const agent = this.members.find((member) => member.handle === handle && member.kind === "agent")
    return agent === undefined
      ? Result.err(keepAwakeRefusal("NotFound", `Agent "${handle}" not found`, 404, operation))
      : Result.ok(agent)
  }

  private keepAwakeLimits(request: KeepAwakeLimits): Result<KeepAwakeLimits, ApiHttpError> {
    const parsed = parseLimitsDraft(draftFromLimits(request))
    switch (parsed.kind) {
      case "valid":
        return Result.ok(parsed.limits)
      case "invalid":
        return Result.err(keepAwakeRefusal("ValidationFailed", parsed.message, 400))
    }
  }

  /** A replace starts a fresh watch, as on the hub. */
  private storeKeepAwake(key: string, target: KeepAwakeTarget, limits: KeepAwakeLimits): KeepAwakeSetting {
    const previous = this.keepAwakePolicies.get(key)
    const policy: KeepAwakePolicy = {
      id: previous?.id ?? this.nextKeepAwakeId++,
      target,
      limits,
      state: { kind: "watching", wakesUsed: 0, lastWake: { kind: "not-woken" }, since: new Date().toISOString() },
      humanMarkId: 0,
    }
    this.keepAwakePolicies.set(key, policy)
    return { kind: "on", policy }
  }

  public async connectAgent(paneId: string, request: ConnectAgentRequest): ApiResult<ConnectAgentResult> {
    const workspace = this.workspaces.find((candidate) => candidate.panes.some((pane) => pane.paneId === paneId))
    const pane = workspace?.panes.find((candidate) => candidate.paneId === paneId)
    if (workspace === undefined || pane === undefined) {
      return Result.err(new ApiHttpError({ body: JSON.stringify({ code: "NotFound", error: "No pane named " + paneId }), message: "Pane not found", status: 404, operation: "connectAgent" }))
    }
    if (pane.agentKind === null) {
      return Result.err(new ApiHttpError({ body: JSON.stringify({ code: "ValidationFailed", error: "Pane has no agent occupant" }), message: "Pane has no agent occupant", status: 400, operation: "connectAgent" }))
    }
    if (pane.participant !== null) return Result.ok({ handle: pane.participant, paneId })
    const requested = request.handle.trim()
    let handle = requested
    let suffix = 2
    while (this.memberHandles.has(handle)) {
      handle = `${requested}-${suffix}`
      suffix += 1
    }
    pane.participant = handle
    pane.participantRouteState = "active"
    for (const tab of workspace.tabs) {
      const tabPane = tab.panes.find((candidate) => candidate.paneId === paneId)
      if (tabPane !== undefined) {
        tabPane.participant = handle
        tabPane.participantRouteState = "active"
      }
    }
    this.memberHandles.add(handle)
    this.members.push({
      agentKind: pane.agentKind,
      handle,
      joinedAt: new Date().toISOString(),
      kind: "agent",
      routeState: "active",
      unread: 0,
    })
    return Result.ok({ handle, paneId })
  }

  public async stopAgent(paneId: string, request: StopAgentRequest): ApiResult<StopAgentResult> {
    for (const workspace of this.workspaces) {
      const index = workspace.panes.findIndex((pane) => pane.paneId === paneId)
      const pane = workspace.panes[index]
      if (pane === undefined) continue
      const expected = pane.agentKind === null
        ? pane.label
        : pane.participantRouteState === "active"
        ? pane.participant
        : pane.label
      if (expected === null || expected === undefined || expected.length === 0) {
        return Result.err(new ApiHttpError({ body: JSON.stringify({ code: "ValidationFailed", error: "cannot close an unnamed pane" }), message: "The pane has no usable identity", status: 400 }))
      }
      if (request.confirm !== expected) {
        return Result.err(new ApiHttpError({ body: JSON.stringify({ code: "ValidationFailed", error: "confirm does not match the current pane identity" }), message: "Pane confirmation does not match", status: 400, operation: "stopAgent" }))
      }
      workspace.panes.splice(index, 1)
      for (const tab of workspace.tabs) tab.panes = tab.panes.filter((candidate) => candidate.paneId !== paneId)
      const member = this.members.find((candidate) => candidate.handle === pane.participant)
      if (member !== undefined) member.routeState = "stale"
      return Result.ok({ paneId })
    }
    return Result.err(new ApiNotFoundError({ message: `Pane ${paneId} was not found`, resource: paneId }))
  }

  public async joinChannel(name: string): ApiResult<JoinResult> {
    return this.findChannel(name).map((channel) => ({
      channel: channel.name,
      cursorId: this.latestMessageId(channel.name),
    }))
  }

  public async addMember(name: string, handle: string): ApiResult<AddedMember> {
    return this.findChannel(name).andThen((channel) => {
      const member = this.members.find((candidate) => candidate.handle === handle)
      if (member === undefined) {
        return Result.err(
          new ApiNotFoundError({
            message: `Participant ${handle} was not found`,
            resource: handle,
          }),
        )
      }
      const handles = this.memberHandlesByChannel.get(name)
      if (handles === undefined || handles.has(handle)) {
        return Result.err(
          new ApiConflictError({
            message: `${handle} is already a member of #${name}`,
            resource: handle,
          }),
        )
      }
      handles.add(handle)
      channel.memberCount += 1
      return Result.ok({ channel: name, cursorId: this.latestMessageId(name), handle })
    })
  }

  public async removeMember(name: string, handle: string): ApiResult<RemovedMember> {
    return this.findChannel(name).map((channel) => {
      const handles = this.memberHandlesByChannel.get(name)
      if (handles?.delete(handle) === true) channel.memberCount = Math.max(channel.memberCount - 1, 0)
      return { channel: name, handle }
    })
  }

  public async sendMessage(name: string, request: SendMessageRequest): ApiResult<Message> {
    return this.findChannel(name).andThen((channel) => {
      const attachments = (request.attachments ?? []).map((path) =>
        this.findAttachment(path),
      )
      const missingAttachment = attachments.find((attachment) => attachment === undefined)
      return missingAttachment === undefined
        ? Result.ok(this.appendMessage(channel, request, attachments))
        : Result.err(
            new ApiNotFoundError({
              message: "The attachment is not present in the mock fixture",
              resource: "attachment",
            }),
          )
    })
  }

  public async fetchMessages(name: string): ApiResult<FetchResult> {
    return this.findChannel(name).map((channel) => ({
      messages: this.messagesFor(channel.name),
      throughId: this.latestMessageId(channel.name),
    }))
  }

  public async acknowledge(name: string, _request: AckRequest): ApiResult<AckResult> {
    return this.findChannel(name).map((channel) => ({
      cursorId: this.latestMessageId(channel.name),
    }))
  }

  public async listMessages(name: string, query: HistoryQuery = {}): ApiResult<MessageList> {
    return this.findChannel(name).map((channel) => {
      const messages = this.messagesFor(channel.name).filter(
        (message) => query.before === undefined || message.id < query.before,
      )
      const limited = query.limit === undefined ? messages : messages.slice(-query.limit)
      return { messages: limited }
    })
  }

  public async context(name: string, query: ContextQuery): ApiResult<MessageList> {
    return this.findChannel(name).map((channel) => {
      const messages = this.messagesFor(channel.name)
      const center = messages.findIndex((message) => message.id === query.around)
      const span = query.span ?? 20
      const start = center < 0 ? 0 : Math.max(center - Math.floor(span / 2), 0)
      return { messages: messages.slice(start, start + span) }
    })
  }

  public async listMembers(name: string): ApiResult<MemberList> {
    return this.findChannel(name).map(() => {
      const handles = this.memberHandlesByChannel.get(name) ?? new Set<string>()
      const members: Member[] = []
      for (const member of this.members) {
        if (handles.has(member.handle)) members.push({ ...member })
      }
      return { members }
    })
  }

  public async listReceipts(name: string): ApiResult<ChannelReceipt[]> {
    return this.findChannel(name).map(() => {
      const handles = this.memberHandlesByChannel.get(name) ?? new Set<string>()
      const latest = this.latestMessageId(name)
      const cursors = this.receiptCursorsByChannel.get(name)
      return this.members.flatMap((member) => {
        if (!handles.has(member.handle)) return []
        const cursorMessageId = cursors?.get(member.handle) ?? latest
        return [{
          cursorMessageId,
          handle: member.handle,
          routeState: member.routeState,
        }]
      })
    })
  }

  public async listParticipants(): ApiResult<ParticipantList> {
    return Result.ok({
      participants: this.members.map(({ agentKind, handle, kind, routeState }) => ({
        agentKind,
        handle,
        kind,
        routeState,
      })),
    })
  }

  public async inbox(): ApiResult<InboxList> {
    return Result.ok({ entries: mockInbox.map((entry) => ({ ...entry, senders: [...entry.senders] })) })
  }

  public async search(query: SearchQuery): ApiResult<SearchList> {
    const channels = [...this.channels, ...this.directChannels, ...this.workspaceChannels]
    const results = mockSearchResults.filter(
      (result) =>
        result.snippet.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()) &&
        (query.channel === undefined || result.channel === query.channel) &&
        (query.kind === undefined || channels.some((channel) => channel.name === result.channel && channel.kind === query.kind)) &&
        (query.sender === undefined || result.sender === query.sender),
    )
    const limit = query.limit ?? 20
    const limited = results.slice(0, limit)
    return Result.ok({ results: limited.map((result) => ({ ...result })), truncated: results.length > limit })
  }

  public async listAttachments(query: AttachmentListQuery = {}): ApiResult<AttachmentList> {
    const rows: AttachmentListRow[] = []
    for (const message of this.messages) {
      if (query.channel !== undefined && message.channel !== query.channel) continue
      for (const attachment of message.attachments) {
        if (query.kind !== undefined && attachmentListKind(attachment) !== query.kind) continue
        rows.push({
          attachment: cloneAttachment(attachment),
          channel: message.channel,
          createdAt: message.createdAt,
          messageId: message.id,
          sender: message.sender,
        })
      }
    }
    const orderedRows = rows.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt) || right.messageId - left.messageId || right.attachment.id - left.attachment.id)
    const limit = query.limit ?? 20
    return Result.ok({ rows: orderedRows.slice(0, limit), truncated: orderedRows.length > limit })
  }

  public async attachmentContent(id: number): ApiResult<string> {
    const attachment = mockAttachments.find((candidate) => candidate.id === id)
    if (attachment === undefined) {
      return Result.err(
        new ApiNotFoundError({
          message: "The attachment was not found in the mock fixture",
          resource: String(id),
        }),
      )
    }
    const uploadedContent = this.uploadedContents.get(id)
    return uploadedContent !== undefined
      ? Result.ok(uploadedContent)
      : attachment.previewKind === "markdown"
      ? Result.ok(
          "# Release notes\n\nThe **staging** deploy is ready.\n\n- Verify the migration window\n- Run [smoke checks](https://example.com/smoke)\n\n> Keep the old route until the checks pass.\n",
        )
      : Result.err(
          new ApiNotFoundError({
            message: "The mock attachment has no text content",
            resource: String(id),
          }),
        )
  }

  public attachmentContentUrl(id: number): string {
    return `/api/attachments/${id}/content`
  }

  public async messageMarkdownContent(messageId: number, path: string): ApiResult<string> {
    const message = this.messages.find((candidate) => candidate.id === messageId)
    if (message === undefined || !message.body.includes(path) || !/\.(?:md|markdown)$/iu.test(path)) {
      return Result.err(
        new ApiNotFoundError({
          message: "The Markdown file was not found in the mock fixture",
          resource: path,
        }),
      )
    }
    const name = path.slice(path.lastIndexOf("/") + 1)
    return Result.ok(`# ${name}\n\nThis is a preview of a Markdown path referenced in the message.\n`)
  }

  public async uploadFile(
    file: Blob,
    filename: string,
    onProgress?: UploadProgressHandler,
  ): ApiResult<UploadResult> {
    onProgress?.({ loaded: 0, total: file.size })
    if (file.size === 0) {
      return Result.err(
        new ApiHttpError({
          body: "empty upload",
          message: "The uploaded file must not be empty",
          status: 400,
        }),
      )
    }
    const id = mockAttachments.reduce((largest, attachment) => Math.max(largest, attachment.id), 0) + this.uploadedAttachments.size + 1
    const safeName = filename.replaceAll(/[\\/\p{Cc}]/gu, "").slice(0, 255) || "upload"
    const path = `/mock/uploads/${id}-${safeName}`
    const mediaType = file.type.length > 0
      ? file.type
      : /\.md$/iu.test(safeName) ? "text/markdown" : null
    const previewKind = mediaType === "text/markdown"
      ? "markdown" as const
      : mediaType?.startsWith("image/") === true ? "image" as const : null
    const attachment: AttachmentMeta = {
      byteSize: file.size,
      displayName: safeName,
      id,
      mediaType,
      path,
      previewEligible: mediaType === "text/markdown" || mediaType?.startsWith("image/") === true,
      previewKind,
    }
    this.uploadedAttachments.set(path, attachment)
    if (previewKind === "markdown") this.uploadedContents.set(id, await file.text())
    onProgress?.({ loaded: file.size, total: file.size })
    return Result.ok({ path })
  }

  private latestMessageId(channel: string): number {
    let latest = 0
    for (const message of this.messages) {
      if (message.channel === channel) latest = Math.max(latest, message.id)
    }
    return latest
  }

  private messagesFor(channel: string): Message[] {
    const messages: Message[] = []
    for (const message of this.messages) {
      if (message.channel === channel) messages.push(cloneMessage(message))
    }
    return messages
  }

  private findAttachment(path: string): AttachmentMeta | undefined {
    return mockAttachments.find((candidate) => candidate.path === path) ?? this.uploadedAttachments.get(path)
  }

  private appendMessage(
    channel: Channel,
    request: SendMessageRequest,
    attachments: Array<(typeof mockAttachments)[number] | undefined>,
  ): Message {
    const createdAt = "2026-08-17T10:00:00.000Z"
    const message: Message = {
      id: this.messages.reduce((latest, current) => Math.max(latest, current.id), 0) + 1,
      channel: channel.name,
      sender: "mock-human",
      senderKind: "human",
      senderAgentKind: null,
      body: request.body,
      attachments: attachments.flatMap((attachment) =>
        attachment === undefined ? [] : [cloneAttachment(attachment)],
      ),
      createdAt,
    }
    this.messages.push(message)
    channel.messageCount += 1
    channel.lastMessageAt = createdAt
    return cloneMessage(message)
  }
}

export const mockApi = new MockMsgrApi()
