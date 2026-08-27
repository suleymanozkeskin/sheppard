import { createElement, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react"

import { formatApiError } from "@/api/errors"
import { apiCall } from "@/api/runtime"
import type {
  DeviceCatalogue,
  DeviceModelEntry,
  HerdrWorkspaceView,
  Launcher,
  RolePreset,
  SpawnAgentRequest,
} from "@/api/types"
import type { AppController } from "@/hooks/use-app-controller"
import { AgentAvatar } from "@/components/agent-avatar"

export const NO_ROLE_VALUE = "__no_role__"

export type SpawnMetadataState =
  | { status: "loading"; launchers: Launcher[]; roles: RolePreset[] }
  | { status: "ready"; launchers: Launcher[]; roles: RolePreset[] }
  | { status: "error"; launchers: Launcher[]; roles: RolePreset[]; message: string }

export type CatalogueState =
  | { status: "loading"; catalogues: DeviceCatalogue[] }
  | { status: "ready"; catalogues: DeviceCatalogue[] }
  | { status: "refreshing"; catalogues: DeviceCatalogue[]; launcher: string }
  | { status: "error"; catalogues: DeviceCatalogue[]; launcher?: string; message: string }

export type RoleBriefingState =
  | { status: "none" }
  | { status: "loading"; roleName: string }
  | { status: "empty"; roleName: string }
  | { status: "present"; roleName: string }

export interface SpawnSelectionState {
  effort: string
  goal: string
  handle: string | undefined
  harness: string
  launcher: string
  model: string
  roleBriefing: RoleBriefingState
  roleName: string
  workspaceId: string
}

export type SpawnSelectionAction =
  | { type: "apply-role-runtime"; harness: string; launcher: string }
  | { type: "briefing-loading"; roleName: string }
  | { type: "briefing-result"; roleName: string; present: boolean }
  | { type: "select-effort"; effort: string }
  | { type: "select-harness"; harness: string }
  | { type: "select-launcher"; launcher: string }
  | { type: "select-model"; model: string }
  | { type: "select-role"; roleName: string; harness: string; launcher: string; generatedHandle: string; preserveHandle: boolean }
  | { type: "set-goal"; goal: string }
  | { type: "set-handle"; handle: string }
  | { type: "set-workspace"; workspaceId: string; generatedHandle: string; preserveHandle: boolean }

export function initialRoleValue(roleName: string | undefined): string {
  return roleName === undefined ? "worker" : roleName.length > 0 ? roleName : NO_ROLE_VALUE
}

export function createSpawnSelectionState(roleName: string | undefined, workspaceId: string | undefined): SpawnSelectionState {
  return {
    effort: "",
    goal: "",
    handle: undefined,
    harness: "",
    launcher: "",
    model: "",
    roleBriefing: { status: "none" },
    roleName: initialRoleValue(roleName),
    workspaceId: workspaceId ?? "",
  }
}

export function reduceSpawnSelection(state: SpawnSelectionState, action: SpawnSelectionAction): SpawnSelectionState {
  switch (action.type) {
    case "apply-role-runtime": {
      const harness = state.harness.length === 0 ? action.harness : state.harness
      const launcher = state.launcher.length === 0 ? action.launcher : state.launcher
      return harness === state.harness && launcher === state.launcher ? state : { ...state, harness, launcher }
    }
    case "briefing-loading":
      return action.roleName === state.roleName ? { ...state, roleBriefing: { roleName: action.roleName, status: "loading" } } : state
    case "briefing-result":
      return action.roleName === state.roleName
        ? { ...state, roleBriefing: { roleName: action.roleName, status: action.present ? "present" : "empty" } }
        : state
    case "select-effort":
      return { ...state, effort: action.effort }
    case "select-harness":
      return { ...state, effort: "", harness: action.harness, launcher: "", model: "" }
    case "select-launcher":
      return { ...state, effort: "", launcher: action.launcher, model: "" }
    case "select-model":
      return { ...state, effort: "", model: action.model }
    case "select-role":
      return {
        ...state,
        effort: "",
        goal: "",
        handle: action.preserveHandle ? state.handle : action.generatedHandle,
        harness: action.harness,
        launcher: action.launcher,
        model: "",
        roleBriefing: { status: "none" },
        roleName: action.roleName,
      }
    case "set-goal":
      return { ...state, goal: action.goal }
    case "set-handle":
      return { ...state, handle: action.handle }
    case "set-workspace":
      return { ...state, handle: action.preserveHandle ? state.handle : action.generatedHandle, workspaceId: action.workspaceId }
  }
}

export function deviceModelLabel(model: DeviceModelEntry): string {
  const label = model.label.trim()
  return label.length > 0 ? label : model.name
}

export function catalogueReasonText(catalogue: DeviceCatalogue | undefined, fallback: string | undefined): string {
  if (fallback !== undefined) return fallback
  if (catalogue === undefined) return "The device model catalogue is unavailable."
  if (catalogue.error !== null && catalogue.error.trim().length > 0) return catalogue.error
  switch (catalogue.status) {
    case "unsupported": return "This launcher does not support device model discovery."
    case "default-only": return "This launcher provides its default model only."
    case "stale": return "The device model catalogue is stale. Retry to check the current device models."
    case "unavailable": return "The device model catalogue is unavailable until it is refreshed."
    case "ready": return "The launcher reported no device models."
  }
}

export interface ResolvedSpawnDefaults {
  effort: string
  model: DeviceModelEntry | undefined
  modelName: string
}

function catalogueIsCurrent(catalogue: DeviceCatalogue | undefined): boolean {
  return catalogue?.status === "ready" || catalogue?.status === "default-only"
}

function findCatalogueModel(catalogue: DeviceCatalogue | undefined, value: string | null | undefined): DeviceModelEntry | undefined {
  if (value === null || value === undefined || value.length === 0) return undefined
  return catalogue?.models.find((candidate) => candidate.name === value)
}

export function resolveSpawnDefaults({
  catalogue,
  effort,
  launcherSelected,
  model,
  role,
}: {
  catalogue: DeviceCatalogue | undefined
  effort: string
  launcherSelected: boolean
  model: string
  role: RolePreset | undefined
}): ResolvedSpawnDefaults {
  const current = catalogueIsCurrent(catalogue)
  const catalogueDefault = current ? catalogue?.models.find((candidate) => candidate.default) : undefined
  const roleTargetsLauncher = role?.launcher?.trim() === catalogue?.launcher
  const roleDefault = current && roleTargetsLauncher ? findCatalogueModel(catalogue, role?.model) : undefined
  const selectedModel = findCatalogueModel(catalogue, model)
    ?? (launcherSelected ? roleDefault ?? catalogueDefault : undefined)
  const modelName = selectedModel?.name ?? ""
  const roleModelSelected = roleDefault !== undefined && selectedModel?.name === roleDefault.name
  const roleEffort = roleModelSelected && role?.effort !== null && role?.effort !== undefined
    ? selectedModel?.efforts.find((candidate) => candidate.name === role.effort)
    : undefined
  const selectedEffort = selectedModel?.efforts.some((candidate) => candidate.name === effort)
    ? effort
    : roleEffort?.name ?? selectedModel?.efforts.find((candidate) => candidate.default)?.name ?? ""
  return { effort: selectedEffort, model: selectedModel, modelName }
}

export type SpawnRequestBuildResult =
  | { ok: true; request: SpawnAgentRequest }
  | { ok: false; message: string }

export function buildSpawnAgentRequest({
  currentCatalogue,
  effort,
  resolvedHandle,
  modelName,
  roleBriefingPresent,
  selectedCatalogue,
  selectedModel,
  selection,
  targetWorkspaceId,
}: {
  currentCatalogue: boolean
  effort: string
  resolvedHandle?: string
  modelName: string
  roleBriefingPresent: boolean
  selectedCatalogue: DeviceCatalogue | undefined
  selectedModel: DeviceModelEntry | undefined
  selection: SpawnSelectionState
  targetWorkspaceId: string
}): SpawnRequestBuildResult {
  const handle = (resolvedHandle ?? selection.handle)?.trim() ?? ""
  const launcher = selection.launcher.trim()
  if (targetWorkspaceId.length === 0 || selection.harness.length === 0 || launcher.length === 0 || handle.length === 0) {
    return { message: "Choose a workspace, harness, launcher, and handle.", ok: false }
  }
  if (selectedCatalogue === undefined || !currentCatalogue || selectedCatalogue.models.length === 0 || selectedModel === undefined) {
    return { message: "Choose a current device model before spawning the agent.", ok: false }
  }
  if (selectedModel.efforts.length > 0 && effort.trim().length === 0) {
    return { message: "Choose an effort for the selected model.", ok: false }
  }
  const request: SpawnAgentRequest = { handle, launcher, workspaceId: targetWorkspaceId }
  if (selection.roleName !== NO_ROLE_VALUE && selection.roleName.length > 0) request.role = selection.roleName
  if (modelName.trim().length > 0) request.model = modelName.trim()
  if (selectedModel.efforts.length > 0 && effort.trim().length > 0) request.effort = effort.trim()
  if (roleBriefingPresent && selection.goal.trim().length > 0) request.goal = selection.goal.trim()
  return { ok: true, request }
}

export function initialHandle(workspace: { id: string; label: string | null } | undefined, roleName: string): string {
  if (roleName.length === 0 || roleName === NO_ROLE_VALUE || workspace === undefined) return ""
  const source = workspace.label ?? workspace.id
  const slug = source.toLocaleLowerCase().replaceAll(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 23) || "workspace"
  return `${roleName}-${slug}`
}

function roleRuntime(role: RolePreset | undefined, launchers: readonly Launcher[]) {
  const declaredHarness = role?.agentKind?.trim() ?? ""
  const declaredLauncher = role?.launcher?.trim() ?? ""
  const launcher = declaredLauncher.length === 0
    ? undefined
    : launchers.find((candidate) => candidate.name === declaredLauncher && (declaredHarness.length === 0 || candidate.agentKind === declaredHarness))
  return { harness: declaredHarness || launcher?.agentKind || "", launcher: launcher?.name ?? "" }
}

interface UseSpawnAgentStateProps {
  controller: AppController
  initialWorkspaceId?: string
  mode?: "add-reporter"
  roleName?: string
}

export interface SpawnAgentStateModel {
  catalogueNeedsRetry: boolean
  catalogueState: CatalogueState
  catalogueStatusText: string | undefined
  effort: string
  effortOptions: Array<{ label: string; sublabel?: string; value: string }>
  effortUnavailable: boolean
  harnessOptions: Array<{ label: string; sublabel?: string; value: string }>
  launcherOptions: Array<{ label: string; sublabel?: string; value: string }>
  matchingLaunchers: Launcher[]
  metadataState: SpawnMetadataState
  modelOptions: Array<{ label: string; sublabel?: string; value: string }>
  modelPickerError: string | null
  modelPickerLoading: boolean
  resolvedHandle: string
  roleBriefing: RoleBriefingState
  selectedCatalogue: DeviceCatalogue | undefined
  selectedLauncher: Launcher | undefined
  selectedModel: DeviceModelEntry | undefined
  selectedModelName: string
  selectedRole: RolePreset | undefined
  selectedWorkspace: HerdrWorkspaceView | undefined
  selectedWorkspaceId: string
  selection: SpawnSelectionState
  roles: RolePreset[]
  launchers: Launcher[]
  selectEffort: (value: string | null) => void
  selectHarness: (value: string | null) => void
  selectLauncher: (value: string | null) => void
  selectModel: (value: string | null) => void
  selectRole: (value: string | null) => void
  selectWorkspace: (value: string | null) => void
  setGoal: (value: string) => void
  setHandle: (value: string) => void
  catalogueRetry: () => void
  buildRequest: () => SpawnRequestBuildResult
}

export function useSpawnAgentState({ controller, initialWorkspaceId, mode, roleName }: UseSpawnAgentStateProps): SpawnAgentStateModel {
  const workspaces = controller.workspaceData.workspaces
  const [metadataState, setMetadataState] = useState<SpawnMetadataState>({ launchers: [], roles: [], status: "loading" })
  const [catalogueState, setCatalogueState] = useState<CatalogueState>({ catalogues: [], status: "loading" })
  const [selection, dispatch] = useReducer(reduceSpawnSelection, { roleName, workspaceId: initialWorkspaceId }, ({ roleName: initialName, workspaceId }) => createSpawnSelectionState(initialName, workspaceId))
  const catalogueAttempts = useRef(new Set<string>())
  const catalogueInFlight = useRef(new Set<string>())
  const mounted = useRef(true)

  const selectedWorkspaceId = selection.workspaceId.length > 0 ? selection.workspaceId : workspaces[0]?.id ?? ""
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId)
  const roles = metadataState.roles
  const launchers = metadataState.launchers
  const selectedRole = selection.roleName === NO_ROLE_VALUE ? undefined : roles.find((candidate) => candidate.name === selection.roleName)
  const selectedCatalogue = catalogueState.catalogues.find((catalogue) => catalogue.launcher === selection.launcher)
  const selectedLauncher = launchers.find((candidate) => candidate.name === selection.launcher && candidate.agentKind === selection.harness)
  const defaults = resolveSpawnDefaults({
    catalogue: selectedCatalogue,
    effort: selection.effort,
    launcherSelected: selectedLauncher !== undefined,
    model: selection.model,
    role: selectedRole,
  })
  const generatedHandle = initialHandle(selectedWorkspace, selection.roleName)
  const resolvedHandle = selection.handle ?? generatedHandle

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    let alive = true
    setMetadataState((current) => ({ launchers: current.launchers, roles: current.roles, status: "loading" }))
    setCatalogueState((current) => ({ catalogues: current.catalogues, status: "loading" }))
    void Promise.all([
      apiCall(controller.api, undefined, (client) => client.listLaunchers()),
      apiCall(controller.api, undefined, (client) => client.listRoles()),
      apiCall(controller.api, undefined, (client) => client.listModelCatalogue()),
    ]).then(([launchersResult, rolesResult, catalogueResult]) => {
      if (!alive) return
      const nextLaunchers = launchersResult.match({ err: () => undefined, ok: ({ launchers: entries }) => entries })
      const nextRoles = rolesResult.match({ err: () => undefined, ok: ({ roles: entries }) => entries })
      if (nextLaunchers === undefined || nextRoles === undefined) {
        const error = [launchersResult, rolesResult].find((result) => result.isErr())
        setMetadataState({
          launchers: nextLaunchers ?? [],
          message: error?.error === undefined ? "Spawn metadata could not be loaded." : formatApiError(error.error),
          roles: nextRoles ?? [],
          status: "error",
        })
      } else {
        setMetadataState({ launchers: nextLaunchers, roles: nextRoles, status: "ready" })
      }
      const nextCatalogues = catalogueResult.match({ err: () => undefined, ok: ({ catalogues: entries }) => entries })
      if (nextCatalogues === undefined) {
        const error = catalogueResult.match({ err: (failure) => failure, ok: () => undefined })
        setCatalogueState({ catalogues: [], message: error === undefined ? "The device model catalogue could not be loaded." : formatApiError(error), status: "error" })
      } else {
        setCatalogueState({ catalogues: nextCatalogues, status: "ready" })
      }
    })
    return () => { alive = false }
  }, [controller.api])

  useEffect(() => {
    if (metadataState.status !== "ready" || selection.roleName === NO_ROLE_VALUE || selection.roleName.length === 0) {
      dispatch({ roleName: selection.roleName, type: "briefing-result", present: false })
      return
    }
    dispatch({ roleName: selection.roleName, type: "briefing-loading" })
    let alive = true
    void apiCall(controller.api, undefined, (client) => client.getRole(selection.roleName)).then((result) => {
      if (!alive) return
      result.match({
        err: () => dispatch({ roleName: selection.roleName, type: "briefing-result", present: false }),
        ok: ({ role }) => dispatch({ roleName: selection.roleName, type: "briefing-result", present: role.briefing.trim().length > 0 }),
      })
    })
    return () => { alive = false }
  }, [controller.api, metadataState.status, selection.roleName])

  useEffect(() => {
    if (metadataState.status !== "ready" || selection.roleName === NO_ROLE_VALUE) return
    const runtime = roleRuntime(roles.find((candidate) => candidate.name === selection.roleName), launchers)
    dispatch({ harness: runtime.harness, launcher: runtime.launcher, type: "apply-role-runtime" })
  }, [launchers, metadataState.status, roles, selection.roleName])

  const refreshCatalogue = useCallback((launcher: string, force: boolean): void => {
    if (launcher.length === 0 || catalogueInFlight.current.has(launcher)) return
    if (!force && catalogueAttempts.current.has(launcher)) return
    catalogueAttempts.current.add(launcher)
    catalogueInFlight.current.add(launcher)
    setCatalogueState((current) => ({ catalogues: current.catalogues, launcher, status: "refreshing" }))
    void apiCall(controller.api, undefined, (client) => client.refreshModelCatalogue({ launcher })).then((result) => {
      catalogueInFlight.current.delete(launcher)
      if (!mounted.current) return
      result.match({
        err: (error) => setCatalogueState((current) => ({ catalogues: current.catalogues, launcher, message: formatApiError(error), status: "error" })),
        ok: ({ catalogues }) => setCatalogueState({ catalogues, status: "ready" }),
      })
    })
  }, [controller.api])

  useEffect(() => {
    const launcher = selection.launcher
    if (launcher.length === 0 || catalogueState.status === "loading") return
    if (catalogueState.status === "refreshing" && catalogueState.launcher === launcher) return
    const current = selectedCatalogue?.status === "ready" || selectedCatalogue?.status === "default-only"
    const unsupported = selectedCatalogue?.status === "unsupported"
    if (current || unsupported || catalogueAttempts.current.has(launcher) || catalogueInFlight.current.has(launcher)) return
    refreshCatalogue(launcher, false)
  }, [catalogueState, refreshCatalogue, selectedCatalogue, selection.launcher])

  const selectRole = useCallback((value: string | null): void => {
    const nextRoleName = value ?? NO_ROLE_VALUE
    const nextRole = nextRoleName === NO_ROLE_VALUE ? undefined : roles.find((role) => role.name === nextRoleName)
    const runtime = roleRuntime(nextRole, launchers)
    const currentGeneratedHandle = initialHandle(selectedWorkspace, selection.roleName)
    const preserveHandle = mode !== "add-reporter" && selection.handle !== undefined && selection.handle.length > 0 && selection.handle !== currentGeneratedHandle
    dispatch({ generatedHandle: initialHandle(selectedWorkspace, nextRoleName), harness: runtime.harness, launcher: runtime.launcher, preserveHandle, roleName: nextRoleName, type: "select-role" })
  }, [launchers, mode, roles, selectedWorkspace, selection.handle, selection.roleName])

  const selectWorkspace = useCallback((value: string | null): void => {
    const nextWorkspaceId = value ?? ""
    const nextWorkspace = workspaces.find((workspace) => workspace.id === nextWorkspaceId)
    const currentGeneratedHandle = initialHandle(selectedWorkspace, selection.roleName)
    const preserveHandle = selection.handle !== undefined && selection.handle.length > 0 && selection.handle !== currentGeneratedHandle
    dispatch({ generatedHandle: initialHandle(nextWorkspace, selection.roleName), preserveHandle, type: "set-workspace", workspaceId: nextWorkspaceId })
  }, [selectedWorkspace, selection.handle, selection.roleName, workspaces])
  const selectHarness = useCallback((value: string | null): void => { dispatch({ harness: value ?? "", type: "select-harness" }) }, [])
  const selectLauncher = useCallback((value: string | null): void => { dispatch({ launcher: value ?? "", type: "select-launcher" }) }, [])
  const selectModel = useCallback((value: string | null): void => { dispatch({ model: value ?? "", type: "select-model" }) }, [])
  const selectEffort = useCallback((value: string | null): void => { dispatch({ effort: value ?? "", type: "select-effort" }) }, [])
  const setHandle = useCallback((value: string): void => { dispatch({ handle: value, type: "set-handle" }) }, [])
  const setGoal = useCallback((value: string): void => { dispatch({ goal: value, type: "set-goal" }) }, [])

  const matchingLaunchers = useMemo(() => selection.harness.length === 0 ? [] : launchers.filter((candidate) => candidate.agentKind === selection.harness), [launchers, selection.harness])
  const harnessOptions = useMemo(() => {
    const roleHarness = selectedRole?.agentKind?.trim() ?? ""
    const counts = new Map<string, number>()
    for (const candidate of launchers) {
      if (roleHarness.length > 0 && candidate.agentKind !== roleHarness) continue
      counts.set(candidate.agentKind, (counts.get(candidate.agentKind) ?? 0) + 1)
    }
    return [...counts.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([name, count]) => ({ label: name, leading: createElement(AgentAvatar, { agentKind: name }), sublabel: `${count} launcher${count === 1 ? "" : "s"}`, value: name }))
  }, [launchers, selectedRole])
  const launcherOptions = useMemo(() => matchingLaunchers.toSorted((left, right) => left.name.localeCompare(right.name)).map((candidate) => ({ label: candidate.name, leading: createElement(AgentAvatar, { agentKind: candidate.agentKind }), sublabel: candidate.agentKind, value: candidate.name })), [matchingLaunchers])
  const modelOptions = useMemo(() => selectedCatalogue?.models.map((candidate) => ({ label: deviceModelLabel(candidate), sublabel: candidate.description ?? undefined, value: candidate.name })) ?? [], [selectedCatalogue])
  const effortOptions = useMemo(() => defaults.model?.efforts.map((candidate) => ({ label: candidate.name, sublabel: candidate.description ?? undefined, value: candidate.name })) ?? [], [defaults.model])
  const catalogueError = catalogueState.status === "error" && (catalogueState.launcher === undefined || catalogueState.launcher === selection.launcher) ? catalogueState.message : undefined
  const catalogueStatus = selectedCatalogue?.status
  const catalogueNeedsRetry = catalogueStatus === "stale" || catalogueStatus === "unavailable" || catalogueState.status === "error" && (catalogueState.launcher === undefined || catalogueState.launcher === selection.launcher) || (selectedCatalogue === undefined && selection.launcher.length > 0 && catalogueState.status !== "loading" && catalogueState.status !== "refreshing")
  const catalogueStatusText = catalogueStatus === "stale"
    ? catalogueReasonText(selectedCatalogue, catalogueError)
    : catalogueStatus === "unavailable"
      ? catalogueReasonText(selectedCatalogue, catalogueError)
      : catalogueStatus === "unsupported"
        ? "This launcher does not support device model selection."
        : selectedCatalogue !== undefined && (catalogueStatus === "ready" || catalogueStatus === "default-only") && selectedCatalogue.models.length === 0
          ? "No device models are available for this launcher."
          : selectedCatalogue === undefined && selection.launcher.length > 0 && catalogueState.status !== "loading" && catalogueState.status !== "refreshing"
            ? catalogueReasonText(undefined, catalogueError)
            : undefined
  const modelPickerLoading = selection.launcher.length > 0 && (catalogueState.status === "loading" || catalogueState.status === "refreshing" && catalogueState.launcher === selection.launcher)
  const modelPickerError = modelPickerLoading || !catalogueNeedsRetry ? null : catalogueStatusText ?? "The device model catalogue is unavailable."

  return {
    buildRequest: () => buildSpawnAgentRequest({ currentCatalogue: catalogueIsCurrent(selectedCatalogue), effort: defaults.effort, modelName: defaults.modelName, resolvedHandle, roleBriefingPresent: selection.roleBriefing.status === "present", selectedCatalogue, selectedModel: defaults.model, selection, targetWorkspaceId: selectedWorkspaceId }),
    catalogueNeedsRetry,
    catalogueRetry: () => refreshCatalogue(selection.launcher, true),
    catalogueState,
    catalogueStatusText,
    effort: defaults.effort,
    effortOptions,
    effortUnavailable: defaults.model !== undefined && defaults.model.efforts.length === 0,
    harnessOptions,
    launcherOptions,
    launchers,
    matchingLaunchers,
    metadataState,
    modelOptions,
    modelPickerError,
    modelPickerLoading,
    resolvedHandle,
    roleBriefing: selection.roleBriefing,
    roles,
    selectedCatalogue,
    selectedLauncher,
    selectedModel: defaults.model,
    selectedModelName: defaults.modelName,
    selectedRole,
    selectedWorkspace,
    selectedWorkspaceId,
    selectEffort,
    selectHarness,
    selectLauncher,
    selectModel,
    selectRole,
    selectWorkspace,
    selection,
    setGoal,
    setHandle,
  }
}
