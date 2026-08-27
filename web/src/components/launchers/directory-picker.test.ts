import { describe, expect, it } from "bun:test"

import { directoryPickerSelectionPath } from "@/components/launchers/directory-picker-logic"

describe("launcher directory picker", () => {
  it("uses the absolute current directory returned by the directory API", () => {
    expect(directoryPickerSelectionPath({
      currentPath: "/Users/example/project",
      directories: [],
      parentPath: "/Users/example",
      truncated: false,
    })).toBe("/Users/example/project")
  })
})
