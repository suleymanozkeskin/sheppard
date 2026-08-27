import { Result, TaggedError } from "better-result"
import * as v from "valibot"

export type Operation =
  | "createChannel" | "deleteChannel" | "createDirect" | "createHuman" | "joinChannel"
  | "addMember" | "removeMember" | "sendMessage" | "fetchMessages" | "acknowledge"
  | "listChannels" | "listDirect" | "listMessages" | "listMembers"
  | "listParticipants" | "context" | "inbox" | "search"
  | "listAttachments" | "attachmentContent" | "uploadFile"
  | "getAgentDetail" | "getAgentSession" | "selectAgentSession"
  | "listWorkspaces" | "listDirectories" | "createWorkspace" | "closeWorkspace" | "broadcastWorkspace"
  | "createTab" | "renameTab" | "focusTab" | "closeTab"
  | "listHarnesses" | "listLaunchers" | "createLauncher" | "updateLauncher" | "deleteLauncher"
  | "listRoles" | "getRole" | "createRole" | "updateRole" | "updateRoleRuntime" | "deleteRole"
  | "listModels" | "createModel" | "listModelCatalogue" | "refreshModelCatalogue"
  | "spawnAgent" | "stopAgent" | "promptAgent"

const responseBodySchema = v.object({
  code: v.optional(v.string()),
  error: v.optional(v.string()),
})

export class ApiNetworkError extends TaggedError("ApiNetworkError")<{
  message: string
  cause: unknown
  operation?: Operation
}> {}

export class ApiHttpError extends TaggedError("ApiHttpError")<{
  message: string
  status: number
  body: string
  value?: string
  operation?: Operation
}> {}

export class ApiDecodeError extends TaggedError("ApiDecodeError")<{
  message: string
  endpoint: string
  cause: unknown
  operation?: Operation
}> {}

export class ApiNotFoundError extends TaggedError("ApiNotFoundError")<{
  message: string
  resource: string
}> {}

export class ApiConflictError extends TaggedError("ApiConflictError")<{
  message: string
  resource: string
}> {}

export type ApiError =
  | ApiNetworkError
  | ApiHttpError
  | ApiDecodeError
  | ApiNotFoundError
  | ApiConflictError

export interface ApiErrorContext {
  harnesses?: readonly string[]
  launchers?: readonly string[]
  lifecycleExpected?: string
  lifecycleRole?: string
  lifecycleWorkspaceLabel?: string
  roles?: readonly string[]
}

export function formatApiError(error: ApiError, context: ApiErrorContext = {}): string {
  return error.match({
    ApiNetworkError: () => "The hub is not answering. Start it with msgr serve, then retry.",
    ApiHttpError: (failure) => formatHttpFailure(failure, context),
    ApiDecodeError: () => "The hub sent a reply this app does not understand (invalid JSON or an older contract). The hub and this page are probably different versions. Reload the page.",
    ApiNotFoundError: (failure) => failure.message,
    ApiConflictError: (failure) => failure.message,
  })
}

function spawnFailureCopy(detail: string | undefined): string {
  if (detail?.includes("cleanup state is unresolved") === true) {
    const marker = "while cleaning up pane "
    const markerIndex = detail.indexOf(marker)
    const pane = markerIndex < 0 ? undefined : detail.slice(markerIndex + marker.length).split(";")[0]?.trim()
    if (pane === undefined || pane.length === 0) {
      return "The spawn failed and cleanup is unresolved. The pane state is unknown. Check for a leftover pane before you retry."
    }
    return `The spawn failed and cleanup is unresolved. Pane ${pane} may still be open. Check it before you retry.`
  }
  const marker = "while starting pane "
  const markerIndex = detail?.indexOf(marker) ?? -1
  const pane = markerIndex < 0 ? undefined : detail?.slice(markerIndex + marker.length).trim()
  if (detail?.includes("timed out while starting pane ") === true && pane !== undefined && pane.length > 0) {
    return `herdr did not answer in time while starting the agent. Pane ${pane} was opened first. If no agent appears in it, close it. Do not retry until the pane is resolved.`
  }
  if (pane !== undefined && pane.length > 0) {
    return `herdr could not confirm the spawn. Pane ${pane} was opened first. Inspect it and close it if no agent appears.`
  }
  return "The spawn failed. Nothing was created. The pane from the partial spawn was closed."
}

