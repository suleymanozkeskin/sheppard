import { createContext, use, useMemo, useState, type KeyboardEvent, type ReactNode, type FormEventHandler } from "react"

import { commandFocus, commandKeyIntent } from "@/commands/navigation-keys"
import { COMMAND_FORM_FIELD_LIMIT, moveFormField, type FieldDirection, type FormCell } from "@/commands/form-navigation"

type FieldName = "workspace" | "role" | "harness" | "launcher" | "model" | "effort" | "handle" | "goal" | "submit" | "use-workspace" | "keep-workspace" | "check-workspace" | "retry-start"
type EditState = Readonly<{ kind: "browsing" }> | Readonly<{ kind: "editing"; field: FieldName }>
type FormContext = Readonly<{ state: EditState; edit: (field: FieldName) => void; browse: () => void }>
const Context = createContext<FormContext | null>(null)
const FIELD_SELECTOR = "[data-command-form-field]"
const CONTROL_SELECTOR = "input:not([type=hidden]), textarea, button, a[href]"
const FORM_HELP_ID = "command-form-help"

/** Owns field-navigation mode. It does not submit except through the supplied form handler. */
export function CommandForm({ children, onSubmit }: { children: ReactNode; onSubmit: FormEventHandler<HTMLFormElement> }) {
  const [state, setState] = useState<EditState>({ kind: "browsing" })
  const context = useMemo<FormContext>(() => ({
    state,
    edit: (field) => setState((current) => current.kind === "editing" && current.field === field ? current : { kind: "editing", field }),
    browse: () => setState((current) => current.kind === "browsing" ? current : { kind: "browsing" }),
  }), [state])
  return (
    <Context value={context}>
      <form className="command-spawn" aria-label="Spawn agent setup" aria-describedby={FORM_HELP_ID}
        data-command-form-mode={state.kind}
        onSubmit={onSubmit}
        onKeyDownCapture={(event) => handleFormKey(event, context)}
        onInputCapture={(event) => editTextField(event.target, context)}
        onPointerDownCapture={(event) => editTextField(event.target, context)}
        onCompositionStartCapture={(event) => editTextField(event.target, context)}
        onFocusCapture={(event) => {
          const field = event.target.closest<HTMLElement>(FIELD_SELECTOR)
          if (state.kind === "editing" && (field === null || fieldName(field) !== state.field)) context.browse()
        }}
      >
        {children}
      </form>
    </Context>
  )
}

/** Marks one field or action as a navigation target. Disabled controls are skipped. */
export function CommandFormField({ name, children, className = "" }: { name: FieldName; children: ReactNode; className?: string }) {
  const context = use(Context)
  if (context === null) throw new Error("CommandFormField requires CommandForm")
  const id = `command-form-${name}`
  const editing = context.state.kind === "editing" && context.state.field === name
  return <div id={id} className={className} data-command-form-field={name} data-command-field-mode={editing ? "editing" : "browsing"}>{children}</div>
}

/** Shows the active field's keys without changing focus or form values. */
export function CommandFormHelp() {
  return (
    <div className="command-form-help" id={FORM_HELP_ID}>
      <span className="command-form-browse-help"><kbd>↑ ↓</kbd> Fields <span className="command-form-columns"><kbd>← →</kbd> Columns</span> <kbd>↵</kbd> Edit <kbd>Esc</kbd> Back</span>
      <span className="command-form-edit-help">Editing text <kbd>Esc</kbd> Done</span>
      <span className="command-form-picker-help"><kbd>↑ ↓</kbd> Options <kbd>↵</kbd> Select <kbd>Esc</kbd> Fields</span>
      <span className="command-form-action-help"><kbd>↑ ↓</kbd> Fields <kbd>↵</kbd> Run <kbd>Esc</kbd> Back</span>
    </div>
  )
}

/** Text input, pointer input and IME enter editing. Picker state belongs to the picker. */
function editTextField(target: EventTarget | null, context: FormContext): void {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || target.hasAttribute("data-combobox-input")) return
  const field = target.closest<HTMLElement>(FIELD_SELECTOR)
  if (field !== null) context.edit(fieldName(field))
}

/** Reads the closed field catalog at the DOM boundary. A different marker is a component defect. */
function fieldName(field: HTMLElement): FieldName {
  const name = field.dataset.commandFormField
  switch (name) {
    case "workspace": case "role": case "harness": case "launcher": case "model": case "effort":
    case "handle": case "goal": case "submit": case "use-workspace": case "keep-workspace":
    case "check-workspace": case "retry-start": return name
    default: throw new Error(`Command form contains an invalid field marker: ${name}`)
  }
}

/** Handles field keys before a closed picker can consume arrows. Open pickers keep native keys. */
function handleFormKey(event: KeyboardEvent<HTMLFormElement>, context: FormContext): void {
  const intent = commandKeyIntent({ ...event, isComposing: event.nativeEvent.isComposing || event.keyCode === 229 }, commandFocus(event.target), true)
  switch (intent) {
    case "field-up": case "field-down": case "field-left": case "field-right":
      moveFormFocus(event.currentTarget, event.target, intent)
      break
    case "edit-field":
      if (event.target instanceof HTMLElement && event.target.hasAttribute("data-combobox-input")) return
      editTextField(event.target, context)
      break
    case "finish-field":
      context.browse()
      break
    default: return
  }
  event.preventDefault()
  event.stopPropagation()
}

/** Reads at most 24 declared fields, then moves focus. Hidden and disabled controls are excluded. */
function moveFormFocus(form: HTMLFormElement, target: EventTarget | null, direction: FieldDirection): void {
  if (!(target instanceof HTMLElement)) return
  const fields = form.querySelectorAll<HTMLElement>(FIELD_SELECTOR)
  if (fields.length > COMMAND_FORM_FIELD_LIMIT) throw new Error("Command form has more fields than its navigation limit")
  const controls = Array.from(fields, (field) => field.querySelector<HTMLElement>(CONTROL_SELECTOR))
    .filter((control): control is HTMLElement => control !== null && !control.matches(":disabled, [aria-disabled=true]") && control.getClientRects().length > 0)
  const current = controls.indexOf(target)
  if (current < 0) return
  const result = moveFormField(formCells(controls), current, direction)
  if (result.kind === "edge") return
  const next = controls[result.index]
  if (next === undefined) throw new Error("Command form navigation returned an invalid field index")
  next.focus({ preventScroll: true })
  next.closest(FIELD_SELECTOR)?.scrollIntoView({ block: "nearest", inline: "nearest" })
}

/** Keeps the fixed submit footer after the scrollable fields in navigation order. */
function formCells(controls: readonly HTMLElement[]): readonly FormCell[] {
  const cells = controls.map((control) => control.getBoundingClientRect())
  const footerTop = Math.max(...cells.map((cell) => cell.bottom))
  return cells.map((cell, index) => controls[index].closest('[data-command-form-field="submit"]') === null
    ? cell
    : { left: cell.left, right: cell.right, top: footerTop, bottom: footerTop + cell.height })
}
