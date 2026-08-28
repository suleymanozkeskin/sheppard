import { Result } from "better-result"
import * as v from "valibot"

import {
  ApiDecodeError,
  ApiHttpError,
  ApiNetworkError,
  type ApiError,
  type Operation,
} from "./errors"
import {
  ackResultSchema,
  addedMemberSchema,
  agentDetailSchema,
  agentProvisionSchema,
  agentSessionSchema,
  agentSessionSelectionSchema,
  channelReceiptListSchema,
  attachmentListSchema,
  channelListSchema,
  channelSchema,
  deleteChannelResultSchema,
  closeWorkspaceResultSchema,
  closeTabResultSchema,
  connectAgentResultSchema,
  createWorkspaceResultSchema,
  createTabResultSchema,
  directListSchema,
  directResultSchema,
  directoryListSchema,
  deleteLauncherResultSchema,
  deleteRoleResultSchema,
  fetchResultSchema,
  focusTabResultSchema,
  promptAgentResultSchema,
  harnessListSchema,
  launcherListSchema,
  launcherSchema,
  humanRegistrationSchema,
  inboxListSchema,
  joinResultSchema,
  memberListSchema,
  messageListSchema,
  messageSchema,
  modelCatalogueSchema,
  modelListSchema,
  modelSchema,
  participantListSchema,
  removedMemberSchema,
  roleDefinitionSchema,
  roleDetailSchema,
  roleListSchema,
  rolePresetSchema,
  renameTabResultSchema,
  searchListSchema,
  spawnAgentResultSchema,
  stopAgentResultSchema,
  uploadResultSchema,
  workspaceBroadcastResultSchema,
  workspaceListSchema,
} from "./schemas"
import type {
  AckRequest,
  AckResult,
  AddedMember,
  AgentDetail,
  AgentProvision,
  AgentSession,
  AgentSessionSelection,
  AgentSessionSelectionRequest,
  AttachmentList,
  AttachmentListQuery,
  ApiClientOptions,
  ApiResult,
  Channel,
  ChannelReceipt,
  ChannelList,
  ContextQuery,
  ConnectAgentRequest,
  ConnectAgentResult,
  CreateAgentRequest,
  CreateChannelRequest,
  CreateDirectRequest,
  CreateHumanRequest,
  CreateWorkspaceRequest,
  CloseWorkspaceRequest,
  CloseWorkspaceResult,
  CloseTabRequest,
  CloseTabResult,
  CreateLauncherRequest,
  CreateModelRequest,
  CreateRoleRequest,
  CreateTabRequest,
  CreateTabResult,
  DirectList,
  DirectResult,
  DirectoryList,
  DeleteLauncherResult,
  DeleteChannelRequest,
  DeleteChannelResult,
  DeleteRoleResult,
  FetchResult,
  FocusTabResult,
  HarnessList,
  Launcher,
  LauncherList,
  HistoryQuery,
  HumanRegistration,
  InboxList,
  JoinResult,
  MemberList,
  Message,
  MessageList,
  ModelCatalogueRefreshRequest,
  ModelCatalogueSnapshot,
  ModelEntry,
  ModelList,
  MsgrApi,
  ParticipantList,
  RemovedMember,
  RequestBody,
  SearchList,
  SearchQuery,
  SendMessageRequest,
  SessionQuery,
  SpawnAgentRequest,
  SpawnAgentResult,
  PromptAgentRequest,
  PromptAgentResult,
  StopAgentRequest,
  StopAgentResult,
  FetchImplementation,
  UploadProgressHandler,
  UploadResult,
  WorkspaceBroadcastRequest,
  WorkspaceBroadcastResult,
  WorkspaceList,
  HerdrWorkspaceView,
  RoleDefinition,
  RoleDetail,
  RoleList,
  RolePreset,
  RenameTabRequest,
  RenameTabResult,
  UpdateLauncherRequest,
  UpdateRoleRequest,
  UpdateRoleRuntimeRequest,
} from "./types"

const DEFAULT_BASE_URL = "http://127.0.0.1:6747"
type HttpMethod = "DELETE" | "GET" | "POST" | "PUT"

