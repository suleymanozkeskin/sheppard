import { describe, expect, test } from "bun:test"

import { commandKeyIntent, type CommandFocus, type CommandKey } from "./navigation-keys"
import { parseCommandQuery } from "./search"
import { COMMAND_CATEGORIES, moveCommandCategory } from "./categories"

const SEARCH: CommandFocus = { kind: "search", empty: true, atEnd: true }
const EDITOR: CommandFocus = { kind: "editor" }
const CONTROL: CommandFocus = { kind: "control" }
const CATEGORY: CommandFocus = { kind: "category" }
const KEY: CommandKey = { key: "", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false }

describe("shared command keys", () => {
  test("action search treats message as a title, not a recipient command", () => {
    const result = parseCommandQuery("message", "all", "actions")
    expect(result.isOk()).toBe(true)
    if (result.isOk())
      expect(result.value).toEqual({ text: "message", filter: "all", intent: "open", tokens: ["message"] })
  })
  test.each([
    ["ArrowDown", "next"],
    ["ArrowUp", "previous"],
    ["Enter", "choose"],
    ["ArrowRight", "actions"],
    ["ArrowLeft", "back"],
    ["Backspace", "back"],
    ["Escape", "back"],
    ["Tab", "native"],
  ] as const)("%s has the same meaning in each child list", (key, expected) => {
    expect(commandKeyIntent({ ...KEY, key }, SEARCH, true)).toBe(expected)
  })

  test.each(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Backspace", "Enter"])(
    "%s keeps native form editing",
    (key) => {
      expect(commandKeyIntent({ ...KEY, key }, EDITOR, true)).toBe("native")
    },
  )

  test("root arrows do not dismiss the menu", () => {
    expect(commandKeyIntent({ ...KEY, key: "ArrowLeft" }, SEARCH, false)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "Backspace" }, SEARCH, false)).toBe("native")
  })

  test("search arrows keep text editing until the boundary", () => {
    const editing: CommandFocus = { kind: "search", empty: false, atEnd: false }
    expect(commandKeyIntent({ ...KEY, key: "ArrowLeft" }, editing, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "ArrowRight" }, editing, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "Backspace" }, editing, true)).toBe("native")
  })

  test("controls keep native activation and redirect printable text to search", () => {
    expect(commandKeyIntent({ ...KEY, key: "Enter" }, CONTROL, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: " " }, CONTROL, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "r" }, CONTROL, true)).toBe("type")
    expect(commandKeyIntent({ ...KEY, key: "ArrowDown" }, CONTROL, true)).toBe("next")
  })

  test("IME and modified arrows never trigger navigation", () => {
    expect(commandKeyIntent({ ...KEY, key: "Escape", isComposing: true }, SEARCH, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "ArrowRight", shiftKey: true }, SEARCH, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "ArrowLeft", altKey: true }, SEARCH, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "ArrowLeft", metaKey: true }, SEARCH, true)).toBe("native")
  })

  test("Escape leaves forms and the command shortcut closes from any field", () => {
    expect(commandKeyIntent({ ...KEY, key: "Escape" }, EDITOR, true)).toBe("back")
    expect(commandKeyIntent({ ...KEY, key: "k", metaKey: true }, EDITOR, true)).toBe("close")
    expect(commandKeyIntent({ ...KEY, key: "k", ctrlKey: true }, SEARCH, false)).toBe("close")
  })

  test.each([
    ["ArrowRight", "next-category"],
    ["ArrowLeft", "previous-category"],
    ["Home", "first-category"],
    ["End", "last-category"],
    ["ArrowUp", "results"],
    ["ArrowDown", "results"],
    ["Enter", "results"],
    ["Tab", "native"],
    [" ", "native"],
    ["Backspace", "native"],
    ["w", "type"],
    ["Escape", "back"],
  ] as const)("category %s maps to %s at root and child levels", (key, expected) => {
    expect(commandKeyIntent({ ...KEY, key }, CATEGORY, false)).toBe(expected)
    expect(commandKeyIntent({ ...KEY, key }, CATEGORY, true)).toBe(expected)
  })

  test("category modifiers and IME retain native behavior", () => {
    expect(commandKeyIntent({ ...KEY, key: "ArrowRight", shiftKey: true }, CATEGORY, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "ArrowRight", altKey: true }, CATEGORY, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "ArrowRight", ctrlKey: true }, CATEGORY, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "ArrowRight", metaKey: true }, CATEGORY, true)).toBe("native")
    expect(commandKeyIntent({ ...KEY, key: "Enter", isComposing: true }, CATEGORY, true)).toBe("native")
  })

  test("category movement visits every category and wraps in both directions", () => {
    for (const [index, category] of COMMAND_CATEGORIES.entries()) {
      const next = COMMAND_CATEGORIES[(index + 1) % COMMAND_CATEGORIES.length]
      expect(moveCommandCategory(category.value, "next-category")).toBe(next.value)
      expect(moveCommandCategory(next.value, "previous-category")).toBe(category.value)
      expect(moveCommandCategory(category.value, "first-category")).toBe("all")
      expect(moveCommandCategory(category.value, "last-category")).toBe("action")
    }
  })
})
