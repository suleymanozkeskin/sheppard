import { describe, expect, test } from "bun:test"
import { CommandDraftStore } from "./draft-store"
import { commandDraftKey, type CommandDraftTarget } from "./drafts"
import { COMMAND_MESSAGE_LIMIT } from "./types"

const target: CommandDraftTarget = {
  kind: "message",
  recipient: { kind: "agent", handle: "reviewer", routeState: "active" },
}
const key = commandDraftKey(target)

describe("shared command draft store", () => {
  test("only one view can start the same draft", () => {
    const store = new CommandDraftStore()
    expect(store.write(target, "Review this.").isOk()).toBe(true)
    expect(store.start(key).isOk()).toBe(true)
    const again = store.start(key)
    expect(again.isErr()).toBe(true)
    if (again.isErr()) expect(again.error.kind).toBe("sending")
    expect(store.write(target, "Replacement").isErr()).toBe(true)
    expect(store.snapshot().get(key)?.body).toBe("Review this.")
  })

  test("missing and uncertain drafts have distinct blocked outcomes", () => {
    const store = new CommandDraftStore()
    const missing = store.start(key)
    if (missing.isErr()) expect(missing.error.kind).toBe("missing")
    else throw new Error("A missing draft must not start")
    expect(store.write(target, "Review this.").isOk()).toBe(true)
    store.settle(key, "uncertain")
    const uncertain = store.start(key)
    if (uncertain.isErr()) expect(uncertain.error.kind).toBe("uncertain")
    else throw new Error("An unconfirmed send must not start")
    store.settle(key, "editable")
    expect(store.start(key).isOk()).toBe(true)
  })

  test("limits preserve the previous snapshot", () => {
    const store = new CommandDraftStore()
    const before = store.snapshot()
    const result = store.write(target, "x".repeat(COMMAND_MESSAGE_LIMIT + 1))
    if (result.isErr()) expect(result.error.kind).toBe("limit")
    else throw new Error("An oversized draft must be rejected")
    expect(store.snapshot()).toBe(before)
  })

  test("completion notifies views and clears only the sent draft", () => {
    const store = new CommandDraftStore()
    let changes = 0
    const unsubscribe = store.subscribe(() => {
      changes += 1
    })
    expect(store.write(target, "Review this.").isOk()).toBe(true)
    store.complete(key)
    expect(store.snapshot().has(key)).toBe(false)
    expect(changes).toBe(2)
    unsubscribe()
    store.complete(key)
    expect(changes).toBe(2)
  })
})
