import type { Result } from "better-result"

import type { ApiError } from "./errors"

export type Kind = "agent" | "human"
export type RouteState = "active" | "stale"
export type AgentKind = string
export type ChannelKind = "chat" | "direct" | "workspace"
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown"

export interface Channel {
  id: number
  kind: ChannelKind
  name: string
  topic: string | null
  memberCount: number
  messageCount: number
  lastMessageAt: string | null
}

export interface AttachmentMeta {
  id: number
  path: string
  displayName: string
  byteSize: number | null
  mediaType: string | null
  previewEligible: boolean
  previewKind: "image" | "markdown" | null
}

export interface Message {
  id: number
  channel: string
  sender: string
  senderKind: Kind
  senderAgentKind: AgentKind | null
  body: string
  attachments: AttachmentMeta[]
  createdAt: string
}

export interface Member {
  handle: string
  kind: Kind
  agentKind: AgentKind | null
  routeState: RouteState
  unread: number
  joinedAt: string
}

export interface ChannelReceipt {
  handle: string
  cursorMessageId: number
  routeState: RouteState
}

export interface ReceiptUpdate {
  channel: string
  handle: string
  cursorMessageId: number
}

export interface Participant {
  handle: string
  kind: Kind
  agentKind: AgentKind | null
  routeState: RouteState
}

export interface AgentDetailParticipant {
  handle: string
  kind: "agent"
  agentKind: AgentKind | null
  role?: string | null
  routeState: RouteState
  lastSeenAt: string | null
}

export interface AgentRecentMessages {
  channel: string
  messageIds: number[]
}

export interface AgentChannelMembership {
  channel: string
  /** The AGENT'S unread backlog in that channel, never the viewer's. */
  unread: number
}

export interface AgentDetail {
  participant: AgentDetailParticipant
  routeState: RouteState
  pane: HerdrPaneView | null
  recentMessageIds: AgentRecentMessages[]
  channels?: AgentChannelMembership[]
}

/**
 * How much of an agent's harness session the hub can show. Each state is a
 * different answer, and the panel renders each one differently: `absent` says
 * no session was written, `unsupported` says the hub cannot read this harness,
 * `error` says the hub could not look. None of the three is an empty session.
 */
export type SessionState = "ready" | "absent" | "ambiguous" | "unsupported" | "error"

export interface SessionTurn {
  kind: "turn" | "tool"
  role: "user" | "assistant" | null
  text: string
  tool: { name: string; outcome: "ok" | "error" | "unknown" } | null
  at: string | null
  sidechain: boolean
}

export interface SessionCandidate {
  sessionId: string
  path: string
  startedAt: string | null
  sizeBytes: number
  cwd: string | null
  firstUserText: string | null
}

export interface SessionSource {
  state: SessionState
  harness: string | null
  sessionPath: string | null
  /** The last thing the agent said, or null. Never filled with tool output. */
  glance: string | null
  reason: string | null
}

export interface AgentSession {
  turns: SessionTurn[]
  /** Byte offset to page backward from, or null at the start of the session. */
  nextBefore: number | null
  source: SessionSource
  mapping: { confidence: "exact" | "inferred" | "ambiguous"; candidates: SessionCandidate[] } | null
}

export interface SessionQuery {
  limit?: number
  before?: number
}

export interface AgentSessionSelectionRequest {
  sessionId: string
}

export interface AgentSessionSelection {
  state: "ready"
  sessionId: string
}

export interface DirectConversation {
  channel: string
  participants: string[]
  unread: number
  lastMessageAt?: string | null
}

export interface InboxEntry {
  channel: string
  cursorId?: number
  unread: number
  senders: string[]
  routeState: RouteState
  pushEnabled: boolean
}

export interface SearchResult {
  messageId: number
  channel: string
  sender: string
  snippet: string
  createdAt: string
  attachmentCount: number
}

export interface AgentProvision {
  handle: string
  token: string
}

export interface HumanRegistration {
  handle: string
}

export interface JoinResult {
  channel: string
  cursorId: number
}

export interface CreateDirectRequest {
  to: string[]
  body: string
  attachments?: string[]
}

export interface DirectResult {
  channel: string
  messageId: number
}