async function decodeJson<
  TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(
  response: Response,
  endpoint: string,
  schema: TSchema,
  operation?: Operation,
): Promise<Result<v.InferOutput<TSchema>, ApiDecodeError>> {
  const textResult = await Result.tryPromise<string, ApiDecodeError>({
    try: () => response.text(),
    catch: (cause) =>
        new ApiDecodeError({
          endpoint,
          cause,
          message: "The server response could not be read",
          operation,
      }),
  })

  return textResult.andThen((text) => {
    const parsedResult = Result.try({
      try: () => JSON.parse(text),
      catch: (cause) =>
        new ApiDecodeError({
          endpoint,
          cause,
          message: "The server returned invalid JSON",
          operation,
        }),
    })

    return parsedResult.andThen((value) => {
      const decoded = v.safeParse(schema, value)
      return decoded.success
        ? Result.ok(decoded.output)
        : Result.err(
            new ApiDecodeError({
              endpoint,
              cause: decoded.issues,
              message: "The server response did not match the API contract",
              operation,
            }),
          )
    })
  })
}

export class HttpMsgrApi implements MsgrApi {
  private readonly baseUrl: string
  private readonly onUnauthorized: (() => void) | undefined
  private readonly token: string | undefined
  private readonly fetchImpl: FetchImplementation

