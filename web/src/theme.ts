import { Result, TaggedError } from "better-result"
import * as v from "valibot"

export const THEME_STORAGE_KEY = "msgr.theme.v1"
export const DEFAULT_THEME_MODE = "dark" as const

const themeModeSchema = v.picklist(["dark", "light", "system"])
const storedThemeSchema = v.object({
  version: v.literal(1),
  mode: themeModeSchema,
})

export type ThemeMode = v.InferOutput<typeof themeModeSchema>
export type ResolvedTheme = Exclude<ThemeMode, "system">

export class ThemeStorageError extends TaggedError("ThemeStorageError")<{
  message: string
  cause: unknown
}> {}

function storage(): Result<Storage | null, ThemeStorageError> {
  return Result.try<Storage | null, ThemeStorageError>({
    try: () => globalThis.localStorage ?? null,
    catch: (cause) => new ThemeStorageError({ cause, message: "Browser storage is not available" }),
  })
}

export function loadThemeMode(): Result<ThemeMode, ThemeStorageError> {
  return storage().andThen((store) => {
    if (store === null) return Result.ok(DEFAULT_THEME_MODE)
    return Result.try<string | null, ThemeStorageError>({
      try: () => store.getItem(THEME_STORAGE_KEY),
      catch: (cause) => new ThemeStorageError({ cause, message: "The theme preference could not be read" }),
    }).andThen((raw) => {
      if (raw === null) return Result.ok(DEFAULT_THEME_MODE)
      return Result.try<unknown, ThemeStorageError>({
        try: () => JSON.parse(raw),
        catch: (cause) => new ThemeStorageError({ cause, message: "The theme preference is not valid JSON" }),
      }).andThen((candidate) => {
        const decoded = v.safeParse(storedThemeSchema, candidate)
        return decoded.success
          ? Result.ok(decoded.output.mode)
          : Result.err(new ThemeStorageError({ cause: decoded.issues, message: "The theme preference does not match the local schema" }))
      })
    })
  })
}

export function saveThemeMode(mode: ThemeMode): Result<void, ThemeStorageError> {
  return storage().andThen((store) => {
    if (store === null) return Result.ok(undefined)
    return Result.try<void, ThemeStorageError>({
      try: () => store.setItem(THEME_STORAGE_KEY, JSON.stringify({ version: 1, mode })),
      catch: (cause) => new ThemeStorageError({ cause, message: "The theme preference could not be saved" }),
    })
  })
}

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  switch (mode) {
    case "dark":
      return "dark"
    case "light":
      return "light"
    case "system":
      return prefersDark ? "dark" : "light"
  }
}

export function nextThemeMode(mode: ThemeMode): ThemeMode {
  switch (mode) {
    case "dark":
      return "light"
    case "light":
      return "system"
    case "system":
      return "dark"
  }
}

export function isThemeMode(value: string): value is ThemeMode {
  return value === "dark" || value === "light" || value === "system"
}

export function prefersDarkTheme(): boolean {
  return globalThis.matchMedia("(prefers-color-scheme: dark)").matches
}

export function applyTheme(root: HTMLElement, theme: ResolvedTheme): void {
  root.setAttribute("data-theme", theme)
  root.classList.toggle("dark", theme === "dark")
  root.style.colorScheme = theme
}
