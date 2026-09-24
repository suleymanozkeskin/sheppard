/** Native fields keep caret, selection, modifier, and IME keys. Only search boundaries leave a level. */
export type CommandFocus =
  | Readonly<{ kind: "search"; empty: boolean; atEnd: boolean }>
  | Readonly<{ kind: "category" }>
  | Readonly<{ kind: "field" }>
  | Readonly<{ kind: "field-action" }>
  | Readonly<{ kind: "field-editor"; lines: "single" | "multiple" }>
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
export type CommandFieldIntent = "field-up" | "field-down" | "field-left" | "field-right" | "edit-field" | "finish-field"
export type CommandKeyIntent =
  "native" | "back" | "close" | "next" | "previous" | "choose" | "actions" | "type" | "results" | CommandCategoryIntent | CommandFieldIntent
export type CommandListIntent = Exclude<CommandKeyIntent, "native" | "back" | "close" | CommandFieldIntent>
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
  if (key.key === "Escape") return focus.kind === "field-editor" ? "finish-field" : "back"
  if (focus.kind === "field-editor" && focus.lines === "single" && key.key === "Enter") return "finish-field"
  if (focus.kind === "editor" || focus.kind === "field-editor" || key.shiftKey) return "native"
  if (focus.kind === "category") return categoryKeyIntent(key.key)
  if (focus.kind === "field" || focus.kind === "field-action") return fieldKeyIntent(key.key, focus.kind)
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

/** Closed fields use arrows to move. Enter edits a field but never submits it. */
function fieldKeyIntent(key: string, kind: "field" | "field-action"): CommandKeyIntent {
  switch (key) {
    case "ArrowUp": return "field-up"
    case "ArrowDown": return "field-down"
    case "ArrowLeft": return "field-left"
    case "ArrowRight": return "field-right"
    case "Enter": return kind === "field" ? "edit-field" : "native"
    default: return "native"
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
  const field = target.closest("[data-command-form-field]")
  if (field !== null) {
    if (target.matches("[aria-expanded=true]")) return { kind: "editor" }
    if (target.matches("button, a")) return { kind: "field-action" }
    return field.getAttribute("data-command-field-mode") === "editing"
      ? { kind: "field-editor", lines: target instanceof HTMLTextAreaElement ? "multiple" : "single" }
      : { kind: "field" }
  }
  if (target.isContentEditable || target.matches("input, textarea, select, [role=combobox]")) return { kind: "editor" }
  return { kind: "control" }
}
