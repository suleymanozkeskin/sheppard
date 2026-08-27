import { Result, TaggedError } from "better-result"
import * as v from "valibot"

const NO_ALIASES: readonly string[] = []
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"])

/** Stored value for an action that is deliberately reachable from a menu only. */
export const DELIBERATE_UNBOUND = "__deliberately_unbound__"

export const ACTION_REGISTRY = [
  { id: "sidebar.toggle", label: "Show or hide sidebar", defaultCombo: "Meta+B", aliases: ["Ctrl+B"] },
  { id: "page.workspaces", label: "Open workspaces page", defaultCombo: "Alt+1", aliases: NO_ALIASES },
  { id: "page.channels", label: "Open channels page", defaultCombo: "Alt+2", aliases: NO_ALIASES },
  { id: "page.direct", label: "Open direct page", defaultCombo: "Alt+3", aliases: NO_ALIASES },
  { id: "page.agents", label: "Open agents page", defaultCombo: "Alt+4", aliases: NO_ALIASES },
  { id: "channel.next", label: "Next channel", defaultCombo: "]", aliases: NO_ALIASES },
  { id: "channel.prev", label: "Previous channel", defaultCombo: "[", aliases: NO_ALIASES },
  { id: "channel.picker", label: "Channel quick-switcher", defaultCombo: "Ctrl+K", aliases: NO_ALIASES },
  { id: "channel.members", label: "Show channel members", defaultCombo: "m", aliases: NO_ALIASES },
  { id: "menu.open", label: "Open focused row menu", defaultCombo: ".", aliases: NO_ALIASES },
  { id: "channel.create", label: "Create channel", defaultCombo: "n", aliases: NO_ALIASES },
  { id: "workspace.create", label: "Create workspace", defaultCombo: "Shift+N", aliases: NO_ALIASES },
  { id: "workspace.close", label: "Close workspace", defaultCombo: DELIBERATE_UNBOUND, aliases: NO_ALIASES },
  { id: "workspace.broadcast", label: "Broadcast to workspace", defaultCombo: "Shift+B", aliases: NO_ALIASES },
  { id: "agent.spawn", label: "Spawn agent", defaultCombo: "a", aliases: NO_ALIASES },
  { id: "agent.addReporter", label: "Add reporter", defaultCombo: DELIBERATE_UNBOUND, aliases: NO_ALIASES },
  { id: "agent.stop", label: "Stop agent", defaultCombo: DELIBERATE_UNBOUND, aliases: NO_ALIASES },
  { id: "pane.close", label: "Close pane", defaultCombo: DELIBERATE_UNBOUND, aliases: NO_ALIASES },
  { id: "search.focus", label: "Focus search", defaultCombo: "/", aliases: NO_ALIASES },
  { id: "search.scopeToggle", label: "Toggle search scope", defaultCombo: "s", aliases: NO_ALIASES },
  { id: "composer.focus", label: "Focus composer", defaultCombo: "c", aliases: NO_ALIASES },
  { id: "composer.attach", label: "Attach a file path", defaultCombo: "Ctrl+Shift+A", aliases: NO_ALIASES },
  { id: "composer.send", label: "Send composer", defaultCombo: "Enter", aliases: NO_ALIASES },
  { id: "composer.newline", label: "Insert composer newline", defaultCombo: "Shift+Enter", aliases: NO_ALIASES },
  { id: "message.focusNext", label: "Focus next message", defaultCombo: "j", aliases: ["ArrowDown"] },
  { id: "message.focusPrev", label: "Focus previous message", defaultCombo: "k", aliases: ["ArrowUp"] },
  { id: "message.dmAuthor", label: "Message focused author", defaultCombo: "d", aliases: NO_ALIASES },
  { id: "message.jumpUnread", label: "Jump to unread", defaultCombo: "u", aliases: NO_ALIASES },
  { id: "message.jumpLatest", label: "Jump to latest", defaultCombo: "Shift+G", aliases: NO_ALIASES },
  { id: "attachment.view", label: "View focused attachment", defaultCombo: "v", aliases: NO_ALIASES },
  { id: "attachment.copyPath", label: "Copy focused attachment path", defaultCombo: "y", aliases: NO_ALIASES },
  { id: "overlay.close", label: "Close overlay or blur", defaultCombo: "Escape", aliases: NO_ALIASES },
  { id: "help.show", label: "Show keyboard help", defaultCombo: "?", aliases: NO_ALIASES },
  { id: "settings.open", label: "Open workspace settings", defaultCombo: "Ctrl+,", aliases: NO_ALIASES },
  { id: "theme.cycle", label: "Cycle theme mode", defaultCombo: "Ctrl+Shift+T", aliases: NO_ALIASES },
  { id: "inbox.open", label: "Open inbox", defaultCombo: "b", aliases: NO_ALIASES },
] as const

export type ActionName = (typeof ACTION_REGISTRY)[number]["id"]

