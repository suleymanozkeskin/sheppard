import { describe, expect, test } from "bun:test"
import { COMMAND_MESSAGE_LIMIT } from "./types"
import { COMMAND_DRAFT_LIMIT, commandDraftKey, setDraftDelivery, updateCommandDraft, type CommandDrafts, type CommandDraftTarget } from "./drafts"

const target: CommandDraftTarget = { kind: "message", recipient: { kind: "agent", handle: "reviewer", routeState: "active" } }

describe("command drafts", () => {
  test("stores a draft without changing the source map", () => {
    const before: CommandDrafts = new Map()
    const result = updateCommandDraft(before, target, "Review this.")
    expect(result.isOk()).toBe(true)
    expect(before.size).toBe(0)
    if (result.isOk()) expect(result.value.get(commandDraftKey(target))?.body).toBe("Review this.")
  })

  test("clearing editable text frees its slot", () => {
    const result = updateCommandDraft(new Map(), target, "Draft").andThen((drafts) => updateCommandDraft(drafts, target, ""))
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.size).toBe(0)
  })

  test("editing or clearing text cannot remove send uncertainty", () => {
    const result = updateCommandDraft(new Map(), target, "Draft").andThen((drafts) => updateCommandDraft(setDraftDelivery(drafts, commandDraftKey(target), "uncertain"), target, ""))
    expect(result.isOk()).toBe(true)
    if (result.isOk()) expect(result.value.get(commandDraftKey(target))).toEqual({ target, body: "", delivery: "uncertain" })
  })

  test("limits new targets without removing current drafts", () => {
    const drafts: CommandDrafts = new Map(Array.from({ length: COMMAND_DRAFT_LIMIT }, (_, index) => [String(index), { target, body: "Draft", delivery: "editable" as const }]))
    expect(updateCommandDraft(drafts, target, "New draft").isErr()).toBe(true)
    expect(drafts.size).toBe(COMMAND_DRAFT_LIMIT)
  })

  test("rejects oversized text", () => {
    expect(updateCommandDraft(new Map(), target, "x".repeat(COMMAND_MESSAGE_LIMIT + 1)).isErr()).toBe(true)
  })

  test("delivery updates never create a missing draft", () => {
    const drafts: CommandDrafts = new Map()
    expect(setDraftDelivery(drafts, "missing", "uncertain")).toBe(drafts)
  })

  test("terminal and chat drafts have separate keys", () => {
    expect(commandDraftKey(target)).not.toBe(commandDraftKey({ kind: "terminal", handle: "reviewer" }))
  })
})
