import { describe, expect, test } from "bun:test"
import { CANONICAL_BUN_VERSION, bunVersionMismatch } from "./bun-version"

describe("Bun version preflight", () => {
  test("accepts the canonical version", () => {
    expect(bunVersionMismatch(CANONICAL_BUN_VERSION)).toBeNull()
  })

  test("reports both versions for a mismatch", () => {
    const mismatch = bunVersionMismatch("1.4.0")

    expect(mismatch).toContain(CANONICAL_BUN_VERSION)
    expect(mismatch).toContain("1.4.0")
  })
})
