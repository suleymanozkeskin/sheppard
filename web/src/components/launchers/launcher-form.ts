import type {
  CreateLauncherRequest,
  Launcher,
  UpdateLauncherRequest,
} from "@/api/types"
import { accountProfileEnvironment, accountProfileFromSavedKeys, accountProfileKeys, type AccountProfileDraft } from "@/components/launchers/account-profile"

/** The harness family that the installed Herdr supports. */
export const SUPPORTED_HARNESS_KINDS = ["claude", "codex", "pi", "opencode"] as const

export const DEFAULT_START_TIMEOUT_MS = 35_000

export type SavedEnvironmentAction = "keep" | "replace" | "remove"

export interface ArgumentRow {
  id: string
  value: string
}

export interface EnvironmentRow {
  id: string
  kind: "new" | "saved"
  key: string
  value: string
  action: SavedEnvironmentAction | "new"
  revealed: boolean
}

export interface LauncherFormDraft {
  accountProfile: AccountProfileDraft
  name: string
  harness: string
  executable: string
  argumentRows: ArgumentRow[]
  environmentRows: EnvironmentRow[]
  startTimeoutMs: string
}

let rowSequence = 0

function rowId(prefix: string): string {
  rowSequence += 1
  return `${prefix}-${rowSequence}`
}

export function newArgumentRow(value = ""): ArgumentRow {
  return { id: rowId("argument"), value }
}

export function newEnvironmentRow(): EnvironmentRow {
  return { action: "new", id: rowId("environment"), key: "", kind: "new", revealed: false, value: "" }
}

export function savedEnvironmentRow(key: string): EnvironmentRow {
  return { action: "keep", id: `saved-${key}`, key, kind: "saved", revealed: false, value: "" }
}

/** Argument rows represent argv after the separately editable executable. */
export function argumentRowsFromArgv(argv: readonly string[]): ArgumentRow[] {
  return argv.slice(1).map((value) => newArgumentRow(value))
}

export function argvFromArgumentRows(executable: string, rows: readonly ArgumentRow[]): string[] {
  return [executable.trim(), ...rows.map((row) => row.value)]
}

export function environmentRowsFromKeys(keys: readonly string[]): EnvironmentRow[] {
  return [...new Set(keys)].map(savedEnvironmentRow)
}

export function launcherDraftFromLauncher(launcher: Launcher): LauncherFormDraft {
  const profile = accountProfileFromSavedKeys(launcher.agentKind, launcher.envKeys)
  const profileKeys = profile.saved ? new Set(accountProfileKeys(launcher.agentKind)) : new Set<string>()
  return {
    accountProfile: profile,
    argumentRows: argumentRowsFromArgv(launcher.argv),
    environmentRows: environmentRowsFromKeys(launcher.envKeys).filter((row) => !profileKeys.has(row.key)),
    executable: launcher.argv[0] ?? launcher.agentKind,
    harness: launcher.agentKind,
    name: launcher.name,
    startTimeoutMs: String(launcher.startTimeoutMs),
  }
}

export function initialLauncherForm(): LauncherFormDraft {
  return {
    accountProfile: { folder: "", partialKeys: [], saved: false, selection: "default" },
    argumentRows: [],
    environmentRows: [],
    executable: "",
    harness: "",
    name: "",
    startTimeoutMs: String(DEFAULT_START_TIMEOUT_MS),
  }
}

export function preserveAccountProfileRowsOnHarnessChange(previousHarness: string, profile: AccountProfileDraft, rows: readonly EnvironmentRow[]): EnvironmentRow[] {
  if (!profile.saved) return [...rows]
  const existing = new Set(rows.map((row) => row.key))
  const removedProfileRows = accountProfileKeys(previousHarness)
    .filter((key) => !existing.has(key))
    .map((key) => ({ ...savedEnvironmentRow(key), action: "remove" as const }))
  return [...rows, ...removedProfileRows]
}

