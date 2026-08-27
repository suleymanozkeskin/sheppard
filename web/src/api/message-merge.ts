import type { Message } from "./types"

export function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<number, Message>()
  for (const message of existing) byId.set(message.id, message)
  for (const message of incoming) {
    if (!byId.has(message.id)) byId.set(message.id, message)
  }
  return [...byId.values()].sort((left, right) => left.id - right.id)
}
