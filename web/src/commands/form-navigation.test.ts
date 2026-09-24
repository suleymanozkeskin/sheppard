import { expect, test } from "bun:test"
import { moveFormField, type FormCell } from "./form-navigation"
import { commandKeyIntent, type CommandKey } from "./navigation-keys"

const KEY: CommandKey = { key: "", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false }
const GRID: readonly FormCell[] = [
  { left: 0, right: 100, top: 0, bottom: 40 },
  { left: 120, right: 220, top: 0, bottom: 40 },
  { left: 0, right: 100, top: 70, bottom: 110 },
  { left: 120, right: 220, top: 70, bottom: 110 },
  { left: 0, right: 220, top: 140, bottom: 220 },
]

test("field arrows follow rows and columns without wrapping", () => {
  expect(moveFormField(GRID, 0, "field-right")).toEqual({ kind: "move", index: 1 })
  expect(moveFormField(GRID, 1, "field-left")).toEqual({ kind: "move", index: 0 })
  expect(moveFormField(GRID, 1, "field-down")).toEqual({ kind: "move", index: 3 })
  expect(moveFormField(GRID, 3, "field-up")).toEqual({ kind: "move", index: 1 })
  expect(moveFormField(GRID, 3, "field-down")).toEqual({ kind: "move", index: 4 })
  expect(moveFormField(GRID, 0, "field-up")).toEqual({ kind: "edge" })
  expect(moveFormField(GRID, 1, "field-right")).toEqual({ kind: "edge" })
  expect(moveFormField(GRID, 4, "field-down")).toEqual({ kind: "edge" })
})

test("one-column fields and omitted disabled fields remain connected", () => {
  const column = [GRID[0], GRID[2], GRID[4]]
  expect(moveFormField(column, 0, "field-down")).toEqual({ kind: "move", index: 1 })
  expect(moveFormField(column, 0, "field-right")).toEqual({ kind: "edge" })
  expect(moveFormField([GRID[0], GRID[4]], 0, "field-down")).toEqual({ kind: "move", index: 1 })
})

test("invalid form layouts fail as programmer defects", () => {
  expect(() => moveFormField([], 0, "field-down")).toThrow("focus index")
  expect(() => moveFormField(Array.from({ length: 25 }, () => GRID[0]), 0, "field-down")).toThrow("field bound")
})

test.each([
  ["ArrowUp", "field-up"], ["ArrowDown", "field-down"], ["ArrowLeft", "field-left"],
  ["ArrowRight", "field-right"], ["Enter", "edit-field"], ["Escape", "back"], ["Tab", "native"],
] as const)("closed field %s maps to %s", (key, expected) => {
  expect(commandKeyIntent({ ...KEY, key }, { kind: "field" }, true)).toBe(expected)
})

test("editing preserves caret keys, selection, modifiers and IME", () => {
  expect(commandKeyIntent({ ...KEY, key: "ArrowLeft" }, { kind: "field-editor", lines: "single" }, true)).toBe("native")
  expect(commandKeyIntent({ ...KEY, key: "Enter" }, { kind: "field-editor", lines: "multiple" }, true)).toBe("native")
  expect(commandKeyIntent({ ...KEY, key: "Enter" }, { kind: "field-editor", lines: "single" }, true)).toBe("finish-field")
  expect(commandKeyIntent({ ...KEY, key: "Escape" }, { kind: "field-editor", lines: "single" }, true)).toBe("finish-field")
  expect(commandKeyIntent({ ...KEY, key: "ArrowLeft", shiftKey: true }, { kind: "field" }, true)).toBe("native")
  expect(commandKeyIntent({ ...KEY, key: "Escape", isComposing: true }, { kind: "field-editor", lines: "multiple" }, true)).toBe("native")
  expect(commandKeyIntent({ ...KEY, key: "k", metaKey: true }, { kind: "field-editor", lines: "multiple" }, true)).toBe("close")
  expect(commandKeyIntent({ ...KEY, key: "Enter" }, { kind: "field-action" }, true)).toBe("native")
})
