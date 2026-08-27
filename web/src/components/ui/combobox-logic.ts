import type { ComboboxOption } from "./combobox"

function optionSearchText(option: ComboboxOption): string {
  return [option.label, option.sublabel, ...(option.keywords ?? [])].filter((entry): entry is string => entry !== undefined).join(" ").toLocaleLowerCase()
}

export function filterComboboxOptions(options: readonly ComboboxOption[], query: string, maxVisibleOptions?: number): ComboboxOption[] {
  const needle = query.trim().toLocaleLowerCase()
  const matching = needle.length === 0 ? [...options] : options.filter((option) => optionSearchText(option).includes(needle))
  return maxVisibleOptions === undefined ? matching : matching.slice(0, maxVisibleOptions)
}

export function shouldKeepComboboxSelection(required: boolean, showAllOption: boolean): boolean {
  return required || !showAllOption
}

export function shouldStopComboboxEscape(open: boolean): boolean {
  return open
}
