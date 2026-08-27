import { describe, expect, test } from "bun:test"

import type { Message } from "./api/types"
import { firstUnreadMessageId } from "./message-unread"

function message(id: number, sender: string): Message {
  return {
    attachments: [],
    body: String(id),
    channel: "ops",
    createdAt: `2026-08-17T10:0${id}:00.000Z`,
    id,
    sender,
    senderAgentKind: null,
    senderKind: "human",
  }
}

describe("unread marker anchoring", () => {
  test("anchors by the first unread message id when self messages are interleaved", () => {
    const messages = [message(1, "agent"), message(2, "me"), message(3, "agent"), message(4, "me")]
    expect(firstUnreadMessageId(messages, 1, "me")).toBe(3)
    expect(firstUnreadMessageId(messages, 2, "me")).toBe(1)
  })

  test("uses the viewer cursor when the unread count excludes self messages", () => {
    const messages = [message(1, "agent"), message(2, "me"), message(3, "agent"), message(4, "me")]
    expect(firstUnreadMessageId(messages, 1, "me", 2)).toBe(3)
  })
})
