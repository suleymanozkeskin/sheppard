import type { Message } from "@/api/types"

export function firstUnreadMessageId(
  messages: readonly Message[],
  unread: number,
  selfHandle: string | undefined,
  viewerCursorId?: number,
): number | undefined {
  if (unread <= 0) return undefined
  if (viewerCursorId !== undefined) {
    return messages.find((message) => message.id > viewerCursorId)?.id
  }
  const unreadMessages: Message[] = []
  for (const message of messages) {
    if (selfHandle === undefined || message.sender !== selfHandle) unreadMessages.push(message)
  }
  return unreadMessages.at(-unread)?.id
}