export interface KeyboardBinding {
  action: string
  combo: string
}

export interface StoredKeyboardConfig {
  version: 1
  bindings: KeyboardBinding[]
}

export interface LoadedKeyboardBindings {
  bindings: KeyboardBindings
  droppedActions: string[]
}

export type KeyboardBindings = Map<ActionName, string>

type ModalKeyboardLayerScope = "dialog" | "help" | "inbox" | "members" | "menu" | "picker" | "settings"

export type KeyboardLayer =
  | { mode: "modal"; scope: ModalKeyboardLayerScope }
  | { mode: "inline"; scope: "search" | "viewer" | "attachments" }

export type ModalKeyboardLayerName = Extract<KeyboardLayer, { mode: "modal" }>["scope"]

export type KeyboardLayerHandler = (event: KeyEventLike) => boolean

interface KeyboardLayerEntry {
  close: () => void
  handler: KeyboardLayerHandler
  scope: KeyboardLayer
}

export class KeyboardLayerStack {
  private readonly layers: KeyboardLayerEntry[] = []

  public push(scope: KeyboardLayer, handler: KeyboardLayerHandler, close: () => void = () => undefined): () => void {
    const entry = { close, handler, scope }
    this.layers.push(entry)
    return () => {
      const index = this.layers.indexOf(entry)
      if (index >= 0) this.layers.splice(index, 1)
    }
  }

  public top(): KeyboardLayer | undefined {
    return this.layers.at(-1)?.scope
  }

  public hasLayers(): boolean {
    return this.layers.length > 0
  }

  public dispatch(event: KeyEventLike): boolean {
    const entry = this.layers.at(-1)
    return entry?.handler(event) ?? false
  }

  public closeTop(): boolean {
    const entry = this.layers.at(-1)
    if (entry === undefined) return false
    entry.close()
    return true
  }

  public isPageBlocked(): boolean {
    return this.layers.at(-1)?.scope.mode === "modal"
  }
}

export const keyboardLayerStack = new KeyboardLayerStack()

export const KEYBOARD_STORAGE_KEY = "msgr.keyboard.v1"

const keyboardConfigSchema = v.object({
  version: v.literal(1),
  bindings: v.array(
    v.object({
      action: v.string(),
      combo: v.string(),
    }),
  ),
})

export class KeyboardStorageError extends TaggedError("KeyboardStorageError")<{
  message: string
  cause: unknown
}> {}

