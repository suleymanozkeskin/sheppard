import { describe, expect, test } from "bun:test"

import { loadEpochIsCurrent, nextLoadEpoch } from "./use-live-messages"

describe("channel load epochs", () => {
  test("a later load for the same channel retires the earlier load", () => {
    const epochs = new Map<string, number>()
    const first = nextLoadEpoch(epochs, "ops")
    const second = nextLoadEpoch(epochs, "ops")

    expect(first).toBe(1)
    expect(second).toBe(2)
    expect(loadEpochIsCurrent(epochs, "ops", first)).toBe(false)
    expect(loadEpochIsCurrent(epochs, "ops", second)).toBe(true)
  })

  test("loads for two channels stay current together", () => {
    const epochs = new Map<string, number>()
    const ops = nextLoadEpoch(epochs, "ops")
    const research = nextLoadEpoch(epochs, "research")

    expect(loadEpochIsCurrent(epochs, "ops", ops)).toBe(true)
    expect(loadEpochIsCurrent(epochs, "research", research)).toBe(true)
  })
})