export interface HerdrPaneView {
  paneId: string
  label: string | null
  /** The live terminal title, rendered as the agent's current task. */
  title?: string | null
  agentKind: string | null
  role?: string | null
  agentStatus: AgentStatus
  focused: boolean
  participant: string | null
  participantRouteState: RouteState | null
}

export interface HerdrTabView {
  id: string
  label: string | null
  panes: HerdrPaneView[]
}

export interface HerdrWorkspaceView {
  id: string
  label: string | null
  panes: HerdrPaneView[]
  tabs: HerdrTabView[]
}

export interface WorkspaceList {
  workspaces: HerdrWorkspaceView[]
}

export interface DirectoryEntry {
  name: string
  path: string
}

export interface DirectoryList {
  currentPath: string
  parentPath: string | null
  directories: DirectoryEntry[]
  truncated: boolean
}

export interface CreateWorkspaceRequest {
  label?: string
  cwd?: string
}

export interface CloseWorkspaceRequest {
  confirm: string
}

export interface CloseWorkspaceResult {
  workspaceId: string
}

export interface WorkspaceBroadcastRequest {
  body: string
}

export interface WorkspaceBroadcastResult {
  channel: string
  messageId: number
  recipients: string[]
}

export interface CreateTabRequest {
  workspaceId: string
  label?: string
}

export interface CreatedTab {
  id: string
  workspaceId: string
  label: string | null
}

export interface CreateTabResult {
  tab: CreatedTab
}

export interface RenameTabRequest {
  label: string
}

export interface RenameTabResult {
  tabId: string
  label: string | null
}

export interface FocusTabResult {
  tabId: string
}

export interface CloseTabRequest {
  confirm: string
}

export interface CloseTabResult {
  tabId: string
}

export interface HarnessList {
  harnesses: string[]
}

export interface Launcher {
  name: string
  agentKind: string
  argv: string[]
  envKeys: string[]
  startTimeoutMs: number
}

export interface LauncherList {
  launchers: Launcher[]
}

export interface CreateLauncherRequest {
  name: string
  agentKind: string
  argv: string[]
  env?: Record<string, string>
  startTimeoutMs?: number
}

export interface LauncherEnvironmentPatch {
  set: Record<string, string>
  remove: string[]
}

export interface UpdateLauncherRequest {
  agentKind: string
  argv: string[]
  envPatch?: LauncherEnvironmentPatch
  startTimeoutMs?: number
}

export interface DeleteLauncherResult {
  name: string
}

export interface RolePreset {
  name: string
  summary: string
  native?: boolean
  agentKind?: string | null
  launcher?: string | null
  model?: string | null
  effort?: string | null
}

export interface RoleList {
  roles: RolePreset[]
}

export interface RoleDefinition extends RolePreset {
  briefing: string
}

export interface RoleDetail {
  role: RoleDefinition
}

export interface ModelEntry {
  harness: string
  name: string
  label?: string
}

export interface ModelList {
  models: ModelEntry[]
}

export interface DeviceModelEffort {
  name: string
  description: string | null
  default: boolean
}

export interface DeviceModelEntry {
  name: string
  resolvedModel: string | null
  label: string
  description: string | null
  default: boolean
  efforts: DeviceModelEffort[]
}

export type DeviceCatalogueStatus = "ready" | "default-only" | "stale" | "unavailable" | "unsupported"

export interface DeviceCatalogue {
  launcher: string
  harness: string
  status: DeviceCatalogueStatus
  error: string | null
  revision: number
  models: DeviceModelEntry[]
  executableAvailable: boolean | null
  checkedAt: string | null
  fetchedAt: string | null
  freshUntil: string | null
}

export interface ModelCatalogueSnapshot {
  catalogues: DeviceCatalogue[]
}

export interface ModelCatalogueRefreshRequest {
  launcher: string
}

export interface CreateRoleRequest {
  name: string
  summary: string
  briefing: string
  agentKind: string | null
  launcher?: string | null
  model?: string | null
  effort?: string | null
}

export type UpdateRoleRequest = CreateRoleRequest

export interface UpdateRoleRuntimeRequest {
  agentKind: string | null
  launcher: string | null
  model: string | null
  effort: string | null
}