export interface KeyEventLike {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

export function defaultBindings(): KeyboardBindings {
  const bindings = new Map<ActionName, string>()
  for (const action of ACTION_REGISTRY) bindings.set(action.id, action.defaultCombo)
  return bindings
}

export function comboFromKeyEvent(event: KeyEventLike): string {
  const key = normalizeKey(event.key, event)
  if (key === "?" && event.shiftKey) return "?"

  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push("Ctrl")
  if (event.metaKey) modifiers.push("Meta")
  if (event.altKey) modifiers.push("Alt")
  if (event.shiftKey) modifiers.push("Shift")
  return [...modifiers, key].join("+")
}

export function actionForCombo(bindings: KeyboardBindings, combo: string): ActionName | undefined {
  for (const action of ACTION_REGISTRY) {
    if (bindings.get(action.id) === combo || aliasesForAction(action).includes(combo)) return action.id
  }
  return undefined
}

function aliasesForAction(action: (typeof ACTION_REGISTRY)[number]): readonly string[] {
  return action.aliases
}

export function formatCombo(combo: string): string {
  return combo
    .replaceAll("Escape", "Esc")
    .replaceAll("Shift+G", "G")
}

export function displayBinding(bindings: KeyboardBindings, action: ActionName): string {
  const definition = ACTION_REGISTRY.find((candidate) => candidate.id === action)
  const combo = bindings.get(action)
  const primary = combo === DELIBERATE_UNBOUND ? "—" : formatCombo(combo ?? "Unbound")
  if (definition?.aliases === undefined || definition.aliases.length === 0) return primary
  return [primary, ...definition.aliases.map(formatCombo)].join(" / ")
}

export function bindingTitle(bindings: KeyboardBindings, action: ActionName): string | undefined {
  return bindings.get(action) === DELIBERATE_UNBOUND
    ? "Reachable from the context menu only"
    : undefined
}

export function isModifierCombo(event: KeyEventLike): boolean {
  return event.ctrlKey || event.metaKey || event.altKey
}

export function isModifierOnlyKey(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

export function shouldDispatchWhileTyping(
  action: ActionName,
  event: KeyEventLike,
  typing: boolean,
  composer: boolean,
): boolean {
  if (!typing) return true
  if (action === "overlay.close") return true
  if (composer && action === "composer.send" && !event.shiftKey) return true
  if (composer && action === "composer.newline" && event.shiftKey) return true
  return isModifierCombo(event)
}

export function bindingConflicts(bindings: KeyboardBindings): Set<string> {
  const counts = new Map<string, number>()
  for (const action of ACTION_REGISTRY) {
    const combo = bindings.get(action.id) ?? ""
    const combos = combo === DELIBERATE_UNBOUND ? aliasesForAction(action) : [combo, ...aliasesForAction(action)]
    for (const combo of combos) {
      if (combo.length === 0) continue
      counts.set(combo, (counts.get(combo) ?? 0) + 1)
    }
  }
  const conflicts = new Set<string>()
  for (const [combo, count] of counts) {
    if (count > 1) conflicts.add(combo)
  }
  return conflicts
}

export function replaceBinding(
  bindings: KeyboardBindings,
  action: ActionName,
  combo: string,
): KeyboardBindings {
  const next = new Map(bindings)
  next.set(action, combo)
  return next
}

export function serializeBindings(bindings: KeyboardBindings): string {
  const config: StoredKeyboardConfig = {
    version: 1,
    bindings: ACTION_REGISTRY.map((action) => ({
      action: action.id,
      combo: bindings.get(action.id) ?? "",
    })),
  }
  return JSON.stringify(config)
}

export function parseBindings(raw: string): Result<KeyboardBindings, KeyboardStorageError> {
  return parseBindingsWithMigration(raw).map(({ bindings }) => bindings)
}

export function parseBindingsWithMigration(raw: string): Result<LoadedKeyboardBindings, KeyboardStorageError> {
  const decoded = Result.try<unknown, KeyboardStorageError>({
    try: () => JSON.parse(raw),
    catch: (cause) => new KeyboardStorageError({ cause, message: "Keyboard bindings are not valid JSON" }),
  }).andThen((candidate) => {
    const parsed = v.safeParse(keyboardConfigSchema, candidate)
    return parsed.success
      ? Result.ok(parsed.output)
      : Result.err(
          new KeyboardStorageError({
            cause: parsed.issues,
            message: "Keyboard bindings do not match the local schema",
          }),
        )
  })

  return decoded.andThen((config) => {
    const bindings = defaultBindings()
    const droppedActions: string[] = []
    for (const stored of config.bindings) {
      const action = ACTION_REGISTRY.find((candidate) => candidate.id === stored.action)
      if (action === undefined) {
        droppedActions.push(stored.action)
        continue
      }
      bindings.set(action.id, stored.combo)
    }

    if (bindingConflicts(bindings).size > 0) {
      return Result.err(
        new KeyboardStorageError({ cause: config, message: "Keyboard bindings contain conflicts" }),
      )
    }
    return Result.ok({ bindings, droppedActions })
  })
}

export function loadBindingsWithMigration(): Result<LoadedKeyboardBindings, KeyboardStorageError> {
  const store = Result.try<Storage | null, KeyboardStorageError>({
    try: () => globalThis.localStorage ?? null,
    catch: (cause) => new KeyboardStorageError({ cause, message: "Browser storage is not available" }),
  })
  return store.andThen((storage) => {
    if (storage === null) return Result.ok({ bindings: defaultBindings(), droppedActions: [] })
    return Result.try<string | null, KeyboardStorageError>({
      try: () => storage.getItem(KEYBOARD_STORAGE_KEY),
      catch: (cause) => new KeyboardStorageError({ cause, message: "Keyboard bindings could not be read" }),
    }).andThen((raw) => {
      if (raw === null) return Result.ok({ bindings: defaultBindings(), droppedActions: [] })
      return parseBindingsWithMigration(raw).match({
        ok: (loaded) => {
          const serialized = serializeBindings(loaded.bindings)
          if (serialized === raw) return Result.ok(loaded)
          return Result.try<void, KeyboardStorageError>({
            try: () => storage.setItem(KEYBOARD_STORAGE_KEY, serialized),
            catch: (cause) => new KeyboardStorageError({ cause, message: "Keyboard bindings could not be migrated" }),
          }).map(() => loaded)
        },
        err: () => Result.ok({ bindings: defaultBindings(), droppedActions: [] }),
      })
    })
  })
}

export function saveBindings(bindings: KeyboardBindings): Result<void, KeyboardStorageError> {
  return Result.try<Storage | null, KeyboardStorageError>({
    try: () => globalThis.localStorage ?? null,
    catch: (cause) => new KeyboardStorageError({ cause, message: "Browser storage is not available" }),
  }).andThen((storage) => {
    if (storage === null) return Result.ok(undefined)
    return Result.try<void, KeyboardStorageError>({
      try: () => storage.setItem(KEYBOARD_STORAGE_KEY, serializeBindings(bindings)),
      catch: (cause) => new KeyboardStorageError({ cause, message: "Keyboard bindings could not be saved" }),
    })
  })
}

function normalizeKey(key: string, event: KeyEventLike): string {
  if (key === " ") return "Space"
  if (key === "Esc") return "Escape"
  if (key.length === 1 && (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return key.toUpperCase()
  return key
}
