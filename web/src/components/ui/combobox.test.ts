import { describe, expect, it } from "bun:test"

import type { ComboboxOption } from "./combobox"
import { filterComboboxOptions } from "./combobox-logic"

const options: ComboboxOption[] = [
  { keywords: ["alpha-keyword"], label: "Alpha", sublabel: "First item", value: "alpha-1" },
  { keywords: ["beta"], label: "Shared", sublabel: "Second item", value: "shared-2" },
  { disabled: true, keywords: ["gamma"], label: "Shared", sublabel: "Third item", value: "shared-3" },
]

describe("Combobox option contract", () => {
  it("filters labels, sublabels, and keywords", () => {
    expect(filterComboboxOptions(options, "alpha").map((option) => option.value)).toEqual(["alpha-1"])
    expect(filterComboboxOptions(options, "second").map((option) => option.value)).toEqual(["shared-2"])
    expect(filterComboboxOptions(options, "alpha-keyword").map((option) => option.value)).toEqual(["alpha-1"])
  })

  it("preserves disabled options for the mounted component to disable", () => {
    expect(filterComboboxOptions(options, "third")[0]?.disabled).toBe(true)
  })

  it("keeps duplicate labels addressable by stable values", () => {
    expect(filterComboboxOptions(options, "shared").map((option) => option.value)).toEqual(["shared-2", "shared-3"])
  })

  it("caps results after filtering", () => {
    expect(filterComboboxOptions(options, "shared", 1).map((option) => option.value)).toEqual(["shared-2"])
  })
})
