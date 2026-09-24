import { Result } from "better-result"
import { ApiNotFoundError, type ApiError } from "@/api/errors"
import type { AgentRecentMessages, Message, MsgrApi } from "@/api/types"

const ACTIVITY_MESSAGE_LIMIT = 20
const ACTIVITY_CONTEXT_SPAN = 1

async function readActivityChannel(
  api: MsgrApi,
  channel: string,
  ids: readonly number[],
): Promise<Result<readonly Message[], ApiError>> {
  const latest = await api.listMessages(channel)
  if (latest.isErr()) return Result.err(latest.error)
  const wantedIds = new Set(ids)
  const found = latest.value.messages.filter((message) => wantedIds.has(message.id))
  const foundIds = new Set(found.map((message) => message.id))
  const missing = ids.filter((id) => !foundIds.has(id))
  const older = await Promise.all(
    missing.map(async (id) => {
      const context = await api.context(channel, { around: id, span: ACTIVITY_CONTEXT_SPAN })
      return context.andThen(({ messages }) => {
        const message = messages.find((item) => item.id === id)
        return message === undefined
          ? Result.err(
              new ApiNotFoundError({
                resource: "message",
                message: `Message ${id} in ${channel} is no longer available. Refresh the agent details.`,
              }),
            )
          : Result.ok(message)
      })
    }),
  )
  for (const result of older) {
    if (result.isErr()) return Result.err(result.error)
    found.push(result.value)
  }
  return Result.ok(found)
}

/** Reads at most 20 referenced messages. A history page that omits an older
 * reference triggers one exact context read. A missing message is an error,
 * not an empty activity report. Reads do not acknowledge or change messages.
 */
export async function readAgentActivity(
  api: MsgrApi,
  references: readonly AgentRecentMessages[],
): Promise<Result<readonly Message[], ApiError>> {
  const wanted = references
    .flatMap(({ channel, messageIds }) => messageIds.map((id) => ({ channel, id })))
    .toSorted((a, b) => b.id - a.id)
    .slice(0, ACTIVITY_MESSAGE_LIMIT)
  const channels = new Map<string, number[]>()
  for (const { channel, id } of wanted) {
    const ids = channels.get(channel) ?? []
    if (!ids.includes(id)) ids.push(id)
    channels.set(channel, ids)
  }
  const results = await Promise.all(
    [...channels.entries()].map(([channel, ids]) => readActivityChannel(api, channel, ids)),
  )
  const messages: Message[] = []
  for (const result of results) {
    if (result.isErr()) return Result.err(result.error)
    messages.push(...result.value)
  }
  return Result.ok(Object.freeze(messages.toSorted((a, b) => b.id - a.id)))
}
