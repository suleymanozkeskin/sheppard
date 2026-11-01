import { describe, expect, test } from "bun:test"

import { applyComposerSent, type ComposerStatus } from "./use-composer-state"

const idle: ComposerStatus = { status: "idle" }
const sending: ComposerStatus = { status: "sending" }

function composer(draft: string, paths: readonly string[], status: ComposerStatus) {
  return {
    attachmentInputOpen: false,
    attachmentPathInput: "",
    attachments: paths.map((path) => ({ path, status: "ready" as const })),
    draft,
    status,
  }
}

describe("composer after send", () => {
  test("the sent text and its attachments clear", () => {
    const next = applyComposerSent(
      composer("  hello  ", ["/tmp/sent.txt", "/tmp/kept.txt"], sending),
      "hello",
      ["/tmp/sent.txt"],
    )

    expect(next.draft).toBe("")
    expect(next.attachments.map((attachment) => attachment.path)).toEqual(["/tmp/kept.txt"])
    expect(next.status).toEqual(idle)
  })

  test("a draft typed during the send stays, and only the sent attachments leave", () => {
    const next = applyComposerSent(
      composer("second", ["/tmp/sent.txt", "/tmp/later.txt"], sending),
      "first",
      ["/tmp/sent.txt"],
    )

    expect(next.draft).toBe("second")
    expect(next.attachments.map((attachment) => attachment.path)).toEqual(["/tmp/later.txt"])
    expect(next.status).toEqual(sending)
  })
})