  public constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "")
    this.onUnauthorized = options.onUnauthorized
    this.token = options.token
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  private request<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    method: HttpMethod,
    path: string,
    schema: TSchema,
    requestBody?: RequestBody,
  ): Promise<Result<v.InferOutput<TSchema>, ApiError>> {
    const headers = new Headers({ Accept: "application/json" })
    if (requestBody !== undefined) headers.set("Content-Type", "application/json")
    if (this.token !== undefined) headers.set("X-Msgr-Token", this.token)

    const endpoint = `${this.baseUrl}${path}`
    const operation = operationForRequest(method, path)
    const requestInit: RequestInit = {
      method,
      headers,
      credentials: "include",
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    }

    return Result.tryPromise<Response, ApiNetworkError>({
      try: () => this.fetchImpl(endpoint, requestInit),
      catch: (cause) =>
        new ApiNetworkError({
          cause,
          message: "The messenger server could not be reached",
          operation,
        }),
    }).then((responseResult) =>
      responseResult.andThenAsync(async (response) => {
        if (!response.ok) {
          if (response.status === 401) this.onUnauthorized?.()
          const bodyResult = await Result.tryPromise<string, ApiNetworkError>({
            try: () => response.text(),
            catch: (cause) =>
              new ApiNetworkError({
                cause,
                message: "The messenger server error response could not be read",
                operation,
              }),
          })
          return bodyResult.andThen((body) =>
            Result.err(
              new ApiHttpError({
                body,
                message: `The messenger server rejected ${method} ${path}`,
                operation,
                status: response.status,
                value: requestValue(operation, requestBody),
              }),
            ),
          )
        }
        return decodeJson(response, path, schema, operation)
      }),
    )
  }

  public createAgent(request: CreateAgentRequest): ApiResult<AgentProvision> {
    return this.request("POST", "/api/agents", agentProvisionSchema, request)
  }

  public getAgentDetail(handle: string): ApiResult<AgentDetail> {
    return this.request("GET", `/api/agents/${encodeURIComponent(handle)}`, agentDetailSchema)
  }

  public getAgentSession(paneId: string, query: SessionQuery = {}): ApiResult<AgentSession> {
    const params = new URLSearchParams()
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    if (query.before !== undefined) params.set("before", String(query.before))
    const suffix = params.size === 0 ? "" : `?${params.toString()}`
    return this.request(
      "GET",
      `/api/herdr/agents/${encodeURIComponent(paneId)}/session${suffix}`,
      agentSessionSchema,
    )
  }

  public selectAgentSession(paneId: string, request: AgentSessionSelectionRequest): ApiResult<AgentSessionSelection> {
    return this.request(
      "POST",
      `/api/herdr/agents/${encodeURIComponent(paneId)}/session/select`,
      agentSessionSelectionSchema,
      request,
    )
  }

  public createHuman(request: CreateHumanRequest): ApiResult<HumanRegistration> {
    return this.request("POST", "/api/humans", humanRegistrationSchema, request)
  }

  public createChannel(request: CreateChannelRequest): ApiResult<Channel> {
    return this.request("POST", "/api/channels", channelSchema, request)
  }

  public deleteChannel(name: string, request: DeleteChannelRequest): ApiResult<DeleteChannelResult> {
    return this.request(
      "DELETE",
      `/api/channels/${encodeURIComponent(name)}`,
      deleteChannelResultSchema,
      request,
    )
  }

  public createDirect(request: CreateDirectRequest): ApiResult<DirectResult> {
    return this.request("POST", "/api/direct", directResultSchema, request)
  }

  public listWorkspaces(): ApiResult<WorkspaceList> {
    return this.request("GET", "/api/herdr/workspaces", workspaceListSchema)
  }

  public listDirectories(path?: string): ApiResult<DirectoryList> {
    const suffix = path === undefined ? "" : `?path=${encodeURIComponent(path)}`
    return this.request("GET", `/api/herdr/directories${suffix}`, directoryListSchema)
  }

  public createWorkspace(request: CreateWorkspaceRequest): ApiResult<HerdrWorkspaceView> {
    return this.request("POST", "/api/herdr/workspaces", createWorkspaceResultSchema, request)
      .then((result) => result.map(({ workspace }) => workspace))
  }

  public closeWorkspace(id: string, request: CloseWorkspaceRequest): ApiResult<CloseWorkspaceResult> {
    return this.request(
      "DELETE",
      `/api/herdr/workspaces/${encodeURIComponent(id)}`,
      closeWorkspaceResultSchema,
      request,
    )
  }

  public broadcastWorkspace(id: string, request: WorkspaceBroadcastRequest): ApiResult<WorkspaceBroadcastResult> {
    return this.request(
      "POST",
      `/api/herdr/workspaces/${encodeURIComponent(id)}/broadcast`,
      workspaceBroadcastResultSchema,
      request,
    )
  }

  public createTab(request: CreateTabRequest): ApiResult<CreateTabResult> {
    return this.request("POST", "/api/herdr/tabs", createTabResultSchema, request)
  }

  public renameTab(id: string, request: RenameTabRequest): ApiResult<RenameTabResult> {
    return this.request("PUT", `/api/herdr/tabs/${encodeURIComponent(id)}`, renameTabResultSchema, request)
  }

  public focusTab(id: string): ApiResult<FocusTabResult> {
    return this.request("POST", `/api/herdr/tabs/${encodeURIComponent(id)}/focus`, focusTabResultSchema, {})
  }

  public closeTab(id: string, request: CloseTabRequest): ApiResult<CloseTabResult> {
    return this.request("DELETE", `/api/herdr/tabs/${encodeURIComponent(id)}`, closeTabResultSchema, request)
  }

  public listHarnesses(): ApiResult<HarnessList> {
    return this.request("GET", "/api/herdr/harnesses", harnessListSchema)
  }

  public listLaunchers(): ApiResult<LauncherList> {
    return this.request("GET", "/api/herdr/launchers", launcherListSchema)
  }

  public createLauncher(request: CreateLauncherRequest): ApiResult<Launcher> {
    return this.request("POST", "/api/herdr/launchers", launcherSchema, request)
  }

  public updateLauncher(name: string, request: UpdateLauncherRequest): ApiResult<Launcher> {
    return this.request("PUT", `/api/herdr/launchers/${encodeURIComponent(name)}`, launcherSchema, request)
  }

  public deleteLauncher(name: string): ApiResult<DeleteLauncherResult> {
    return this.request("DELETE", `/api/herdr/launchers/${encodeURIComponent(name)}`, deleteLauncherResultSchema)
  }

  public listRoles(): ApiResult<RoleList> {
    return this.request("GET", "/api/herdr/roles", roleListSchema)
  }

  public getRole(name: string): ApiResult<RoleDetail> {
    return this.request("GET", `/api/herdr/roles/${encodeURIComponent(name)}`, roleDetailSchema).then((result) =>
      result.map((value) => ("role" in value ? value : { role: value })),
    )
  }

  public createRole(request: CreateRoleRequest): ApiResult<RoleDefinition> {
    return this.request("POST", "/api/herdr/roles", roleDefinitionSchema, request)
  }

  public updateRole(name: string, request: UpdateRoleRequest): ApiResult<RoleDefinition> {
    return this.request("PUT", `/api/herdr/roles/${encodeURIComponent(name)}`, roleDefinitionSchema, request)
  }

  public updateRoleRuntime(name: string, request: UpdateRoleRuntimeRequest): ApiResult<RolePreset> {
    return this.request("PUT", `/api/herdr/roles/${encodeURIComponent(name)}/runtime`, rolePresetSchema, request)
  }

  public deleteRole(name: string): ApiResult<DeleteRoleResult> {
    return this.request("DELETE", `/api/herdr/roles/${encodeURIComponent(name)}`, deleteRoleResultSchema)
  }

  public listModels(): ApiResult<ModelList> {
    return this.request("GET", "/api/herdr/models", modelListSchema)
  }

  public listModelCatalogue(): ApiResult<ModelCatalogueSnapshot> {
    return this.request("GET", "/api/herdr/model-catalogue", modelCatalogueSchema)
  }

  public refreshModelCatalogue(request: ModelCatalogueRefreshRequest): ApiResult<ModelCatalogueSnapshot> {
    return this.request("POST", "/api/herdr/model-catalogue", modelCatalogueSchema, request)
  }

  public createModel(request: CreateModelRequest): ApiResult<ModelEntry> {
    return this.request("POST", "/api/herdr/models", modelSchema, request)
  }

  public spawnAgent(request: SpawnAgentRequest): ApiResult<SpawnAgentResult> {
    return this.request("POST", "/api/herdr/agents", spawnAgentResultSchema, request)
  }

  public stopAgent(paneId: string, request: StopAgentRequest): ApiResult<StopAgentResult> {
    return this.request(
      "DELETE",
      `/api/herdr/agents/${encodeURIComponent(paneId)}`,
      stopAgentResultSchema,
      request,
    )
  }

  public connectAgent(paneId: string, request: ConnectAgentRequest): ApiResult<ConnectAgentResult> {
    return this.request(
      "POST",
      `/api/herdr/agents/${encodeURIComponent(paneId)}/connect`,
      connectAgentResultSchema,
      request,
    )
  }

  public promptAgent(paneId: string, request: PromptAgentRequest): ApiResult<PromptAgentResult> {
    return this.request(
      "POST",
      `/api/herdr/agents/${encodeURIComponent(paneId)}/prompt`,
      promptAgentResultSchema,
      request,
    )
  }

  public listChannels(kind?: "chat" | "workspace"): ApiResult<ChannelList> {
    const suffix = kind === undefined ? "" : `?kind=${encodeURIComponent(kind)}`
    return this.request("GET", `/api/channels${suffix}`, channelListSchema)
  }

  public listDirect(): ApiResult<DirectList> {
    return this.request("GET", "/api/direct", directListSchema)
  }

  public joinChannel(name: string): ApiResult<JoinResult> {
    return this.request(
      "POST",
      `/api/channels/${encodeURIComponent(name)}/join`,
      joinResultSchema,
      {},
    )
  }

  public addMember(name: string, handle: string): ApiResult<AddedMember> {
    return this.request(
      "POST",
      `/api/channels/${encodeURIComponent(name)}/members`,
      addedMemberSchema,
      { handle },
    )
  }

  public removeMember(name: string, handle: string): ApiResult<RemovedMember> {
    return this.request(
      "DELETE",
      `/api/channels/${encodeURIComponent(name)}/members/${encodeURIComponent(handle)}`,
      removedMemberSchema,
    )
  }

  public sendMessage(name: string, request: SendMessageRequest): ApiResult<Message> {
    return this.request(
      "POST",
      `/api/channels/${encodeURIComponent(name)}/messages`,
      messageSchema,
      request,
    )
  }

  public fetchMessages(name: string): ApiResult<FetchResult> {
    return this.request(
      "POST",
      `/api/channels/${encodeURIComponent(name)}/fetch`,
      fetchResultSchema,
      {},
    )
  }

  public acknowledge(name: string, request: AckRequest): ApiResult<AckResult> {
    return this.request(
      "POST",
      `/api/channels/${encodeURIComponent(name)}/ack`,
      ackResultSchema,
      request,
    )
  }

  public listMessages(name: string, query: HistoryQuery = {}): ApiResult<MessageList> {
    const params = new URLSearchParams()
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    if (query.before !== undefined) params.set("before", String(query.before))
    const suffix = params.size === 0 ? "" : `?${params.toString()}`
    return this.request(
      "GET",
      `/api/channels/${encodeURIComponent(name)}/messages${suffix}`,
      messageListSchema,
    )
  }

  public context(name: string, query: ContextQuery): ApiResult<MessageList> {
    const params = new URLSearchParams({ around: String(query.around) })
    if (query.span !== undefined) params.set("span", String(query.span))
    return this.request(
      "GET",
      `/api/channels/${encodeURIComponent(name)}/context?${params.toString()}`,
      messageListSchema,
    )
  }

  public listMembers(name: string): ApiResult<MemberList> {
    return this.request(
      "GET",
      `/api/channels/${encodeURIComponent(name)}/members`,
      memberListSchema,
    )
  }

  public listReceipts(name: string): ApiResult<ChannelReceipt[]> {
    return this.request(
      "GET",
      `/api/channels/${encodeURIComponent(name)}/receipts`,
      channelReceiptListSchema,
    )
  }

  public listParticipants(): ApiResult<ParticipantList> {
    return this.request("GET", "/api/participants", participantListSchema)
  }

  public inbox(): ApiResult<InboxList> {
    return this.request("GET", "/api/inbox", inboxListSchema)
  }

  public search(query: SearchQuery): ApiResult<SearchList> {
    const params = new URLSearchParams({ q: query.q })
    if (query.channel !== undefined) params.set("channel", query.channel)
    if (query.kind !== undefined) params.set("kind", query.kind)
    if (query.sender !== undefined) params.set("sender", query.sender)
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    return this.request("GET", `/api/search?${params.toString()}`, searchListSchema)
  }

  public listAttachments(query: AttachmentListQuery = {}): ApiResult<AttachmentList> {
    const params = new URLSearchParams()
    if (query.channel !== undefined) params.set("channel", query.channel)
    if (query.kind !== undefined) params.set("kind", query.kind)
    if (query.limit !== undefined) params.set("limit", String(query.limit))
    const suffix = params.toString().length === 0 ? "" : `?${params.toString()}`
    return this.request("GET", `/api/attachments${suffix}`, attachmentListSchema)
  }

  public attachmentContent(id: number): ApiResult<string> {
    const path = `/api/attachments/${id}/content`
    const operation: Operation = "attachmentContent"
    const headers = new Headers({ Accept: "text/markdown" })
    if (this.token !== undefined) headers.set("X-Msgr-Token", this.token)
    return Result.tryPromise<Response, ApiNetworkError>({
      try: () =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          credentials: "include",
          headers,
          method: "GET",
        }),
      catch: (cause) =>
        new ApiNetworkError({
          cause,
          message: "The attachment content could not be reached",
          operation,
        }),
    }).then((responseResult) =>
      responseResult.andThenAsync(async (response) => {
        const bodyResult = await Result.tryPromise<string, ApiNetworkError>({
          try: () => response.text(),
          catch: (cause) =>
            new ApiNetworkError({
              cause,
              message: "The attachment response could not be read",
              operation,
            }),
        })
        return response.ok
          ? bodyResult
          : bodyResult.andThen((body) =>
              Result.err(
                new ApiHttpError({
                  body,
                  message: `The messenger server rejected GET ${path}`,
                  operation,
                  status: response.status,
                }),
              ),
            )
      }),
    )
  }

  public attachmentContentUrl(id: number): string {
    return `${this.baseUrl}/api/attachments/${id}/content`
  }

  public uploadFile(file: Blob, filename: string, onProgress?: UploadProgressHandler): ApiResult<UploadResult> {
    const path = "/api/uploads"
    const operation: Operation = "uploadFile"
    const headers = new Headers({
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
      "X-Msgr-Filename": filename,
    })
    if (this.token !== undefined) headers.set("X-Msgr-Token", this.token)
    onProgress?.({ loaded: 0, total: file.size })
    return Result.tryPromise<Response, ApiNetworkError>({
      try: () =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          body: file,
          credentials: "include",
          headers,
          method: "POST",
        }),
      catch: (cause) =>
        new ApiNetworkError({
          cause,
          message: "The file upload could not be reached",
          operation,
        }),
    }).then((responseResult) =>
      responseResult.andThenAsync(async (response) => {
        if (!response.ok) {
          const bodyResult = await Result.tryPromise<string, ApiNetworkError>({
            try: () => response.text(),
            catch: (cause) =>
              new ApiNetworkError({
                cause,
                message: "The upload error response could not be read",
                operation,
              }),
          })
          return bodyResult.andThen((body) =>
            Result.err(
              new ApiHttpError({
                body,
                message: `The messenger server rejected POST ${path}`,
                operation,
                status: response.status,
              }),
            ),
          )
        }
        onProgress?.({ loaded: file.size, total: file.size })
        return decodeJson(response, path, uploadResultSchema, operation)
      }),
    )
  }
}

