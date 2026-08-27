import type { DeviceCatalogue, Launcher } from "@/api/types"

export type LaunchersState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; launchers: Launcher[] }

export type CatalogueState =
  | { status: "loading" }
  | { status: "error"; message: string; catalogues: DeviceCatalogue[] }
  | { status: "ready"; catalogues: DeviceCatalogue[] }

export type HarnessState = { harnesses: string[]; status: "loading" | "ready" | "error" }

export type LauncherActionState =
  | { status: "idle" }
  | { status: "working" }
  | { status: "error"; message: string }

export type CatalogueAction =
  | { status: "idle" }
  | { status: "working" }
  | { status: "error"; message: string }