export interface DeleteRoleResult {
  name: string
}

export interface CreateModelRequest {
  harness: string
  name: string
  label?: string
  argvSuffix: string[]
}

export interface SpawnAgentRequest {
  workspaceId: string
  launcher: string
  handle: string
  role?: string
  model?: string
  effort?: string
  goal?: string
}

export interface SpawnAgentResult {
  paneId: string
  handle: string
}

export interface ConnectAgentRequest {
  handle: string
}

export interface ConnectAgentResult {
  paneId: string
  handle: string
}

export interface StopAgentRequest {
  confirm: string
}

export interface StopAgentResult {
  paneId: string
}

export interface AddedMember {
  channel: string
  handle: string
  cursorId: number
}

export interface RemovedMember {
  channel: string
  handle: string
}

export interface UploadResult {
  path: string
}

export interface UploadProgress {
  loaded: number
  total: number
}

export type UploadProgressHandler = (progress: UploadProgress) => void

export interface FetchResult {
  messages: Message[]
  throughId: number
}

export interface AckResult {
  cursorId: number
}

export interface ChannelList {
  channels: Channel[]
}

export interface DeleteChannelRequest {
  confirm: string
}

export interface DeleteChannelResult {
  name: string
}

export interface MessageList {
  messages: Message[]
}

export interface MemberList {
  members: Member[]
}

export interface ParticipantList {
  participants: Participant[]
}

export interface DirectList {
  conversations: DirectConversation[]
}

export interface InboxList {
  entries: InboxEntry[]
}

export interface SearchList {
  results: SearchResult[]
  truncated: boolean
}

export type AttachmentListKind = "image" | "markdown" | "other"

export interface AttachmentListQuery {
  channel?: string
  kind?: AttachmentListKind
  limit?: number
}

export interface AttachmentListRow {
  attachment: AttachmentMeta
  channel: string
  messageId: number
  sender: string
  createdAt: string
}

export interface AttachmentList {
  rows: AttachmentListRow[]
  truncated: boolean
}

export interface CreateAgentRequest {
  handle: string
}

export interface CreateHumanRequest {
  handle: string
}

export interface CreateChannelRequest {
  name: string
  topic?: string
}

export interface AddMemberRequest {
  handle: string
}

export interface JoinChannelRequest {
  readonly _empty?: never
}

export interface SendMessageRequest {
  body: string
  attachments?: string[]
}

export interface AckRequest {
  throughId: number
}

export type RequestBody =
  | CreateAgentRequest
  | CreateHumanRequest
  | CreateChannelRequest
  | DeleteChannelRequest
  | CreateDirectRequest
  | AddMemberRequest
  | JoinChannelRequest
  | SendMessageRequest
  | AckRequest
  | CreateWorkspaceRequest
  | CloseWorkspaceRequest
  | WorkspaceBroadcastRequest
  | CreateTabRequest
  | RenameTabRequest
  | CloseTabRequest
  | CreateLauncherRequest
  | UpdateLauncherRequest
  | CreateRoleRequest
  | UpdateRoleRequest
  | UpdateRoleRuntimeRequest
  | CreateModelRequest
  | ModelCatalogueRefreshRequest
  | SpawnAgentRequest
  | ConnectAgentRequest
  | StopAgentRequest
  | PromptAgentRequest
  | AgentSessionSelectionRequest

export interface HistoryQuery {
  limit?: number
  before?: number
}

export interface ContextQuery {
  around: number
  span?: number
}

export interface SearchQuery {
  q: string
  channel?: string
  kind?: ChannelKind
  sender?: string
  limit?: number
}

export type ApiResult<T> = Promise<Result<T, ApiError>>

export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

export interface ApiClientOptions {
  baseUrl?: string
  onUnauthorized?: () => void
  token?: string
  fetchImpl?: FetchImplementation
}

export interface PromptAgentRequest {
  text: string
}

export interface PromptAgentResult {
  delivered: boolean
}