function operationForRequest(method: HttpMethod, path: string): Operation {
  if (path === "/api/channels" && method === "POST") return "createChannel"
  if (path === "/api/channels" && method === "GET") return "listChannels"
  if (/^\/api\/channels\/[^/]+$/u.test(path) && method === "DELETE") return "deleteChannel"
  if (path.startsWith("/api/agents/") && method === "GET") return "getAgentDetail"
  if (path.startsWith("/api/herdr/agents/") && path.endsWith("/session/select") && method === "POST") return "selectAgentSession"
  if (path.startsWith("/api/herdr/agents/") && path.includes("/session") && method === "GET") return "getAgentSession"
  if (path === "/api/direct" && method === "POST") return "createDirect"
  if (path === "/api/direct" && method === "GET") return "listDirect"
  if (path === "/api/humans") return "createHuman"
  if (path === "/api/participants") return "listParticipants"
  if (path === "/api/inbox") return "inbox"
  if (path === "/api/search" || path.startsWith("/api/search?")) return "search"
  if (path === "/api/attachments" || path.startsWith("/api/attachments?")) return "listAttachments"
  if (path === "/api/herdr/workspaces" && method === "GET") return "listWorkspaces"
  if (path === "/api/herdr/directories" || path.startsWith("/api/herdr/directories?")) return "listDirectories"
  if (path === "/api/herdr/workspaces" && method === "POST") return "createWorkspace"
  if (path === "/api/herdr/tabs" && method === "POST") return "createTab"
  if (path.startsWith("/api/herdr/tabs/") && path.endsWith("/focus") && method === "POST") return "focusTab"
  if (path.startsWith("/api/herdr/tabs/") && method === "PUT") return "renameTab"
  if (path.startsWith("/api/herdr/tabs/") && method === "DELETE") return "closeTab"
  if (path === "/api/herdr/harnesses" && method === "GET") return "listHarnesses"
  if (path === "/api/herdr/launchers" && method === "GET") return "listLaunchers"
  if (path === "/api/herdr/launchers" && method === "POST") return "createLauncher"
  if (path.startsWith("/api/herdr/launchers/") && method === "PUT") return "updateLauncher"
  if (path.startsWith("/api/herdr/launchers/") && method === "DELETE") return "deleteLauncher"
  if (path === "/api/herdr/roles" && method === "GET") return "listRoles"
  if (path === "/api/herdr/roles" && method === "POST") return "createRole"
  if (path.startsWith("/api/herdr/roles/") && method === "GET") return "getRole"
  if (path.endsWith("/runtime") && path.startsWith("/api/herdr/roles/") && method === "PUT") return "updateRoleRuntime"
  if (path.startsWith("/api/herdr/roles/") && method === "PUT") return "updateRole"
  if (path.startsWith("/api/herdr/roles/") && method === "DELETE") return "deleteRole"
  if (path === "/api/herdr/models" && method === "GET") return "listModels"
  if (path === "/api/herdr/models" && method === "POST") return "createModel"
  if (path === "/api/herdr/model-catalogue" && method === "GET") return "listModelCatalogue"
  if (path === "/api/herdr/model-catalogue" && method === "POST") return "refreshModelCatalogue"
  if (path === "/api/herdr/agents" && method === "POST") return "spawnAgent"
  if (path.startsWith("/api/herdr/agents/") && path.endsWith("/connect") && method === "POST") return "connectAgent"
  if (path.startsWith("/api/herdr/agents/") && path.endsWith("/prompt") && method === "POST") return "promptAgent"
  if (path.startsWith("/api/herdr/agents/") && method === "DELETE") return "stopAgent"
  if (path.includes("/broadcast")) return "broadcastWorkspace"
  if (path.includes("/api/herdr/workspaces/")) return "closeWorkspace"
  if (path.includes("/join")) return "joinChannel"
  if (path.endsWith("/members") && method === "POST") return "addMember"
  if (path.endsWith("/members") && method === "GET") return "listMembers"
  if (path.includes("/members/") && method === "DELETE") return "removeMember"
  if (path.endsWith("/fetch")) return "fetchMessages"
  if (path.endsWith("/ack")) return "acknowledge"
  if (path.includes("/context")) return "context"
  if (path.includes("/messages") && method === "GET") return "listMessages"
  if (path.includes("/messages") && method === "POST") return "sendMessage"
  return "listChannels"
}

function requestValue(operation: Operation, body: RequestBody | undefined): string | undefined {
  if (body === undefined) return undefined
  if (operation === "createHuman" && "handle" in body) return body.handle
  if (operation === "spawnAgent" && "launcher" in body) return body.launcher ?? undefined
  return undefined
}
