import { describe, expect, test } from "bun:test"

import { commandKeyIntent, type CommandFocus, type CommandKey } from "./navigation-keys"
import { parseCommandQuery } from "./search"

const SEARCH: CommandFocus = { kind: "search", empty: true, atEnd: true }
const EDITOR: CommandFocus = { kind: "editor" }
const CONTROL: CommandFocus = { kind: "control" }
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
})
