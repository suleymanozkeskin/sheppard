import { expect, test } from "bun:test"
import type { SessionTurn } from "@/api/types"
import { sessionRows } from "./session-rows"

const turn: SessionTurn = {
  kind: "tool",
  role: "assistant",
  text: "Check passed",
  at: null,
  tool: { name: "test", outcome: "ok" },
  sidechain: false,
}

test("session view keys stay unique for identical turns", () => {
  const rows = sessionRows([turn, turn])
  expect(new Set(rows.map((row) => row.key)).size).toBe(2)
})

test("prepending older turns preserves existing disclosure keys", () => {
  const before = sessionRows([turn, turn])
  const after = sessionRows([turn, turn, turn])
  expect(after.slice(1).map((row) => row.key)).toEqual(before.map((row) => row.key))
})

test("changed tool contents cannot inherit a previous disclosure", () => {
  expect(sessionRows([turn])[0]?.key).not.toBe(sessionRows([{ ...turn, text: "Check failed" }])[0]?.key)
  expect(sessionRows([])).toEqual([])
})
