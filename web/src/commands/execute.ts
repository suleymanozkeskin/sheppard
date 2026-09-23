import { Result } from "better-result"

import { formatApiError, type ApiError } from "@/api/errors"
import type { HerdrPaneView, MsgrApi } from "@/api/types"
import type { ShellRoute } from "@/shell-routing"
import { agentLocation } from "./catalog"
import { COMMAND_MESSAGE_LIMIT, messageTargetLabel, type MessageTarget } from "./types"

export type CommandFailure =
  Readonly<{ kind: "not-completed"; message: string }> | Readonly<{ kind: "outcome-unknown"; message: string }>

export interface CommandSuccess {
  readonly message: string
  readonly destination: ShellRoute
}

/** A failed reply does not prove that a write failed. No automatic retry is safe. */
export function commandWriteFailure(error: ApiError): CommandFailure {
  const uncertain =
    error._tag === "ApiNetworkError" ||
    error._tag === "ApiDecodeError" ||
    (error._tag === "ApiHttpError" && error.status >= 500)
  return Object.freeze(
    uncertain
      ? {
          kind: "outcome-unknown",
          message:
            "The hub did not confirm the result. Check the target before you try again; the action may have completed.",
        }
      : { kind: "not-completed", message: formatApiError(error) },
  )
}

export function messageDestination(target: MessageTarget): ShellRoute {
  switch (target.kind) {
    case "agent":
      return { kind: "agent", handle: target.handle }
    case "channel":
      return { kind: "channel", channel: target.channel }
    case "direct":
      return { kind: "conversation", channel: target.channel }
    case "broadcast":
      return { kind: "workspace", workspaceId: target.workspaceId }
  }
}

function validCommandText(body: string): Result<string, CommandFailure> {
  if (body.trim().length === 0)
    return Result.err({ kind: "not-completed", message: "Write a message before sending. Nothing was sent." })
  if (body.length > COMMAND_MESSAGE_LIMIT)
    return Result.err({
      kind: "not-completed",
      message: `The message exceeds ${COMMAND_MESSAGE_LIMIT} characters. Shorten it before sending. Nothing was sent.`,
    })
  return Result.ok(body.trim())
}

/** Sends once to the visible audience. Does not navigate, retry, or use mock fallback.
 * A rejected write preserves the draft. An uncertain reply requires inspection.
 */
export async function sendCommandMessage(
  api: MsgrApi,
  target: MessageTarget,
  body: string,
): Promise<Result<CommandSuccess, CommandFailure>> {
  const validated = validCommandText(body)
  if (validated.isErr()) return validated
  const text = validated.value
  switch (target.kind) {
    case "agent": {
      const result = await api.createDirect({ to: [target.handle], body: text })
      return result
        .map(({ channel }) =>
          Object.freeze({
            message: `Message sent to ${target.handle}.`,
            destination: { kind: "conversation" as const, channel },
          }),
        )
        .mapError(commandWriteFailure)
    }
    case "channel":
      if (target.membership === "not-joined")
        return Result.err({
          kind: "not-completed",
          message: `Join #${target.channel} before sending. Nothing was sent.`,
        })
      return sendToChannel(api, target, text)
    case "direct":
      return sendToChannel(api, target, text)
    case "broadcast": {
      const result = await api.broadcastWorkspace(target.workspaceId, { body: text })
      return result
        .map(() =>
          Object.freeze({ message: `Broadcast sent to ${target.label}.`, destination: messageDestination(target) }),
        )
        .mapError(commandWriteFailure)
    }
  }
}

async function sendToChannel(
  api: MsgrApi,
  target: Extract<MessageTarget, { kind: "channel" | "direct" }>,
  body: string,
): Promise<Result<CommandSuccess, CommandFailure>> {
  const result = await api.sendMessage(target.channel, { body })
  return result
    .map(() =>
      Object.freeze({
        message: `Message sent to ${messageTargetLabel(target)}.`,
        destination: messageDestination(target),
      }),
    )
    .mapError(commandWriteFailure)
}

/** Reads current topology before a terminal action. Missing or ambiguous links stop it. */
export async function currentAgentPane(api: MsgrApi, handle: string): Promise<Result<HerdrPaneView, CommandFailure>> {
  const result = await api.listWorkspaces()
  if (result.isErr()) return Result.err({ kind: "not-completed", message: formatApiError(result.error) })
  const location = agentLocation(result.value.workspaces, handle)
  switch (location.kind) {
    case "running":
      return Result.ok(location.pane)
    case "not-running":
      return Result.err({
        kind: "not-completed",
        message: `${handle} no longer has a running pane. No terminal action was sent.`,
      })
    case "ambiguous":
      return Result.err({
        kind: "not-completed",
        message: `${handle} has more than one pane link. Open its workspace to check the link. No terminal action was sent.`,
      })
  }
}

export async function focusCommandAgent(api: MsgrApi, handle: string): Promise<Result<CommandSuccess, CommandFailure>> {
  const result = await api.listWorkspaces()
  if (result.isErr()) return Result.err({ kind: "not-completed", message: formatApiError(result.error) })
  const location = agentLocation(result.value.workspaces, handle)
  if (location.kind !== "running")
    return Result.err({
      kind: "not-completed",
      message: `A unique running pane for ${handle} is not available. Nothing was focused.`,
    })
  const tabs = location.workspace.tabs.filter((tab) => tab.panes.some((pane) => pane.paneId === location.pane.paneId))
  const tab = tabs[0]
  if (tabs.length !== 1 || tab === undefined)
    return Result.err({
      kind: "not-completed",
      message: `The tab for ${handle} is not available. Refresh the workspace and retry.`,
    })
  const focused = await api.focusTab(tab.id)
  return focused
    .map(() =>
      Object.freeze({ message: `Focused ${handle} in Herdr.`, destination: { kind: "agent" as const, handle } }),
    )
    .mapError(commandWriteFailure)
}

export async function promptCommandAgent(
  api: MsgrApi,
  handle: string,
  body: string,
): Promise<Result<CommandSuccess, CommandFailure>> {
  const text = validCommandText(body)
  if (text.isErr()) return text
  const pane = await currentAgentPane(api, handle)
  if (pane.isErr()) return pane
  const result = await api.promptAgent(pane.value.paneId, { text: text.value })
  return result
    .map(() =>
      Object.freeze({ message: `Terminal input sent to ${handle}.`, destination: { kind: "agent" as const, handle } }),
    )
    .mapError(commandWriteFailure)
}
