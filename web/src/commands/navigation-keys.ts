/** Native fields keep caret, selection, modifier, and IME keys. Only search boundaries leave a level. */
export type CommandFocus =
  | Readonly<{ kind: "search"; empty: boolean; atEnd: boolean }>
  | Readonly<{ kind: "category" }>
  | Readonly<{ kind: "control" }>
  | Readonly<{ kind: "editor" }>

export interface CommandKey {
  readonly key: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly isComposing: boolean
}

export type CommandCategoryIntent = "next-category" | "previous-category" | "first-category" | "last-category"
export type CommandKeyIntent =
  "native" | "back" | "close" | "next" | "previous" | "choose" | "actions" | "type" | "results" | CommandCategoryIntent
export type CommandListIntent = Exclude<CommandKeyIntent, "native" | "back" | "close">
export type CommandListKeyboard = (intent: CommandListIntent, key: string) => boolean

export const COMMAND_BACK_HINT = "Esc"
export const COMMAND_LIST_BACK_HINT = "← / Esc"
export const COMMAND_CATEGORIES_HINT = "Tab"
export const COMMAND_CATEGORY_HELP =
  "Tab moves to categories. Left and Right change the category. Down or Enter returns to results. Up from the first result moves to categories."

/** Pure key policy for all menu levels. No I/O; unsupported keys retain native behavior. */
export function commandKeyIntent(key: CommandKey, focus: CommandFocus, nested: boolean): CommandKeyIntent {
  if (key.isComposing) return "native"
  if ((key.metaKey || key.ctrlKey) && !key.altKey && key.key.toLowerCase() === "k") return "close"
  if (key.altKey || key.ctrlKey || key.metaKey) return "native"
  if (key.key === "Escape") return "back"
  if (focus.kind === "editor" || key.shiftKey) return "native"
  if (focus.kind === "category") return categoryKeyIntent(key.key)
  switch (key.key) {
    case "ArrowLeft":
    case "Backspace":
      return nested && (focus.kind === "control" || focus.empty) ? "back" : "native"
    case "ArrowDown":
      return "next"
    case "ArrowUp":
      return "previous"
    case "Enter":
      return focus.kind === "search" ? "choose" : "native"
    case "ArrowRight":
      return focus.kind === "control" || focus.atEnd ? "actions" : "native"
    default:
      return focus.kind === "control" && key.key.length === 1 && key.key !== " " ? "type" : "native"
  }
}

/** Category arrows never enter actions or leave a menu level. Tab keeps native focus order. */
function categoryKeyIntent(key: string): CommandKeyIntent {
  switch (key) {
    case "ArrowRight":
      return "next-category"
    case "ArrowLeft":
      return "previous-category"
    case "Home":
      return "first-category"
    case "End":
      return "last-category"
    case "ArrowUp":
    case "ArrowDown":
    case "Enter":
      return "results"
    default:
      return key.length === 1 && key !== " " ? "type" : "native"
  }
}

/** Reads only the focused DOM field. It does not infer screen state from labels or text. */
export function commandFocus(target: EventTarget | null): CommandFocus {
  if (!(target instanceof HTMLElement)) return { kind: "control" }
  if (target.hasAttribute("data-command-category")) return { kind: "category" }
  if (target instanceof HTMLInputElement && target.hasAttribute("data-command-search"))
    return {
      kind: "search",
      empty: target.value.length === 0,
      atEnd: target.selectionStart === target.value.length && target.selectionEnd === target.value.length,
    }
  if (target.isContentEditable || target.matches("input, textarea, select, [role=combobox]")) return { kind: "editor" }
  return { kind: "control" }
}
