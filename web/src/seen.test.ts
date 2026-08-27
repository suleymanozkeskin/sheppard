import { describe, expect, it } from "bun:test"

import { HttpMsgrApi } from "@/api/client"
import { MockMsgrApi } from "@/api/mock"
import type { ChannelReceipt, Message } from "@/api/types"
import { deriveMessageReceiptState, formatReceiptSummary, latestOwnMessageId } from "@/seen"

const message = (id: number, sender = "human"): Message => ({
  attachments: [],
  body: `message ${id}`,
  channel: "ops",
  createdAt: `2026-08-20T10:0${id}:00.000Z`,
  id,
  sender,
  senderAgentKind: null,
  senderKind: "human",
})

const receipt = (handle: string, cursorMessageId: number, routeState: ChannelReceipt["routeState"] = "active"): ChannelReceipt => ({
  cursorMessageId,
  handle,
  routeState,
})

describe("seen message derivation", () => {
  it("keeps stale, not-yet, and seen states separate", () => {
    const state = deriveMessageReceiptState([
      receipt("human", 99),
      receipt("worker-a", 2),
      receipt("worker-b", 1),
      receipt("worker-c", 0, "stale"),
      receipt("worker-d", 3, "stale"),
    ], 3, "human")

    expect(state).toEqual({
      cannotReceiveHandles: ["worker-c"],
      hasRecipients: true,
      notYetHandles: ["worker-a", "worker-b"],
      requiredRecipientsSeen: false,
      seenHandles: ["worker-d"],
    })
    expect(formatReceiptSummary(state)).toEqual({
      cannotReceive: "worker-c is not running",
      notYet: "Not yet seen by 2: worker-a, worker-b",
      seen: false,
    })
  })

  it("moves a healed route to not-yet and keeps an earlier seen message seen", () => {
    const receipts = [receipt("human", 99), receipt("worker-a", 4), receipt("worker-b", 0, "stale")]
    const earlier = deriveMessageReceiptState(receipts, 4, "human")
    expect(earlier.seenHandles).toEqual(["worker-a"])
    expect(earlier.cannotReceiveHandles).toEqual(["worker-b"])

    const staleAfterAck = receipts.map((current) => current.handle === "worker-a" ? { ...current, routeState: "stale" as const } : current)
    expect(deriveMessageReceiptState(staleAfterAck, 4, "human").seenHandles).toEqual(["worker-a"])

    const healed = receipts.map((current) => current.handle === "worker-b" ? { ...current, routeState: "active" as const } : current)
    const later = deriveMessageReceiptState(healed, 5, "human")
    expect(later.notYetHandles).toEqual(["worker-a", "worker-b"])
    expect(later.cannotReceiveHandles).toEqual([])
  })

  it("caps each alarm at five handles and states the residue", () => {
    const state = deriveMessageReceiptState([
      receipt("human", 99),
      ...Array.from({ length: 6 }, (_, index) => receipt(`worker-${index + 1}`, 0)),
    ], 1, "human")

    expect(formatReceiptSummary(state).notYet).toBe(
      "Not yet seen by 6: worker-1, worker-2, worker-3, worker-4, worker-5 · and 1 more",
    )
  })

  it("excludes the sender and renders no state for a one-member channel", () => {
    const state = deriveMessageReceiptState([receipt("human", 0)], 1, "human")
    expect(state.hasRecipients).toBe(false)
    expect(formatReceiptSummary(state)).toEqual({ cannotReceive: undefined, notYet: undefined, seen: false })
  })

  it("selects only the latest own message for inline state", () => {
    expect(latestOwnMessageId([message(1), message(2, "worker"), message(3)], "human")).toBe(3)
    expect(latestOwnMessageId([message(1, "worker")], "human")).toBeUndefined()
  })
})

describe("receipt API contract", () => {
  it("uses the member-scoped endpoint and decodes its direct array", async () => {
    let request: Request | undefined
    const api = new HttpMsgrApi({
      fetchImpl: async (input, init) => {
        request = new Request(input, init)
        return new Response(JSON.stringify([{ cursorMessageId: 4, handle: "worker-a", routeState: "active" }]), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      },
    })

    const result = await api.listReceipts("ops/weekly")
    expect([request?.method, new URL(request?.url ?? "http://127.0.0.1").pathname]).toEqual([
      "GET",
      "/api/channels/ops%2Fweekly/receipts",
    ])
    expect(result.match({ ok: (receipts) => receipts, err: () => [] })).toEqual([
      { cursorMessageId: 4, handle: "worker-a", routeState: "active" },
    ])
  })

  it("returns a cursor map without moving a mock read cursor", async () => {
    const api = new MockMsgrApi()
    const before = await api.listReceipts("ops")
    const after = await api.listReceipts("ops")
    expect(before).toEqual(after)
    expect(before.match({ ok: (receipts) => receipts.some((current) => current.handle === "old-runner"), err: () => false })).toBe(true)
  })
})