export function harnessOptions(launchers: readonly Launcher[], availableHarnesses: readonly string[] = []): string[] {
  const kinds = new Set([...SUPPORTED_HARNESS_KINDS, ...availableHarnesses, ...launchers.map((launcher) => launcher.agentKind)])
  return [...kinds].toSorted((left, right) => {
    const leftIndex = supportedHarnessIndex(left)
    const rightIndex = supportedHarnessIndex(right)
    if (leftIndex >= 0 && rightIndex >= 0) return leftIndex - rightIndex
    if (leftIndex >= 0) return -1
    if (rightIndex >= 0) return 1
    return left.localeCompare(right)
  }).filter((kind) => kind.length > 0)
}

function supportedHarnessIndex(harness: string): number {
  switch (harness) {
    case "claude":
      return 0
    case "codex":
      return 1
    case "pi":
      return 2
    case "opencode":
      return 3
    default:
      return -1
  }
}

export function harnessLabel(harness: string): string {
  switch (harness) {
    case "claude":
      return "Claude"
    case "codex":
      return "Codex"
    case "opencode":
      return "OpenCode"
    case "pi":
      return "Pi"
    default:
      return harness.length === 0 ? "Unknown harness" : `${harness.slice(0, 1).toLocaleUpperCase()}${harness.slice(1)}`
  }
}

export function argumentSummary(argv: readonly string[]): string {
  const argumentsOnly = argv.slice(1)
  return argumentsOnly.length === 0 ? "No extra arguments" : JSON.stringify(argumentsOnly)
}

export function parseStartTimeout(value: string): number | undefined {
  const normalized = value.trim()
  if (normalized.length === 0) return undefined
  const parsed = Number(normalized)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 300_000 ? parsed : undefined
}

export function launcherEnvironmentPatchFromRows(rows: readonly EnvironmentRow[], blockedKeys: ReadonlySet<string> = new Set()): { set: Record<string, string>; remove: string[] } | undefined {
  const set = new Map<string, string>()
  const remove: string[] = []
  for (const row of rows) {
    const key = row.key.trim()
    if (key.length === 0) continue
    if (blockedKeys.has(key)) continue
    if (row.kind === "saved" && row.action === "keep") continue
    if (row.kind === "saved" && row.action === "remove") {
      set.delete(key)
      if (!remove.includes(key)) remove.push(key)
      continue
    }
    remove.splice(remove.indexOf(key), remove.includes(key) ? 1 : 0)
    set.set(key, row.value)
  }
  return set.size === 0 && remove.length === 0 ? undefined : { remove, set: Object.fromEntries(set) }
}

function environmentValuesForCreate(rows: readonly EnvironmentRow[], blockedKeys: ReadonlySet<string>, profileValues: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(profileValues))
  for (const row of rows) {
    const key = row.key.trim()
    if (key.length > 0 && !blockedKeys.has(key)) values.set(key, row.value)
  }
  return Object.fromEntries(values)
}

function mergeAccountProfilePatch(
  form: LauncherFormDraft,
  profileKeys: readonly string[],
  profileValues: Readonly<Record<string, string>>,
  manualPatch: { set: Record<string, string>; remove: string[] } | undefined,
): { set: Record<string, string>; remove: string[] } | undefined {
  const set = new Map(Object.entries(manualPatch?.set ?? {}))
  const remove = [...(manualPatch?.remove ?? [])]
  switch (form.accountProfile.selection) {
    case "keep-saved":
      break
    case "default":
      if (form.accountProfile.saved) {
        for (const key of profileKeys) {
          set.delete(key)
          if (!remove.includes(key)) remove.push(key)
        }
      }
      break
    case "separate":
      for (const key of profileKeys) {
        if (profileValues[key] !== undefined) {
          set.set(key, profileValues[key])
          remove.splice(remove.indexOf(key), remove.includes(key) ? 1 : 0)
        } else if (!remove.includes(key)) {
          remove.push(key)
        }
      }
      break
  }
  return set.size === 0 && remove.length === 0 ? undefined : { remove, set: Object.fromEntries(set) }
}