function formatHttpFailure(failure: Extract<ApiError, { _tag: "ApiHttpError" }>, context: ApiErrorContext): string {
  const operation = failure.operation
  const code = responseCode(failure.body)
  const status = failure.status
  if (code === "NotAMember" || (status === 400 && failure.body.toLocaleLowerCase().includes("not a member"))) {
    return "You have not joined this channel. Join it to track unread and post."
  }
  if (code === "ChannelExists" || (status === 409 && operation === "createChannel")) return "A channel with that name already exists. Open it from the sidebar, or pick another name."
  if (code === "ChannelNotDeletable") return "Only chat channels can be deleted."
  if (code === "HandleTaken" || (status === 409 && operation === "createHuman")) return `The hub refused the identity request: "${failure.value ?? "that name"}" is taken.`
  if (code === "MembershipExists" || (status === 409 && operation === "addMember")) return "That participant is already a member."
  if (code === "NotPreviewable" || status === 415) return "This file type has no preview. Copy the path and open it in your editor."
  if (code === "UploadStorageFailed" || (status === 500 && operation === "uploadFile")) return "The hub could not store that file. Check free space, then retry."
  if (code === "HerdrSessionMismatch") return "This hub belongs to another herdr session. Use the hub started by the session you are working in."
  if (code === "DirectMembershipLocked") return "A direct conversation has fixed members. Create a channel if you need to add people."
  if (code === "OperatorOnly") return "Only the operator may delete channels."
  if (code === "RequestRejected" || status === 403) return "This page was not served by the hub. Open Sheppard from 127.0.0.1:6747."
  if (code === "Unauthorized" || status === 401) return "Your session has expired. Reload the page to reconnect."
  if (code === "HerdrNotConfigured") return "This hub is not attached to herdr. Workspaces are unavailable. Restart the hub from inside herdr to control panes."
  if (code === "HerdrCallFailed" && operation === "spawnAgent") return spawnFailureCopy(responseDetail(failure.body))
  if (code === "HerdrCallFailed") return "herdr did not answer in time. Retry. Channels and messages are unaffected."
  if (code === "HerdrUnavailable" || status === 503) return "Workspaces are unavailable. Channels and messages are unaffected."
  const detail = responseDetail(failure.body)?.toLocaleLowerCase()
  if ((operation === "createLauncher" || operation === "updateLauncher") && status === 400 && detail?.includes("argv[0]") === true) {
    return "The first argv entry must equal agentKind. Change the command before saving."
  }
  if (status === 409 && operation === "createLauncher") return "A launcher with that name already exists. Pick another name."
  if (status === 404 && (operation === "updateLauncher" || operation === "deleteLauncher")) return "That launcher is no longer registered. Reload the launcher list."
  if (operation === "spawnAgent" && status === 400 && detail !== undefined) {
    if (detail.includes("already has a reporter")) return `This workspace already has a reporter. Open progress-${context.lifecycleWorkspaceLabel ?? "the workspace"}. A second reporter doubles the cost for the same updates.`
    if (detail.includes("does not match the selected role")) return `The ${context.lifecycleRole ?? "selected"} role runs on its configured launcher. Pick that launcher, or choose a different role.`
    if (detail.includes("active agent limit")) return "This workspace is at its agent limit. Stop an agent in it before spawning another."
    if (detail.includes("not an available role") || detail.includes("role is not available")) {
      const role = context.lifecycleRole ?? failure.value ?? "That role"
      const roles = context.roles !== undefined && context.roles.length > 0 ? context.roles.join(", ") : "Workspace settings"
      return `"${role}" is not an available role. Pick one of: ${roles}. Roles are presets the hub publishes.`
    }
    if (detail.includes("not an available launcher") || detail.includes("launcher is not available")) {
      const launchers = context.launchers !== undefined && context.launchers.length > 0 ? context.launchers.join(", ") : "Workspace settings"
      return `"${failure.value ?? "That launcher"}" is not an available launcher. Pick one of: ${launchers}. The hub decides which launchers it will launch.`
    }
    if (detail.includes("launcher is required")) return "Choose a launcher or a role before starting the agent."
  }
  if (operation === "stopAgent" && status === 400 && detail?.includes("pane identity changed") === true) {
    return "That pane changed while the dialog was open. Nothing was stopped. Check what is running there now, then try again."
  }
  if (operation === "stopAgent" && status === 400 && detail?.includes("does not match") === true) {
    return `The name you typed does not match. Type ${context.lifecycleExpected ?? "the participant handle"} exactly to stop it.`
  }
  if (status === 404 && operation === "spawnAgent") return "That workspace is no longer open. Pick another workspace. The list refreshes on its own."
  if (status === 404 && operation === "stopAgent") return "That pane is already gone. The agent has stopped. Its handle and history remain."
  if (status === 404 && operation === "closeTab") return "That tab is already gone. Refresh the workspace to see its current tabs."
  if (status === 404 && operation === "getAgentDetail") return "That agent is not active. Return to Agents and choose another agent."
  if (status === 404 && operation === "addMember") return "No participant has that handle. Provision the agent first with msgr provision."
  if (status === 404 && operation === "removeMember") return "That participant is not a member of this channel."
  if (status === 404 && operation === "deleteChannel") return "That channel is no longer available. Reload the channel list."
  if (status === 404 && operation === "attachmentContent") return "This file is no longer available."
  if (status === 404 && operation === "context") return "That message is no longer in this channel. Search again to get a current result."
  if (status === 400 && operation === "createChannel") return "That channel name is not allowed. Use lowercase letters, digits, - or _. Start with a letter. Keep it to 32 characters."
  if (status === 400 && operation === "deleteChannel") return "The channel name confirmation does not match. Type the channel name exactly."
  if (status === 400 && operation === "createHuman") return "The hub refused the identity request. The hub and this page are probably different versions. Reload the page."
  if (status === 400 && operation === "addMember") return "That is not a valid handle. Use lowercase letters, digits, - or _. Start with a letter."
  if (status === 400 && operation === "closeWorkspace") return "The name you typed does not match. Type the workspace label exactly as shown, then close it."
  if (status === 400 && operation === "closeTab") return "The name you typed does not match. Type the tab label exactly as shown, then close it."
  if (status === 400 && operation === "spawnAgent" && detail?.includes("handle") === true) return "That is not a valid handle. Use lowercase letters, digits, - or _. Start with a letter. Keep it to 32 characters."
  if (status === 400 && operation === "search") return "That search is too long. Keep the query to 256 characters."
  const rawDetail = responseDetail(failure.body)
  return rawDetail === undefined ? "The hub refused that request." : rawDetail
}

function responseCode(body: string): string | undefined {
  const parsed = parseResponseBody(body)
  return parsed?.code
}

function responseDetail(body: string): string | undefined {
  const parsed = parseResponseBody(body)
  return parsed?.error
}

function parseResponseBody(body: string): v.InferOutput<typeof responseBodySchema> | undefined {
  return Result.try<unknown, undefined>({
    try: () => JSON.parse(body),
    catch: () => undefined,
  }).match({
    ok: (value) => {
      const decoded = v.safeParse(responseBodySchema, value)
      return decoded.success ? decoded.output : undefined
    },
    err: () => undefined,
  })
}
