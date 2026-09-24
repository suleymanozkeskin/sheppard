import { expect, test } from "bun:test"
import { commandModifier } from "./keyboard"

test("shortcut labels follow the browser platform", () => {
  expect(commandModifier("MacIntel")).toBe("⌘")
  expect(commandModifier("iPad")).toBe("⌘")
  expect(commandModifier("Win32")).toBe("Ctrl")
  expect(commandModifier("Linux x86_64")).toBe("Ctrl")
  expect(commandModifier("")).toBe("Ctrl")
})