export function createLauncherRequestFromForm(form: LauncherFormDraft): CreateLauncherRequest {
  const profileEnv = form.accountProfile.selection === "separate" ? accountProfileEnvironment(form.harness, form.accountProfile.folder) : {}
  const env = environmentValuesForCreate(form.environmentRows, new Set(Object.keys(profileEnv)), profileEnv)
  const startTimeoutMs = parseStartTimeout(form.startTimeoutMs)
  const request: CreateLauncherRequest = {
    agentKind: form.harness.trim(),
    argv: argvFromArgumentRows(effectiveExecutable(form), form.argumentRows),
    name: form.name.trim(),
  }
  if (Object.keys(env).length > 0) request.env = env
  if (startTimeoutMs !== undefined) request.startTimeoutMs = startTimeoutMs
  return request
}

export function updateLauncherRequestFromForm(form: LauncherFormDraft): UpdateLauncherRequest {
  const profileKeys = accountProfileKeys(form.harness)
  const profileEnv = form.accountProfile.selection === "separate" ? accountProfileEnvironment(form.harness, form.accountProfile.folder) : {}
  const manualPatch = launcherEnvironmentPatchFromRows(form.environmentRows, new Set(Object.keys(profileEnv)))
  const envPatch = mergeAccountProfilePatch(form, profileKeys, profileEnv, manualPatch)
  const startTimeoutMs = parseStartTimeout(form.startTimeoutMs)
  const request: UpdateLauncherRequest = {
    agentKind: form.harness.trim(),
    argv: argvFromArgumentRows(effectiveExecutable(form), form.argumentRows),
  }
  if (envPatch !== undefined) request.envPatch = envPatch
  if (startTimeoutMs !== undefined) request.startTimeoutMs = startTimeoutMs
  return request
}

function effectiveExecutable(form: LauncherFormDraft): string {
  return form.executable.trim().length === 0 ? form.harness.trim() : form.executable.trim()
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

function executableValidationError(value: string): string | undefined {
  const executable = value.trim()
  if (executable.length === 0) return undefined
  if (hasControlCharacter(value)) return "Executable cannot contain control characters."
  if (/\s/u.test(executable) && !executable.startsWith("/")) return "Enter one executable name or absolute path. Put arguments in separate rows."
  if (executable.includes("/") && !executable.startsWith("/")) return "Executable must be a name or an absolute path."
  return undefined
}

export function launcherFormError(form: LauncherFormDraft, mode: "create" | "edit"): string | undefined {
  if (mode === "create" && form.name.trim().length === 0) return "Enter an alias name."
  if (form.harness.trim().length === 0) return "Choose a harness."
  if (hasControlCharacter(form.harness)) return "Harness cannot contain control characters."
  if (form.accountProfile.selection === "separate" && form.accountProfile.folder.trim().length === 0) return "Enter an account folder or choose the default account."
  if (mode === "edit" && form.executable.trim().length === 0) return "Enter an executable."
  const executableError = executableValidationError(form.executable)
  if (executableError !== undefined) return executableError
  if (form.argumentRows.some((row) => row.value.length === 0)) return "Remove empty launch argument rows."
  if (form.argumentRows.some((row) => hasControlCharacter(row.value))) return "Launch arguments cannot contain control characters."
  const keys = new Set<string>()
  for (const row of form.environmentRows) {
    const key = row.key.trim()
    if (key.length === 0) return "Enter an environment key or remove the empty row."
    if (hasControlCharacter(key)) return "Environment keys cannot contain control characters."
    if (keys.has(key)) return `Environment key ${key} is repeated.`
    if (form.accountProfile.selection === "separate" && accountProfileKeys(form.harness).includes(key)) return `${key} is managed by the account profile. Choose another key.`
    keys.add(key)
  }
  if (form.startTimeoutMs.trim().length > 0 && parseStartTimeout(form.startTimeoutMs) === undefined) {
    return "Startup timeout must be an integer from 1 to 300000 milliseconds."
  }
  return undefined
}