export interface MsgrApi {
  createAgent(request: CreateAgentRequest): ApiResult<AgentProvision>
  createHuman(request: CreateHumanRequest): ApiResult<HumanRegistration>
  createChannel(request: CreateChannelRequest): ApiResult<Channel>
  deleteChannel(name: string, request: DeleteChannelRequest): ApiResult<DeleteChannelResult>
  createDirect(request: CreateDirectRequest): ApiResult<DirectResult>
  listWorkspaces(): ApiResult<WorkspaceList>
  listDirectories(path?: string): ApiResult<DirectoryList>
  createWorkspace(request: CreateWorkspaceRequest): ApiResult<HerdrWorkspaceView>
  closeWorkspace(id: string, request: CloseWorkspaceRequest): ApiResult<CloseWorkspaceResult>
  broadcastWorkspace(id: string, request: WorkspaceBroadcastRequest): ApiResult<WorkspaceBroadcastResult>
  createTab(request: CreateTabRequest): ApiResult<CreateTabResult>
  renameTab(id: string, request: RenameTabRequest): ApiResult<RenameTabResult>
  focusTab(id: string): ApiResult<FocusTabResult>
  closeTab(id: string, request: CloseTabRequest): ApiResult<CloseTabResult>
  listHarnesses(): ApiResult<HarnessList>
  listLaunchers(): ApiResult<LauncherList>
  createLauncher(request: CreateLauncherRequest): ApiResult<Launcher>
  updateLauncher(name: string, request: UpdateLauncherRequest): ApiResult<Launcher>
  deleteLauncher(name: string): ApiResult<DeleteLauncherResult>
  listRoles(): ApiResult<RoleList>
  getRole(name: string): ApiResult<RoleDetail>
  createRole(request: CreateRoleRequest): ApiResult<RoleDefinition>
  updateRole(name: string, request: UpdateRoleRequest): ApiResult<RoleDefinition>
  updateRoleRuntime(name: string, request: UpdateRoleRuntimeRequest): ApiResult<RolePreset>
  deleteRole(name: string): ApiResult<DeleteRoleResult>
  listModels(): ApiResult<ModelList>
  listModelCatalogue(): ApiResult<ModelCatalogueSnapshot>
  refreshModelCatalogue(request: ModelCatalogueRefreshRequest): ApiResult<ModelCatalogueSnapshot>
  createModel(request: CreateModelRequest): ApiResult<ModelEntry>
  spawnAgent(request: SpawnAgentRequest): ApiResult<SpawnAgentResult>
  connectAgent(paneId: string, request: ConnectAgentRequest): ApiResult<ConnectAgentResult>
  stopAgent(paneId: string, request: StopAgentRequest): ApiResult<StopAgentResult>
  promptAgent(paneId: string, request: PromptAgentRequest): ApiResult<PromptAgentResult>
  listChannels(kind?: "chat" | "workspace"): ApiResult<ChannelList>
  listDirect(): ApiResult<DirectList>
  joinChannel(name: string): ApiResult<JoinResult>
  addMember(name: string, handle: string): ApiResult<AddedMember>
  removeMember(name: string, handle: string): ApiResult<RemovedMember>
  sendMessage(name: string, request: SendMessageRequest): ApiResult<Message>
  fetchMessages(name: string): ApiResult<FetchResult>
  acknowledge(name: string, request: AckRequest): ApiResult<AckResult>
  listMessages(name: string, query?: HistoryQuery): ApiResult<MessageList>
  context(name: string, query: ContextQuery): ApiResult<MessageList>
  listMembers(name: string): ApiResult<MemberList>
  listReceipts(name: string): ApiResult<ChannelReceipt[]>
  listParticipants(): ApiResult<ParticipantList>
  getAgentDetail(handle: string): ApiResult<AgentDetail>
  getAgentSession(paneId: string, query?: SessionQuery): ApiResult<AgentSession>
  selectAgentSession(paneId: string, request: AgentSessionSelectionRequest): ApiResult<AgentSessionSelection>
  inbox(): ApiResult<InboxList>
  search(query: SearchQuery): ApiResult<SearchList>
  listAttachments(query?: AttachmentListQuery): ApiResult<AttachmentList>
  attachmentContent(id: number): ApiResult<string>
  attachmentContentUrl(id: number): string
  messageMarkdownContent(messageId: number, path: string): ApiResult<string>
  uploadFile(file: Blob, filename: string, onProgress?: UploadProgressHandler): ApiResult<UploadResult>
}
