import { describe, expect, test } from "bun:test"

import { isThemeMode, nextThemeMode, resolveTheme } from "./theme"

describe("theme modes", () => {
  test("explicit modes ignore the system preference", () => {
    expect(resolveTheme("dark", false)).toBe("dark")
    expect(resolveTheme("light", true)).toBe("light")
  })

  test("system follows both operating-system states", () => {
    expect(resolveTheme("system", false)).toBe("light")
    expect(resolveTheme("system", true)).toBe("dark")
  })

  test("cycles through dark, light, and system", () => {
    expect(nextThemeMode("dark")).toBe("light")
    expect(nextThemeMode("light")).toBe("system")
    expect(nextThemeMode("system")).toBe("dark")
  })

  test("accepts only stored theme modes", () => {
    expect(isThemeMode("dark")).toBe(true)
    expect(isThemeMode("light")).toBe(true)
    expect(isThemeMode("system")).toBe(true)
    expect(isThemeMode("blue")).toBe(false)
  })
})
