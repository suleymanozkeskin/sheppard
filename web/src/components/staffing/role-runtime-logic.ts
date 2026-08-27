import type { DeviceCatalogue, DeviceModelEntry, Launcher } from "@/api/types"

export interface RoleRuntimeValues {
  effort: string
  harness: string
  launcher: string
  model: string
}

export type RoleRuntimeMetadataState =
  | { status: "loading"; launchers: Launcher[]; catalogues: DeviceCatalogue[] }
  | { status: "ready"; launchers: Launcher[]; catalogues: DeviceCatalogue[] }
  | { status: "refreshing"; launchers: Launcher[]; catalogues: DeviceCatalogue[]; launcher: string }
  | { status: "error"; launchers: Launcher[]; catalogues: DeviceCatalogue[]; launcher?: string; message: string }

export interface RoleRuntimeStaleFields {
  effort?: string
  harness?: string
  launcher?: string
  model?: string
}

function catalogueFor(metadataState: RoleRuntimeMetadataState, launcher: string): DeviceCatalogue | undefined {
  return metadataState.catalogues.find((catalogue) => catalogue.launcher === launcher)
}

function currentCatalogue(catalogue: DeviceCatalogue | undefined): boolean {
  return catalogue?.status === "ready" || catalogue?.status === "default-only"
}

function modelFor(catalogue: DeviceCatalogue | undefined, value: string): DeviceModelEntry | undefined {
  if (value.length === 0) return undefined
  return catalogue?.models.find((model) => model.name === value)
}

export function roleCatalogueNeedsRefresh(metadataState: RoleRuntimeMetadataState, launcher: string, attempted = false, inFlight = false): boolean {
  if (launcher.length === 0 || attempted || inFlight || metadataState.status === "loading") return false
  if (metadataState.status === "refreshing" && metadataState.launcher === launcher) return false
  const catalogue = catalogueFor(metadataState, launcher)
  return catalogue === undefined || catalogue.status === "stale" || catalogue.status === "unavailable"
}

export function roleRuntimeStaleFields(values: RoleRuntimeValues, metadataState: RoleRuntimeMetadataState): RoleRuntimeStaleFields {
  const harnesses = new Set(metadataState.launchers.map((launcher) => launcher.agentKind))
  const launchers = values.harness.length === 0
    ? []
    : metadataState.launchers.filter((launcher) => launcher.agentKind === values.harness)
  const catalogue = catalogueFor(metadataState, values.launcher)
  const models = currentCatalogue(catalogue) ? catalogue?.models ?? [] : []
  const selectedModel = modelFor(catalogue, values.model)
  const efforts = selectedModel?.efforts ?? []
  const stale: RoleRuntimeStaleFields = {}

  if (values.harness.length > 0 && !harnesses.has(values.harness)) stale.harness = "Saved harness is unavailable. Choose a current harness or Choose at spawn."
  if (values.launcher.length > 0 && !launchers.some((launcher) => launcher.name === values.launcher)) stale.launcher = "Saved launcher is unavailable. Choose a registered launcher or Choose at spawn."
  if (values.model.length > 0 && !models.some((model) => model.name === values.model)) stale.model = "Saved model is unavailable. Choose a current model or use the launcher default."
  if (values.effort.length > 0 && !efforts.some((effort) => effort.name === values.effort)) stale.effort = "Saved reasoning effort is unavailable. Choose a value reported by the selected model or choose at spawn."
  return stale
}

export function isRoleRuntimeValid(values: RoleRuntimeValues, metadataState: RoleRuntimeMetadataState): boolean {
  if (values.harness.length === 0 && values.launcher.length === 0 && values.model.length === 0 && values.effort.length === 0) return true
  if (metadataState.status !== "ready") return false
  const harnesses = new Set(metadataState.launchers.map((launcher) => launcher.agentKind))
  if (values.harness.length === 0) return values.launcher.length === 0 && values.model.length === 0 && values.effort.length === 0
  if (!harnesses.has(values.harness)) return false
  const launchers = metadataState.launchers.filter((launcher) => launcher.agentKind === values.harness)
  if (values.launcher.length > 0 && !launchers.some((launcher) => launcher.name === values.launcher)) return false
  const catalogue = catalogueFor(metadataState, values.launcher)
  const selectedModel = modelFor(catalogue, values.model)
  if (values.model.length > 0 && (catalogue === undefined || !currentCatalogue(catalogue) || selectedModel === undefined)) return false
  if (values.effort.length > 0 && (selectedModel === undefined || !selectedModel.efforts.some((effort) => effort.name === values.effort))) return false
  return true
}
